import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone } from '../src/store'
import { pruneNowForWorker } from '../src/cleanup-run'
import { makeFakeRecycler } from './support/fake-recycler'
import { scratchDir } from './support/tmpdir'

/**
 * 单轮 worker 的真实吞吐。
 *
 * ## 为什么需要这个数据
 *
 * `MAX_PRUNE_PER_RUN = 200` 是 2026-10-30 事故应急时**凭感觉**设的数字 ——
 * 当时清理跑在主进程里、每条一次系统回收站调用，200 是怕把宿主卡死。
 *
 * 现在清理在独立子进程里、按批聚合回收（500 条一批、一次调用）。旧的 200
 * 上限已经**没有依据**，而且直接决定了积压恢复速度：
 *
 * ```
 * 28,724 条积压 ÷ 200 条/小时 = 6 天
 * ```
 *
 * 这组测试测出真实速率，为调整上限提供依据。
 */
describe('worker throughput (determines MAX_PRUNE_PER_RUN)', () => {
  /**
   * 造 N 条已过期条目。
   *
   * @param stateDir 安全区。
   * @param work 工作目录。
   * @param n 条数。
   */
  async function seed(stateDir: string, work: string, n: number): Promise<void> {
    const { moveManyToSafeZone } = await import('../src/store')
    mkdirSync(work, { recursive: true })
    const paths: string[] = []
    for (let i = 0; i < n; i += 1) {
      const p = join(work, `f${i}.txt`)
      writeFileSync(p, 'x')
      paths.push(p)
    }
    for (let start = 0; start < paths.length; start += 500) {
      await moveManyToSafeZone(stateDir, paths.slice(start, start + 500), {
        retentionDays: 1,
        now: Date.now() - 10 * 86400000,
      })
    }
  }

  const sizes = [200, 1000, 3000]

  for (const n of sizes) {
    it(`processes ${n} entries and reports the rate`, { timeout: 120_000 }, async () => {
      const root = scratchDir(`dsd-rate-${n}-`)
      const state = join(root, 'state')
      const work = join(root, 'work')
      await seed(state, work, n)
      expect(await listSafeZone(state)).toHaveLength(n)

      const bin = makeFakeRecycler(join(root, 'bin'))
      const t0 = Date.now()
      const result = await pruneNowForWorker(state, n, bin)
      const ms = Date.now() - t0

      console.log(
        `  ${n} 条: ${ms} ms (${(ms / n).toFixed(2)} ms/条), ` +
          `回收调用 ${bin.calls()} 次, 已回收 ${result.recycled}`,
      )

      expect(result.recycled, '全部应回收').toBe(n)
      expect(await listSafeZone(state)).toHaveLength(0)

      /*
       * 每次调用都该处理整批（500 条/批），而不是逐条 ——
       * 这是批量回收是否生效的直接判据。
       */
      expect(bin.calls(), `${n} 条应只调用 ${Math.ceil(n / 500)} 次回收站`).toBeLessThanOrEqual(
        Math.ceil(n / 500),
      )
    })
  }
})
