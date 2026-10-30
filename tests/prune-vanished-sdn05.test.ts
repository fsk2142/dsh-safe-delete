import { describe, expect, it } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readAudit } from '../src/audit'
import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { pruneNowForWorker } from '../src/cleanup-run'
import { makeFakeRecycler } from './support/fake-recycler'
import { scratchDir } from './support/tmpdir'

/**
 * SD-N05：worker 不能把"内容不在"一律当成"我们回收了它"。
 *
 * ## 缺陷（2026-10-30 复审）
 *
 * worker 搬文件的循环里有：
 *
 * ```
 * if (!existsSync(from)) {
 *   moved.push(id)   // ← 当作已回收
 *   continue
 * }
 * ```
 *
 * 这些条目随后被计入 `recycled`、写进 `prune` 审计、并从索引移除。
 *
 * 真实交错：用户在这期间执行了 `restore`，内容已回到原路径，而索引
 * 还没反映这一点。worker 看到 `items/<id>` 空了就报告"已清理" ——
 * **同一份数据同时被宣称恢复成功与清理成功**。
 *
 * ## 现在的语义
 *
 * 单独归类为 `vanished`：
 *   - **不计入** `recycled`（不虚报成功）；
 *   - **不写** prune 审计（不留下错误的清理记录）；
 *   - 但索引要清（内容确实不在安全区了，留着只会让 restore 一直报错）。
 */
describe('SD-N05: "content missing" is not "we recycled it"', () => {
  /**
   * 造一条已过期条目。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param name 文件名。
   * @returns 条目 id 与原始路径。
   */
  async function seed(
    state: string,
    work: string,
    name: string,
  ): Promise<{ id: string; original: string }> {
    mkdirSync(work, { recursive: true })
    const p = join(work, name)
    writeFileSync(p, 'IMPORTANT-DATA')
    await moveToSafeZone(state, p, { retentionDays: 1, now: Date.now() - 10 * 86_400_000 })
    const e = (await listSafeZone(state)).find((x) => x.originalPath === p)
    if (e === undefined) throw new Error('条目未登记')
    return { id: e.id, original: p }
  }

  it('does not count a vanished entry as recycled', async () => {
    /*
     * 核心断言：内容不在、但不是我们回收的 → `recycled` 必须是 0。
     *
     * 修复前这里会报 1，用户从日志/UI 看到的"已清理 1 条"是假的。
     */
    const root = scratchDir('dsd-sdn05-count-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { id } = await seed(state, work, 'vanished.txt')

    // 内容消失（模拟 restore 搬走 / 被别处删除），但索引仍认为它在。
    rmSync(join(state, 'items', id), { recursive: true, force: true })
    expect(await listSafeZone(state), '索引仍列着它').toHaveLength(1)

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 100, bin)

    expect(result.recycled, '没回收任何东西，recycled 必须是 0').toBe(0)
    // 索引要清 —— 内容确实不在安全区了。
    expect(await listSafeZone(state), '索引应被清理').toHaveLength(0)
  })

  it('does not write a prune audit record for a vanished entry', async () => {
    /*
     * 审计约束：不能留下"我们清理了它"的错误记录。
     *
     * 那条内容可能正完好地躺在用户目录里 —— 一条虚假的 prune 记录会
     * 让事故调查得出完全错误的结论。
     */
    const root = scratchDir('dsd-sdn05-audit-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { id } = await seed(state, work, 'gone.txt')
    rmSync(join(state, 'items', id), { recursive: true, force: true })

    await pruneNowForWorker(state, 100, makeFakeRecycler(join(root, 'bin')))

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    expect(records, '不该为"内容缺失"写 prune 记录').toHaveLength(0)
  })

  it('keeps the audit clean for a real recycle alongside a vanished entry', async () => {
    /*
     * 混合场景：一条能正常回收、一条已消失。
     * 审计里只能有那**一条**真实回收的记录。
     */
    const root = scratchDir('dsd-sdn05-mixed-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const gone = await seed(state, work, 'gone.txt')
    const real = await seed(state, work, 'real.txt')
    rmSync(join(state, 'items', gone.id), { recursive: true, force: true })

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 100, bin)

    expect(result.recycled, '只有那条真实的被回收').toBe(1)

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    expect(records, '只该有一条 prune 记录').toHaveLength(1)

    const auditedId = /id=([^\s]+)/.exec(records[0]?.detail ?? '')?.[1]
    expect(auditedId, '记录的应是真实回收的那条').toBe(real.id)
    expect(auditedId, '不该记录已消失的那条').not.toBe(gone.id)

    expect(await listSafeZone(state), '两条都应从索引移除').toHaveLength(0)
  })

  it('does not record a vanished entry before a restore that just completed', async () => {
    /*
     * 最贴近真实交错的场景。
     *
     * 用户 restore 成功 → 内容回到原路径、索引里已经没有它。
     * 然后 worker 跑一轮：它读到的是**当前索引**，那条不在里面，
     * 所以什么都不做。
     *
     * 这条确认"正常 restore 之后，worker 不会把它翻出来重新处理"。
     */
    const root = scratchDir('dsd-sdn05-restored-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { id, original } = await seed(state, work, 'restored.txt')
    const { restoredTo } = await restoreFromSafeZone(state, id)
    expect(restoredTo).toBe(original)

    const result = await pruneNowForWorker(state, 100, makeFakeRecycler(join(root, 'bin')))

    expect(result.recycled, 'restore 之后 worker 不该报回收').toBe(0)
    expect(readFileSync(original, 'utf8'), '用户数据必须完好').toBe('IMPORTANT-DATA')
    // 不该有 prune 记录。
    expect(readAudit(state, 100).filter((r) => r.event === 'prune')).toHaveLength(0)
  })

  it('reports a genuine recycle normally', async () => {
    /*
     * 反向保护：真正回收成功的照常计入 recycled 并写审计。
     *
     * 修 SD-N05 不能把"正常回收"也一起打成 vanished。
     */
    const root = scratchDir('dsd-sdn05-normal-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { id } = await seed(state, work, 'normal.txt')

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 100, bin)

    expect(result.recycled, '正常回收应计入').toBe(1)
    expect(bin.calls(), '应调用一次回收站').toBe(1)

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    expect(records).toHaveLength(1)
    expect(/id=([^\s]+)/.exec(records[0]?.detail ?? '')?.[1]).toBe(id)
  })

  it('leaves no leftover batch directory for a vanished-only round', async () => {
    // 只有 vanished 条目时，不该留下空的批次目录。
    const root = scratchDir('dsd-sdn05-nobatch-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const { id } = await seed(state, work, 'only-gone.txt')
    rmSync(join(state, 'items', id), { recursive: true, force: true })

    await pruneNowForWorker(state, 100, makeFakeRecycler(join(root, 'bin')))

    const batches = join(state, 'batches')
    let left = 0
    try {
      left = readdirSync(batches).length
    } catch {
      left = 0
    }
    expect(left, '不该留下批次目录').toBe(0)
  })
})
