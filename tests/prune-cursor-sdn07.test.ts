import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone } from '../src/store'
import { pruneNowForWorker } from '../src/cleanup-run'
import { makeFakeRecycler } from './support/fake-recycler'
import { scratchDir } from './support/tmpdir'

/**
 * SD-N07：字节上限不该让整轮清理提前结束。
 *
 * ## 缺陷（2026-10-30 复审）
 *
 * 外层按 500 条切、内层再按 256 MiB 切，内层一旦截断就 `break`
 * **整个外层循环**：
 *
 * ```
 * for (let start = 0; start < expired.length; start += BATCH_SIZE) {
 *   内层按字节切 batch
 *   处理 batch
 *   if (batch.length < slice.length) break   ← 整轮结束
 * }
 * ```
 *
 * 后果：10 条各 100 MiB 的过期条目，第一批只装得下 2 条，然后整轮结束。
 * 剩下 8 条要等下一次自动调度（可能一小时后）。积压增长速度超过
 * Worker 的处理能力。
 *
 * ## 怎么用测试复现
 *
 * 真实造 100 MiB 文件太慢，而且 `BATCH_MAX_BYTES` 是常量。
 * 但**条目记录的 `bytes` 字段**参与切批计算 —— 用 `moveToSafeZone` 造
 * 小文件、然后直接改索引里的 `bytes` 值，就能用很小的真实文件模拟
 * "每条都很大"的场景。
 */
describe('SD-N07: a byte-capped batch does not end the whole round', () => {
  /**
   * 造 N 条已过期条目，并把索引里的 `bytes` 改成指定值。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param n 条数。
   * @param fakeBytes 每条记录的字节数（用于切批计算）。
   */
  async function seedExpired(
    state: string,
    work: string,
    n: number,
    fakeBytes: number,
  ): Promise<void> {
    const { readFileSync: read, writeFileSync: write } = await import('node:fs')
    mkdirSync(work, { recursive: true })
    for (let i = 0; i < n; i += 1) {
      const p = join(work, `big${i}.bin`)
      writeFileSync(p, 'x')
      await moveToSafeZone(state, p, { retentionDays: 1, now: Date.now() - 10 * 86_400_000 })
    }

    /*
     * 直接改索引里的 bytes —— 这是切批计算的输入。
     *
     * 用真实大文件会让测试跑很久，而我们验证的是**切批逻辑**，
     * 不是磁盘吞吐。
     */
    const idxPath = join(state, 'index.json')
    const idx = JSON.parse(read(idxPath, 'utf8')) as Array<Record<string, unknown>>
    for (const e of idx) e['bytes'] = fakeBytes
    write(idxPath, JSON.stringify(idx, null, 2))
  }

  it('processes every entry even when each one is huge', async () => {
    /*
     * 核心断言：8 条、每条 100 MiB（> 256 MiB 上限的 1/3）时，
     * 一轮应当把它们**全部**处理掉，而不是只处理两条就停。
     */
    const root = scratchDir('dsd-sdn07-all-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const N = 8
    const HUNDRED_MIB = 100 * 1024 * 1024
    await seedExpired(state, work, N, HUNDRED_MIB)
    expect(await listSafeZone(state)).toHaveLength(N)

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 100, bin)

    expect(result.recycled, `${N} 条都该在这一轮处理完`).toBe(N)
    expect(await listSafeZone(state), '索引应清空').toHaveLength(0)
    /*
     * 每批最多 2 条（256 MiB / 100 MiB），所以 8 条至少要 4 次回收调用 ——
     * 这也证明了分批确实在生效（不是一次全塞进去）。
     */
    expect(bin.calls(), '应分批多次调用').toBeGreaterThanOrEqual(4)
  })

  it('advances even when a single entry exceeds the byte cap', async () => {
    /*
     * 单条自身超过 256 MiB 时，它必须**单独成批**并被处理 ——
     * 不能因为"放进去就超上限"而无限自旋或跳过。
     */
    const root = scratchDir('dsd-sdn07-huge-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const ONE_GIB = 1024 * 1024 * 1024
    await seedExpired(state, work, 3, ONE_GIB)

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 100, bin)

    expect(result.recycled, '3 条超大条目都应处理').toBe(3)
    expect(await listSafeZone(state)).toHaveLength(0)
    // 每条单独成批。
    expect(bin.calls()).toBe(3)
  })

  it('still respects the per-round limit', async () => {
    /*
     * 游标推进不能突破本轮数量上限。
     *
     * limit 是"这一轮处理多少条"，与"要不要继续下一批"是两件事。
     */
    const root = scratchDir('dsd-sdn07-limit-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    await seedExpired(state, work, 10, 100 * 1024 * 1024)

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 4, bin)

    expect(result.recycled, '只处理 4 条').toBe(4)
    expect(await listSafeZone(state), '剩 6 条').toHaveLength(6)
  })

  it('keeps the normal path unchanged for small entries', async () => {
    // 回归：小条目不受影响，且仍按条数分批。
    const root = scratchDir('dsd-sdn07-small-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    await seedExpired(state, work, 10, 1024)

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 100, bin)

    expect(result.recycled).toBe(10)
    expect(await listSafeZone(state)).toHaveLength(0)
    // 10 条小条目应一次回收调用就够。
    expect(bin.calls(), '小条目应聚合成一批').toBe(1)
  })
})
