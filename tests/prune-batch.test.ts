import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readAudit } from '../src/audit'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 批量回收：把一批条目聚合成一个目录，再一次送进系统回收站。
 *
 * ## 为什么现在的 fake recycler 必须"真的移动"
 *
 * 2026-10-30 复审 P0-02：第一版测试里的 fake 只 `return { ok: true }`，
 * 而生产代码在收到 `ok` 后无条件 `rmSync(recursive)` 删批次目录 ——
 * 于是测试把"内容被永久删掉"当成了"回收成功"，永远不会变红。
 *
 * 修复后回收路径多了一道自检：**`ok` 之后还要确认批次目录里确实没有内容了**。
 * 所以 fake 必须模拟真实回收站的行为 —— 把内容移走，而不是空返回。
 *
 * 这组测试因此用一个 `fakeBin` 目录：recycler 把批次内容 rename 进去，
 * 再返回成功。这样"是否真的回收"和"是否误删"都能被断言。
 */
describe('batch recycle (worker execution body)', () => {
  /**
   * 造 N 条已过期条目。
   *
   * @param stateDir 安全区。
   * @param work 工作目录。
   * @param n 条数。
   */
  async function seedExpired(stateDir: string, work: string, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const p = join(work, `f${i}.tmp`)
      writeFileSync(p, 'x')
      // now 设到 10 天前 → retention 1 天 → 立刻过期
      await moveToSafeZone(stateDir, p, { retentionDays: 1, now: Date.now() - 10 * 86400000 })
    }
  }

  /**
   * 跑一轮清理，注入一个**真的会移动内容**的回收站替身。
   *
   * @param stateDir 安全区。
   * @param fakeBin 假回收站目录（内容会被 rename 进去）。
   * @param limit 上限。
   * @returns worker 结果与回收调用次数。
   */
  async function runCleanup(
    stateDir: string,
    fakeBin: string,
    limit = 10_000,
  ): Promise<{ result: { recycled: number; skipped: number }; calls: number }> {
    mkdirSync(fakeBin, { recursive: true })
    let calls = 0
    let seq = 0
    const { pruneNowForWorker } = await import('../src/cleanup-run')
    const result = await pruneNowForWorker(stateDir, limit, (batchPath: string) => {
      calls += 1
      seq += 1
      /*
       * 真的把批次内容移走 —— 这才是系统回收站的行为。
       *
       * 空返回 `{ok:true}` 会让修复后的自检判定"回收没有真正发生"，
       * 那是刻意的（见文件头）。所以替身必须移动。
       */
      renameSync(batchPath, join(fakeBin, `batch-${seq}-${Date.now()}`))
      return { ok: true }
    })
    return { result, calls }
  }

  /**
   * 数一个目录树里有多少文件。
   *
   * @param dir 目录。
   * @returns 文件数。
   */
  function countFiles(dir: string): number {
    let n = 0
    const walk = (d: string): void => {
      let entries
      try {
        entries = readdirSync(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isDirectory()) walk(join(d, e.name))
        else n += 1
      }
    }
    walk(dir)
    return n
  }

  it('recycles every expired entry and leaves the index empty', async () => {
    const root = scratchDir('dsd-pb-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 50)
    expect(await listSafeZone(state)).toHaveLength(50)

    const fakeBin = join(root, 'fake-bin')
    const { result, calls } = await runCleanup(state, fakeBin)

    expect(result.recycled, '50 条都应回收').toBe(50)
    expect(result.skipped).toBe(0)
    expect(await listSafeZone(state), '索引应清空').toHaveLength(0)

    /*
     * 关键：**一次**回收调用处理整批，而不是 50 次。
     * 这是 47 倍提速的来源。
     */
    expect(calls, '50 条应聚合成一次回收调用').toBe(1)

    // 50 份内容真的进了"回收站"，不是被删掉。
    expect(countFiles(fakeBin), '50 个文件应真的在假回收站里').toBe(50)
  })

  it('keeps entries whose recycle FAILS', async () => {
    /*
     * 最关键的不变量：回收站不可用时，条目必须留在安全区。
     * 批量改造不能把这条丢掉 —— 那是"因为回收站坏了就永久删除"。
     */
    const root = scratchDir('dsd-pb-fail-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 5)

    const { pruneNowForWorker } = await import('../src/cleanup-run')
    const result = await pruneNowForWorker(state, 100, () => ({ ok: false, reason: 'recycler down' }))

    expect(result.recycled).toBe(0)
    expect(result.skipped, '5 条都该记为跳过').toBe(5)
    expect(await listSafeZone(state), '失败的全部保留在索引里').toHaveLength(5)
  })

  it('restores content to items/ when the batch recycle fails', async () => {
    /*
     * 聚合成功但回收失败时，内容必须**搬回 items/**，
     * 否则会变成"索引里有、items/ 里没有"的不一致状态 ——
     * 用户看到条目却恢复不出来。
     */
    const root = scratchDir('dsd-pb-rollback-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 4)

    const { pruneNowForWorker } = await import('../src/cleanup-run')
    await pruneNowForWorker(state, 100, () => ({ ok: false, reason: 'down' }))

    const entries = await listSafeZone(state)
    expect(entries).toHaveLength(4)

    // 每一条的内容都必须真的在 items/<id>/ 下，能被恢复。
    for (const e of entries) {
      const dir = join(state, 'items', e.id)
      expect(existsSync(dir), `${e.id} 的目录应已搬回`).toBe(true)
      expect(readdirSync(dir).length, `${e.id} 应有内容`).toBeGreaterThan(0)
    }
  })

  it('handles a mix of batches by respecting the limit', async () => {
    // 上限决定本轮处理多少：剩下的留到下一轮，不做无界清理。
    const root = scratchDir('dsd-pb-limit-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 10)

    const fakeBin = join(root, 'fake-bin')
    const { result } = await runCleanup(state, fakeBin, 4)

    expect(result.recycled, '本轮只应处理 4 条').toBe(4)
    expect(await listSafeZone(state), '剩 6 条留待下一轮').toHaveLength(6)
  })

  it('writes audit records for a batch', async () => {
    /*
     * 审计仍要能追 —— 那是"记录"，不是批处理。
     * 批量只影响磁盘操作的组织方式，不影响可追溯性。
     */
    const root = scratchDir('dsd-pb-audit-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 6)

    const fakeBin = join(root, 'fake-bin')
    await runCleanup(state, fakeBin)

    /*
     * Worker 现在**写**逐条审计（2026-10-30 复审 SD-F1）。
     *
     * 这里原来写的是 `expect(records.length).toBeGreaterThanOrEqual(0)` ——
     * 一个恒真断言。它在整整一个版本里掩盖了"worker 完全不写审计"这个缺口，
     * 因为无论记录有没有、有几条，它都通过。
     *
     * 现在断言确切数量。
     */
    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    expect(records, '6 条应各有一条审计记录').toHaveLength(6)
    expect(await listSafeZone(state)).toHaveLength(0)
  })

  it('is far faster than one recycle call per entry', async () => {
    /*
     * 性能回归：若有人把批量改回逐条，调用次数会变成 N。
     * 直接断言调用次数，不受机器快慢影响 —— 比计时更可靠。
     */
    const root = scratchDir('dsd-pb-calls-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 100)

    const fakeBin = join(root, 'fake-bin')
    const { calls } = await runCleanup(state, fakeBin)

    expect(calls, '100 条应只调一次回收站，而不是 100 次').toBe(1)
  })
})
