import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  batchDirOf,
  listBatchIds,
  readManifest,
  recoverAllBatches,
  recoverBatch,
  updateManifestStatus,
  writeManifest,
  type BatchManifest,
} from '../src/batch-manifest'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { recoverResidualBatches } from '../src/cleanup-run'
import { scratchDir } from './support/tmpdir'

/**
 * 崩溃恢复：聚合到一半被杀掉时，内容必须能找回来。
 *
 * ## 崩溃窗口
 *
 * 清理一批条目分三步：
 *
 * ```
 * 1. 写 manifest（列出本批全部 id）
 * 2. 逐条 rename items/<id> → batches/<batchId>/items/<id>
 * 3. 一次性回收整个批次目录
 * ```
 *
 * 若在第 2 步中途进程被杀，已搬走的条目内容在 `batches/` 里，
 * 而索引仍指向 `items/` —— 用户看到条目却恢复不出来。
 *
 * ## 恢复策略：搬回去
 *
 * 崩溃说明环境当时有问题，此时把内容**原样还回 items/**，比猜测
 * "其实我想删掉它" 更安全。这条测试钉住的就是这个语义。
 */
describe('batch manifest', () => {
  /**
   * 造一个安全区并移入一条内容。
   *
   * @returns 状态目录、工作目录与条目 id。
   */
  async function setup(): Promise<{ state: string; work: string; id: string }> {
    const root = scratchDir('dsd-manifest-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    const p = join(work, 'a.txt')
    writeFileSync(p, 'CONTENT')
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const entries = await listSafeZone(state)
    return { state, work, id: entries[0]!.id }
  }

  it('writes and reads back a manifest', async () => {
    const { state, id } = await setup()
    writeManifest(state, {
      schemaVersion: 1,
      batchId: 'b1',
      createdAt: 1000,
      status: 'staging',
      entries: [{ id, originalPath: 'C:\\x\\a.txt', bytes: 7 }],
    })

    const m = readManifest(state, 'b1')
    expect(m).not.toBeNull()
    expect(m?.batchId).toBe('b1')
    expect(m?.status).toBe('staging')
    expect(m?.entries).toHaveLength(1)
    expect(m?.entries[0]?.id).toBe(id)
  })

  it('updates status without losing entries', async () => {
    const { state, id } = await setup()
    writeManifest(state, {
      schemaVersion: 1,
      batchId: 'b2',
      createdAt: 1,
      status: 'staging',
      entries: [{ id, originalPath: 'p', bytes: 1 }],
    })
    const updated = updateManifestStatus(state, 'b2', 'staged')
    expect(updated?.status).toBe('staged')
    expect(updated?.entries).toHaveLength(1)
  })

  it('returns null for a missing or corrupt manifest', async () => {
    const { state } = await setup()
    expect(readManifest(state, 'nope')).toBeNull()

    mkdirSync(batchDirOf(state, 'bad'), { recursive: true })
    writeFileSync(join(batchDirOf(state, 'bad'), 'manifest.json'), '{not json')
    expect(readManifest(state, 'bad')).toBeNull()
  })

  it('lists batch ids', async () => {
    const { state, id } = await setup()
    expect(listBatchIds(state)).toHaveLength(0)
    for (const b of ['x1', 'x2']) {
      writeManifest(state, {
        schemaVersion: 1,
        batchId: b,
        createdAt: 1,
        status: 'staging',
        entries: [{ id, originalPath: 'p', bytes: 1 }],
      })
    }
    expect(listBatchIds(state).sort()).toEqual(['x1', 'x2'])
  })
})

describe('crash recovery: content moved to batches/ is put back', () => {
  /**
   * 造一个"崩在聚合中途"的状态：内容已搬到 batches/，索引仍指向 items/。
   *
   * @param moves 搬走几条。
   * @returns 状态与相关 id。
   */
  async function simulateCrash(moves: number): Promise<{ state: string; ids: string[]; batchId: string }> {
    const root = scratchDir('dsd-crash-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    const ids: string[] = []
    for (let i = 0; i < moves; i += 1) {
      const p = join(work, `f${i}.txt`)
      writeFileSync(p, `DATA-${i}`)
      await moveToSafeZone(state, p, { retentionDays: 1 })
    }
    for (const e of await listSafeZone(state)) ids.push(e.id)

    const batchId = 'crashed-batch'
    // 清单已写（这是恢复的依据）。
    writeManifest(state, {
      schemaVersion: 1,
      batchId,
      createdAt: Date.now(),
      status: 'staging',
      entries: ids.map((id, i) => ({ id, originalPath: `C:\\x\\f${i}.txt`, bytes: 1 })),
    })

    // 模拟"只搬走了前 N 条就崩了"。
    const staged = join(batchDirOf(state, batchId), 'items')
    mkdirSync(staged, { recursive: true })
    const { renameSync } = await import('node:fs')
    for (let i = 0; i < moves; i += 1) {
      const from = join(state, 'items', ids[i] as string)
      const to = join(staged, ids[i] as string)
      renameSync(from, to)
    }

    return { state, ids, batchId }
  }

  it('moves every staged entry back to items/', async () => {
    const { state, ids, batchId } = await simulateCrash(3)

    // 崩溃后：items/ 为空，内容在 batches/。
    expect(readdirSync(join(state, 'items'))).toHaveLength(0)

    const result = recoverBatch(state, batchId)

    expect(result.entries).toHaveLength(3)
    expect(result.entries.every((e) => e.outcome === 'moved-back'), '全部应搬回').toBe(true)
    // 内容回到 items/，且能读出来。
    expect(readdirSync(join(state, 'items')).sort()).toEqual([...ids].sort())
    // 批次目录已清掉（内容都归位了）。
    expect(result.batchRemoved).toBe(true)
  })

  it('restores the file content byte-for-byte', async () => {
    const { state, batchId, ids } = await simulateCrash(2)
    recoverBatch(state, batchId)

    const { readFileSync } = await import('node:fs')
    // 每一条的内容都应完好。
    for (let i = 0; i < ids.length; i += 1) {
      const dir = join(state, 'items', ids[i] as string)
      const files = readdirSync(dir)
      expect(files.length, `${ids[i]} 应有内容`).toBeGreaterThan(0)
      expect(readFileSync(join(dir, files[0] as string), 'utf8'), '内容不该被改动').toBe(`DATA-${i}`)
    }
  })

  it('leaves entries that were never moved alone', async () => {
    // 只搬 2 条，但清单里有 4 条：剩下 2 条仍在 items/。
    const root = scratchDir('dsd-crash-partial-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const p = join(work, `f${i}.txt`)
      writeFileSync(p, `DATA-${i}`)
      await moveToSafeZone(state, p, { retentionDays: 1 })
    }
    for (const e of await listSafeZone(state)) ids.push(e.id)

    const batchId = 'partial'
    writeManifest(state, {
      schemaVersion: 1,
      batchId,
      createdAt: 1,
      status: 'staging',
      entries: ids.map((id) => ({ id, originalPath: 'p', bytes: 1 })),
    })

    const staged = join(batchDirOf(state, batchId), 'items')
    mkdirSync(staged, { recursive: true })
    const { renameSync } = await import('node:fs')
    for (let i = 0; i < 2; i += 1) {
      renameSync(join(state, 'items', ids[i] as string), join(staged, ids[i] as string))
    }

    const result = recoverBatch(state, batchId)
    const byOutcome = result.entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.outcome] = (acc[e.outcome] ?? 0) + 1
      return acc
    }, {})

    expect(byOutcome['moved-back'], '2 条应搬回').toBe(2)
    expect(byOutcome['left-in-place'], '2 条本来就没动').toBe(2)
    // 最终 4 条全在 items/。
    expect(readdirSync(join(state, 'items'))).toHaveLength(4)
  })

  it('reports an entry whose content is gone in both places', async () => {
    const { state, batchId, ids } = await simulateCrash(1)
    // 额外把内容彻底删掉，模拟"两处都没有"。
    const { rmSync } = await import('node:fs')
    rmSync(join(batchDirOf(state, batchId), 'items', ids[0] as string), { recursive: true, force: true })

    const result = recoverBatch(state, batchId)
    expect(result.entries[0]?.outcome, '两处都无应报 missing').toBe('missing')
  })

  it('reports recovery-failed (not missing) when the move back throws', async () => {
    /*
     * P1-02：搬不回去时绝不能报 `missing`。
     *
     * `recoverResidualBatches` 见到 `missing` 就把 id 从索引里剔掉。若把
     * "搬不动"也标成 missing，结果就是：内容还在 `batches/` 里、索引却被删了、
     * `safe_zone_restore` 报 unknown id —— 用户无从找回。
     *
     * ## 怎么构造真正搬不回去的情形
     *
     * 试过两种都不行：
     *   - 目标位置放一个**文件**：Windows 上目录 rename 会成功覆盖它（实测）；
     *   - 目标位置放一个**非空目录**：`isDirectory` 为真，代码判定
     *     `left-in-place`（内容确实"在原位"，只是被用户的新目录占着）——
     *     那是正确的语义，不是失败。
     *
     * 真正触发 `renameSync` 抛错的是**父目录不可写**：`items/` 被设成只读时
     * 无法在其中创建或替换条目。这里用一个**文件占住 `items/` 本身**来模拟 ——
     * `mkdirSync(items, {recursive:true})` 会失败（路径是文件），
     * 于是恢复走 catch 分支。
     */
    const { state, batchId } = await simulateCrash(1)

    const itemsRoot = join(state, 'items')
    const { rmSync, writeFileSync: write } = await import('node:fs')
    rmSync(itemsRoot, { recursive: true, force: true })
    // `items/` 变成一个文件：之后任何想在里面放东西的操作都会失败。
    write(itemsRoot, 'blocking the restore')

    const result = recoverBatch(state, batchId)
    expect(
      result.entries[0]?.outcome,
      '搬不回去时必须报 recovery-failed，而不是 missing（那会导致索引被清）',
    ).toBe('recovery-failed')
  })

  it('keeps the index entry when recovery fails', async () => {
    /*
     * P1-02 的后果断言：recovery-failed 的条目**必须留在索引里**。
     *
     * 这条比上面那条更贴近用户感受 —— 它直接检查
     * `recoverResidualBatches` 有没有错误地清掉索引。
     */
    const root = scratchDir('dsd-recovery-failed-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    const p = join(work, 'a.txt')
    writeFileSync(p, 'CONTENT')
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    const batchId = 'stuck'
    writeManifest(state, {
      schemaVersion: 1,
      batchId,
      createdAt: 1,
      status: 'staging',
      entries: [{ id, originalPath: 'p', bytes: 1 }],
    })
    const staged = join(batchDirOf(state, batchId), 'items')
    mkdirSync(staged, { recursive: true })
    const { renameSync } = await import('node:fs')
    renameSync(join(state, 'items', id), join(staged, id))

    // 在 items/<id> 放一个文件，阻止目录搬回。
    writeFileSync(join(state, 'items', id), 'BLOCKER')

    await recoverResidualBatches(state)

    // 索引里必须还有它 —— 否则用户会看到条目消失，而内容其实还在 batches/。
    const entries = await listSafeZone(state)
    expect(entries.map((e) => e.id), '恢复失败时不能删索引').toContain(id)
  })

  it('does not delete a batch directory that still holds content', async () => {
    /*
     * 保守性：如果 batches/ 里还有内容（比如清单不完整、有条目不在清单里），
     * 绝不能因为"清单里的都处理完了"就递归删掉整个目录 ——
     * 那可能是用户数据。
     */
    const { state, batchId, ids } = await simulateCrash(1)
    // 在 staged 里放一个清单之外的文件。
    writeFileSync(join(batchDirOf(state, batchId), 'items', 'stray.txt'), 'STRAY')

    const result = recoverBatch(state, batchId)
    expect(result.batchRemoved, '有残留内容时不该删批次目录').toBe(false)
    expect(existsSync(join(batchDirOf(state, batchId), 'items', 'stray.txt')), '残留文件应保留').toBe(true)
    void ids
  })

  it('recovers all batches at once', async () => {
    const { state } = await simulateCrash(2)
    const results = recoverAllBatches(state)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(listBatchIds(state), '恢复后不该再有残留批次').toHaveLength(0)
  })
})

describe('recoverResidualBatches (worker entry)', () => {
  it('is a no-op on a clean safe zone', async () => {
    const root = scratchDir('dsd-clean-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    const p = join(work, 'a.txt')
    writeFileSync(p, 'x')
    await moveToSafeZone(state, p, { retentionDays: 1 })

    const n = await recoverResidualBatches(state)
    expect(n, '干净安全区应返回 0').toBe(0)
    expect(await listSafeZone(state)).toHaveLength(1)
  })

  it('puts staged content back and keeps the index entry', async () => {
    const root = scratchDir('dsd-residual-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    const p = join(work, 'a.txt')
    writeFileSync(p, 'x')
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    const batchId = 'residual'
    writeManifest(state, {
      schemaVersion: 1,
      batchId,
      createdAt: 1,
      status: 'staging',
      entries: [{ id, originalPath: 'p', bytes: 1 }],
    })
    const staged = join(batchDirOf(state, batchId), 'items')
    mkdirSync(staged, { recursive: true })
    const { renameSync } = await import('node:fs')
    renameSync(join(state, 'items', id), join(staged, id))

    const n = await recoverResidualBatches(state)
    expect(n).toBe(1)
    // 内容搬回后，条目仍在索引里且可恢复。
    expect(await listSafeZone(state), '条目应仍在索引里').toHaveLength(1)
    expect(readdirSync(join(state, 'items', id)).length, '内容应已归位').toBeGreaterThan(0)
  })

  it('runs the recovery scan from inside the worker entry point', async () => {
    /*
     * 这条防的是「恢复函数写好了但没被调用」。
     *
     * 前面几条直接调 `recoverResidualBatches`，所以即使把
     * `pruneNowForWorker` 里那行 `await recoverResidualBatches(stateDir)` 删掉，
     * 它们照样全绿 —— 变异检验证实了这一点。
     *
     * 这里改成经过真正的入口，钉住"worker 每次启动都会先恢复"。
     */
    const root = scratchDir('dsd-residual-entry-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    // 造一条**已过期**的条目（好让 worker 有事可做，走到恢复之后的流程）。
    const p = join(work, 'a.txt')
    writeFileSync(p, 'x')
    await moveToSafeZone(state, p, { retentionDays: 1, now: Date.now() - 10 * 86400000 })
    const id = (await listSafeZone(state))[0]!.id

    // 把它伪装成"上一轮搬到一半"的残留。
    const batchId = 'leftover'
    writeManifest(state, {
      schemaVersion: 1,
      batchId,
      createdAt: 1,
      status: 'staging',
      entries: [{ id, originalPath: 'p', bytes: 1 }],
    })
    const staged = join(batchDirOf(state, batchId), 'items')
    mkdirSync(staged, { recursive: true })
    const { renameSync } = await import('node:fs')
    renameSync(join(state, 'items', id), join(staged, id))

    // 经过 worker 入口跑一轮（用一个什么都不做的回收替身）。
    const { pruneNowForWorker } = await import('../src/cleanup-run')
    await pruneNowForWorker(state, 100, () => ({ ok: true }))

    /*
     * 恢复扫描必须已经跑过：残留批次被清掉。
     * 若 worker 里那行被删，`batches/` 会一直留着。
     */
    expect(listBatchIds(state), 'worker 入口必须先恢复残留批次').toHaveLength(0)
  })

  it('persists a manifest while recycling, because the recycler needs it', async () => {
    /*
     * 这条防的是「生产代码忘了写 manifest」。
     *
     * 前面的恢复测试是**手工写 manifest** 造状态的，所以即使
     * `recycleBatch` 里不写清单，它们照样全绿 —— 变异检验证实了这一点。
     *
     * 这里让 recycler 在**被调用的那一刻**回头检查清单是否存在。
     * 清单必须在第一次 rename 之前就落盘，所以此刻必然已存在。
     */
    const root = scratchDir('dsd-manifest-live-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })

    for (let i = 0; i < 3; i += 1) {
      const p = join(work, `e${i}.txt`)
      writeFileSync(p, 'x')
      await moveToSafeZone(state, p, { retentionDays: 1, now: Date.now() - 10 * 86400000 })
    }

    /*
     * 用数组收集，避开 TS 把闭包赋值的变量收窄成 `never` 的问题。
     */
    const seen: BatchManifest[] = []
    const { pruneNowForWorker } = await import('../src/cleanup-run')
    await pruneNowForWorker(state, 100, (batchPath: string) => {
      /*
       * recycler 拿到的路径是 `batches/<id>/items`；清单在它的上一级。
       * 此刻清单必须存在 —— 否则崩溃后无从恢复。
       */
      const bDir = join(batchPath, '..')
      const batchId = bDir.split(/[\\/]/).pop() ?? ''
      const m = readManifest(state, batchId)
      if (m !== null) seen.push(m)
      return { ok: true }
    })

    expect(seen.length, 'recycler 被调用时清单必须已落盘').toBeGreaterThan(0)
    expect(seen[0]?.entries.length, '清单应列出本批全部条目').toBe(3)
  })
})
