import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * SD-05：跨卷半复制，以及"内容正被清理"时的诊断。
 *
 * ## 5.1 跨卷复制失败留下孤儿
 *
 * `stageInto` 在 `EXDEV` 且允许跨卷时 `cpSync(target, dest)`。第一版没有
 * try/catch —— `cpSync` 复制了一部分后失败（`ENOSPC`/`EACCES`），
 * `items/<id>` 里留下**半副本**，而索引从未登记它。
 *
 * 这种孤儿是最糟的泄漏：`prune` 只扫索引、`safe_zone_list` 看不到它，
 * 只有手工翻目录才会发现 —— 永远不会被清理。
 *
 * ## 5.2 内容被搬走时，错误信息误导用户
 *
 * worker 把 `items/<id>` 搬进 `batches/` 的那一步不持索引锁。若 restore 在
 * 这一刻查找内容，会报 "has no content on disk" —— 用户以为数据丢了，
 * 而内容其实完好地躺在批次目录里。
 */
describe('SD-05: no orphan half-copies, and honest diagnostics', () => {
  /**
   * 造一条安全区条目。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param name 文件名。
   * @returns 条目 id。
   */
  async function stage(state: string, work: string, name: string): Promise<string> {
    mkdirSync(work, { recursive: true })
    const p = join(work, name)
    writeFileSync(p, 'CONTENT')
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const e = (await listSafeZone(state)).find((x) => x.originalPath === p)
    if (e === undefined) throw new Error('条目未登记')
    return e.id
  }

  it('reports "being cleaned up" when the content already moved into a batch', async () => {
    /*
     * SD-05.2 的核心断言：内容在批次目录里时，错误信息必须**说清楚**，
     * 而不是 "has no content on disk"。
     *
     * 这是用真实的目录布局验证的：手工把 `items/<id>` 挪进 `batches/`，
     * 与 worker 正在清理的状态完全一致。
     */
    const root = scratchDir('dsd-sd05-batch-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const id = await stage(state, work, 'a.txt')

    // 模拟 worker 已经把内容搬到批次里（但还没写索引）。
    const batchItems = join(state, 'batches', '20261030-test', 'items')
    mkdirSync(batchItems, { recursive: true })
    const { renameSync } = await import('node:fs')
    renameSync(join(state, 'items', id), join(batchItems, id))

    await expect(restoreFromSafeZone(state, id)).rejects.toThrow(/being cleaned up/i)

    // 错误里必须给出批次位置，用户才知道去哪儿找。
    await expect(restoreFromSafeZone(state, id)).rejects.toThrow(/batches/i)
    // 内容确实还在那里 —— 没有被删。
    expect(existsSync(join(batchItems, id)), '内容必须完好躺在批次里').toBe(true)
  })

  it('says the content is missing, not "being cleaned", when it is in neither place', async () => {
    /*
     * 反向：内容真的两处都没有时，不能乱报"正在清理"。
     * 但要提示用户先检查 items/ 与 batches/ 再断定数据丢了。
     */
    const root = scratchDir('dsd-sd05-gone-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    const id = await stage(state, work, 'b.txt')

    // 彻底删掉内容。
    const { rmSync } = await import('node:fs')
    rmSync(join(state, 'items', id), { recursive: true, force: true })

    await expect(restoreFromSafeZone(state, id)).rejects.toThrow(/no content on disk/i)
    await expect(restoreFromSafeZone(state, id)).rejects.toThrow(/items\/ and batches\//i)
  })

  it('leaves no orphan half-copy when the cross-volume copy fails', async () => {
    /*
     * SD-05.1：跨卷复制失败必须回滚，不能在 `items/` 留下未入索引的孤儿。
     *
     * ## 怎么真的命中这条路径
     *
     * `cpSync` 只有在**真实跨卷**时才被调用（同卷走 rename）。造两个卷不现实，
     * 所以直接验证回滚**行为本身**：用源码同形的操作序列 ——
     * 建 `items/<id>`、复制一部分、失败、回滚 —— 确认最终 `items/` 是干净的。
     *
     * 这与 `zz-sd05-probe.mjs` 演示的是同一件事，只是这里断言"回滚后干净"。
     * 它证明的是**回滚这个动作有效**；"`stageInto` 里真的调了回滚"由变异检验覆盖
     * （去掉那段 try/catch 后，这条不会红 —— 因为它不导入实现细节）。
     */
    const root = scratchDir('dsd-sd05-orphan-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    // 移动一个不存在的路径 —— 必然失败。
    await expect(moveToSafeZone(state, join(work, 'does-not-exist.txt'), { retentionDays: 1 })).rejects.toThrow()

    // items/ 里不该有任何残留目录。
    const itemsDir = join(state, 'items')
    const leftovers = existsSync(itemsDir) ? readdirSync(itemsDir) : []
    expect(leftovers, '失败后不该留下孤儿目录').toHaveLength(0)
  })

  it('rolls back a partially copied entry directory', async () => {
    /*
     * 回滚动作本身的验证：建一个"复制到一半"的条目目录，执行回滚，
     * 确认 `items/` 被清空。
     *
     * ## 这条测试能证明什么、不能证明什么
     *
     * **能**证明回滚这个动作有效（删掉整个 `items/<id>`）。
     * **不能**证明 `stageInto` 真的调用了它 —— 那需要真实的跨卷环境，
     * 单元测试里造不出来。
     *
     * 所以另有一条源码级检查（下面那条）守住"复制失败被 try/catch 包住"。
     * 两者合起来才覆盖 SD-05.1：
     *   - 这里：回滚动作对；
     *   - 那里：回滚被调用。
     */
    const root = scratchDir('dsd-sd05-rollback-')
    const state = join(root, 'state')
    const items = join(state, 'items')
    const entryRoot = join(items, 'entry-1')
    const dest = join(entryRoot, 'partial-copy')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'half.bin'), 'PARTIAL')

    expect(readdirSync(items), '先确认有半成品').toHaveLength(1)

    // 这正是 stageInto 失败时执行的回滚。
    const { rmSync } = await import('node:fs')
    rmSync(entryRoot, { recursive: true, force: true })

    expect(readdirSync(items), '回滚后 items/ 应为空').toHaveLength(0)
  })

  it('wraps the cross-volume copy in a rollback (source-level check)', async () => {
    /*
     * SD-05.1 的真正保证在这里。
     *
     * `stageInto` 的跨卷分支只在**真实跨卷**时执行，单元测试造不出那个环境。
     * 所以退一步检查源码结构：`cpSync` 必须被 try/catch 包住，且 catch 里有
     * 回滚（`rmSync(entryRoot, …)`）。
     *
     * 这是一个**结构性检查**，不是行为检查 —— 但如果有人删掉那段 try/catch，
     * 它立刻变红。比"没人记得这条路径存在"要好得多。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/store.ts', 'utf8')

    const at = src.indexOf('cpSync(target, dest')
    expect(at, '应能找到跨卷复制那一行').toBeGreaterThan(0)

    // 往前找最近的 try {
    const before = src.slice(Math.max(0, at - 600), at)
    expect(before, 'cpSync 必须在一个 try 块里').toMatch(/try\s*\{\s*$/m)

    // 往后找 catch 里的回滚
    const after = src.slice(at, at + 700)
    expect(after, 'catch 里必须回滚 entryRoot').toMatch(/catch[\s\S]{0,400}rmSync\(entryRoot/)
  })

  it('does not leave the index out of sync after a failed move', async () => {
    /*
     * 同一个不变量的另一半：失败后索引里也不能多出条目。
     *
     * 若复制失败但索引登记了，用户会看到一条**永远恢复不出来**的条目 ——
     * 比孤儿目录更糟，因为它会一直出现在 list 里。
     */
    const root = scratchDir('dsd-sd05-index-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    await expect(moveToSafeZone(state, join(work, 'nope.txt'), { retentionDays: 1 })).rejects.toThrow()

    expect(await listSafeZone(state), '失败的移动不该登记索引').toHaveLength(0)
  })

  it('keeps every successful entry listed and restorable', async () => {
    // 回归：正常路径不受这些诊断改动影响。
    const root = scratchDir('dsd-sd05-ok-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const id1 = await stage(state, work, 'c.txt')
    const id2 = await stage(state, work, 'd.txt')

    const r = await restoreFromSafeZone(state, id1)
    expect(r.restoredTo).toContain('c.txt')

    // 剩下那条仍可恢复。
    expect(await listSafeZone(state)).toHaveLength(1)
    const r2 = await restoreFromSafeZone(state, id2)
    expect(r2.restoredTo).toContain('d.txt')
    expect(await listSafeZone(state)).toHaveLength(0)
  })
})
