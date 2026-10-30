import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone } from '../src/store'
import { pruneNowForWorker } from '../src/cleanup-run'
import { makeFakeRecycler } from './support/fake-recycler'
import { scratchDir } from './support/tmpdir'

/**
 * SD-03：`mode: 'all'` 必须真的清掉未过期条目。
 *
 * ## 缺陷（2026-10-30 复审）
 *
 * `/safe-delete clean` 与面板"立即清理"的语义是**清空安全区**，但它们只把
 * `selected.length` 当 `limit` 传给 `requestCleanup`，而 worker 永远
 * `selectForPrune`（仅过期）。
 *
 * 确定性触发步骤（复审给出）：
 *
 * 1. 删一个文件（5 分钟前，保留期 1 天）；
 * 2. 敲 `/safe-delete clean`；
 * 3. 主入口报告"已请求清理 1 条"；
 * 4. worker 找不到过期项 → `recycled=0`；
 * 5. 安全区里那条**纹丝不动**，而命令看起来成功了。
 *
 * "处理多少条"和"选哪些"是两件事，一个数字表达不了 —— 所以加了 `mode`。
 */
describe('SD-03: prune mode distinguishes "expired" from "all"', () => {
  /**
   * 造 N 条**未过期**条目（刚移入，保留期 7 天）。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param n 条数。
   */
  async function seedFresh(state: string, work: string, n: number): Promise<void> {
    mkdirSync(work, { recursive: true })
    for (let i = 0; i < n; i += 1) {
      const p = join(work, `fresh${i}.txt`)
      writeFileSync(p, 'x')
      // 保留期 7 天，刚移入 → 远未过期。
      await moveToSafeZone(state, p, { retentionDays: 7 })
    }
  }

  /**
   * 造 N 条**已过期**条目。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param n 条数。
   */
  async function seedExpired(state: string, work: string, n: number): Promise<void> {
    mkdirSync(work, { recursive: true })
    for (let i = 0; i < n; i += 1) {
      const p = join(work, `old${i}.txt`)
      writeFileSync(p, 'x')
      await moveToSafeZone(state, p, { retentionDays: 1, now: Date.now() - 10 * 86_400_000 })
    }
  }

  it('expired mode leaves fresh entries alone', async () => {
    // 自动清理的语义：只动过期的，绝不碰新鲜条目。
    const root = scratchDir('dsd-sd03-exp-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    await seedFresh(state, work, 3)

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 100, bin, Date.now, 'expired')

    expect(result.recycled, '没有过期项，不该回收任何东西').toBe(0)
    expect(await listSafeZone(state), '3 条新鲜的都该留着').toHaveLength(3)
    expect(bin.calls(), '没东西可清就不该调回收站').toBe(0)
  })

  it('all mode clears fresh entries too', async () => {
    /*
     * 这是 SD-03 的核心断言。
     *
     * 修复前：即使传 `limit: 3`（甚至 100000），worker 也只选过期项，
     * 结果 `recycled=0`、3 条全部留下 —— 用户点"清空"却什么都没发生。
     */
    const root = scratchDir('dsd-sd03-all-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    await seedFresh(state, work, 3)

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 100, bin, Date.now, 'all')

    expect(result.recycled, 'all 模式必须连新鲜条目一起清').toBe(3)
    expect(await listSafeZone(state), '索引应清空').toHaveLength(0)
  })

  it('all mode respects the limit', async () => {
    // 数量上限仍然有效 —— mode 与 limit 是两个独立维度。
    const root = scratchDir('dsd-sd03-limit-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    await seedFresh(state, work, 5)

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 2, bin, Date.now, 'all')

    expect(result.recycled, '只处理 2 条').toBe(2)
    expect(await listSafeZone(state), '剩 3 条').toHaveLength(3)
  })

  it('handles a mixed set correctly in each mode', async () => {
    /*
     * 混在一起时两种模式的分界必须清楚：
     * 2 条过期 + 2 条新鲜。
     */
    const root = scratchDir('dsd-sd03-mixed-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    await seedExpired(state, work, 2)
    await seedFresh(state, work, 2)
    expect(await listSafeZone(state)).toHaveLength(4)

    // expired 模式：只清那 2 条过期的。
    const bin1 = makeFakeRecycler(join(root, 'bin1'))
    const r1 = await pruneNowForWorker(state, 100, bin1, Date.now, 'expired')
    expect(r1.recycled, 'expired 模式只清 2 条').toBe(2)
    expect(await listSafeZone(state), '剩 2 条新鲜的').toHaveLength(2)

    // all 模式：剩下的也清掉。
    const bin2 = makeFakeRecycler(join(root, 'bin2'))
    const r2 = await pruneNowForWorker(state, 100, bin2, Date.now, 'all')
    expect(r2.recycled, 'all 模式清掉剩余 2 条').toBe(2)
    expect(await listSafeZone(state)).toHaveLength(0)
  })

  it('defaults to expired when mode is omitted', async () => {
    /*
     * 安全默认：省略 mode 时按 `expired`。
     *
     * 宁可少清（用户再点一次），不可多删（用户没要求清空却清空了）。
     */
    const root = scratchDir('dsd-sd03-default-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    await seedFresh(state, work, 2)

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 100, bin, Date.now)

    expect(result.recycled, '省略 mode 应保守地只清过期项').toBe(0)
    expect(await listSafeZone(state)).toHaveLength(2)
  })
})
