import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { readAudit } from '../src/audit'
import { scratchDir } from './support/tmpdir'

/**
 * prune 的批量化。
 *
 * ## 问题
 *
 * `pruneNow` 对每个过期条目调一次 `destroyEntry`，而它每次**读全量索引 + 写全量
 * 索引**。N 条过期 → N 次全量读写 → O(N²)。
 *
 * 实测（本机）：
 *
 *   600 条   → 1.26 s  (2.1 ms/条)
 *   3000 条  → 12.93 s (4.3 ms/条)   ← 每条耗时翻倍，超线性
 *
 * 真实触发场景：用户外出数日、保留期 1 天，回来后索引积累数千条过期条目；
 * 此后**每次**工具调用都会重跑这个循环，且阻塞串行队列。
 *
 * ## 目标
 *
 * 读一次索引 → 逐条处理内容（回收站或丢弃）→ 收集幸存条目 → 写一次索引。
 * 与 `moveManyToSafeZone` 同款模式。
 *
 * ## 必须保持的行为
 *
 * - 回收失败的条目**留在安全区**（宁可占盘，不能永久删）
 * - 每条一条审计记录
 * - 返回"真正移入回收站"的那些
 */
describe('prune: batched index writes', () => {
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
   * 建工具集。
   *
   * @param stateDir 安全区。
   * @param work 工作目录。
   * @param recycler 回收实现。
   * @returns 工具与回收计数。
   */
  function makeTools(
    stateDir: string,
    work: string,
    recycler: (p: string) => { ok: true } | { ok: false; reason: string },
  ): { tool: ReturnType<typeof createTools>[number]; recycled: () => number } {
    let recycled = 0
    const deps: ToolDeps = {
      stateDir,
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => 'allowed-once',
      retentionDays: 1,
      recycler: (p: string) => {
        recycled += 1
        return recycler(p)
      },
    }
    const tool = createTools(deps).find((t) => t.name === 'safe_zone_status')
    if (tool === undefined) throw new Error('no status tool')
    return { tool, recycled: () => recycled }
  }

  it('prunes every expired entry and leaves the index empty', async () => {
    const root = scratchDir('dsd-pb-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 50)
    expect(await listSafeZone(state)).toHaveLength(50)

    const { tool, recycled } = makeTools(state, work, () => ({ ok: true }))
    await tool.execute({})

    expect(recycled(), '50 条都应进回收站').toBe(50)
    expect(await listSafeZone(state), '索引应清空').toHaveLength(0)
  })

  it('keeps entries whose recycle FAILS, and reports them in the audit', async () => {
    /*
     * 最关键的不变量：回收站不可用时，条目必须留在安全区。
     * 批量改造不能把这条丢掉 —— 那是"因为回收站坏了就永久删除"。
     */
    const root = scratchDir('dsd-pb-fail-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 5)

    const { tool, recycled } = makeTools(state, work, () => ({ ok: false, reason: 'recycler down' }))
    await tool.execute({})

    expect(recycled(), '都尝试过').toBe(5)
    expect(await listSafeZone(state), '失败的全部保留').toHaveLength(5)

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    expect(records.filter((r) => (r.detail ?? '').includes('skipped')), '每条失败都要记账').toHaveLength(5)
  })

  it('handles a mix of successes and failures', async () => {
    const root = scratchDir('dsd-pb-mix-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 10)

    let n = 0
    const { tool } = makeTools(state, work, () => {
      n += 1
      // 偶数成功、奇数失败
      return n % 2 === 0 ? { ok: true } : { ok: false, reason: 'flaky' }
    })
    await tool.execute({})

    const left = await listSafeZone(state)
    expect(left, '5 条失败应保留').toHaveLength(5)
    expect(left.length + 5, '5 条成功被移除').toBe(10)
  })

  it('writes one audit record per entry, success or failure', async () => {
    const root = scratchDir('dsd-pb-audit-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 20)

    const { tool } = makeTools(state, work, () => ({ ok: true }))
    await tool.execute({})

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    expect(records, '20 条清理应产生 20 条审计').toHaveLength(20)
  })

  it('is markedly superlinear before batching and near-linear after', { timeout: 60_000 }, async () => {
    /*
     * 性能回归。
     *
     * 批量前：每条耗时随索引增长（600 条 2.1 ms/条，3000 条 4.3 ms/条）。
     * 批量后：应当接近常数。
     *
     * 用 400 vs 1200 条对比「每条的耗时」比值：超线性时后者明显更高。
     * 阈值放宽（1.6 倍），避免 CI 抖动误报。
     */
    const measure = async (n: number): Promise<number> => {
      const root = scratchDir(`dsd-pb-perf-${n}-`)
      const work = join(root, 'work')
      const state = join(root, 'state')
      mkdirSync(work, { recursive: true })
      await seedExpired(state, work, n)
      const { tool } = makeTools(state, work, () => ({ ok: true }))
      const t0 = Date.now()
      await tool.execute({})
      return Date.now() - t0
    }

    const small = await measure(400)
    const large = await measure(1200)
    const perSmall = small / 400
    const perLarge = large / 1200
    console.log(`400 条: ${small} ms (${perSmall.toFixed(2)} ms/条), 1200 条: ${large} ms (${perLarge.toFixed(2)} ms/条)`)

    expect(
      perLarge,
      `每条耗时不应随规模显著上升（400 条 ${perSmall.toFixed(2)} vs 1200 条 ${perLarge.toFixed(2)} ms/条）`,
    ).toBeLessThan(Math.max(perSmall * 1.6, 0.6))
  })
})
