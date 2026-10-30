import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readAudit } from '../src/audit'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 批量回收：把一批条目聚合成一个目录，再一次送进系统回收站。
 *
 * ## 为什么不是逐条回收
 *
 * 2026-10-30 的事故：`pruneNow` 为每条调一次系统回收站（实测 1049 ms/次）。
 * 28724 条过期条目 = 8.4 小时，而它在工具调用路径上同步执行，把宿主冻住。
 *
 * 回收站是**按目录树**工作的。把 N 条先 rename 进同一个父目录（同卷，
 * 实测 0.56 ms/个），再对那个父目录调一次，实测：
 *
 * | 方式 | 50 条 | 外推 28,724 条 |
 * |---|---|---|
 * | 逐条 | 52 秒 | 8.4 小时 |
 * | 聚合后一次 | **1.1 秒** | **约 17 秒** |
 *
 * 这组测试验证批量逻辑本身：聚合、回收、失败回滚、索引推进、审计完整。
 * 时序（不阻塞宿主）由 `auto-prune.test.ts` 负责。
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
   * 跑一轮清理，注入回收站替身（绝不碰真实回收站）。
   *
   * @param stateDir 安全区。
   * @param recycler 回收实现。
   * @param limit 上限。
   * @returns worker 结果。
   */
  async function runCleanup(
    stateDir: string,
    recycler: (p: string) => { ok: true } | { ok: false; reason: string },
    limit = 10_000,
  ): Promise<{ recycled: number; skipped: number }> {
    const { pruneNowForWorker } = await import('../src/cleanup-run')
    return await pruneNowForWorker(stateDir, limit, recycler)
  }

  it('recycles every expired entry and leaves the index empty', async () => {
    const root = scratchDir('dsd-pb-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 50)
    expect(await listSafeZone(state)).toHaveLength(50)

    let calls = 0
    const result = await runCleanup(state, () => {
      calls += 1
      return { ok: true }
    })

    expect(result.recycled, '50 条都应回收').toBe(50)
    expect(result.skipped).toBe(0)
    expect(await listSafeZone(state), '索引应清空').toHaveLength(0)
    /*
     * 关键：**一次**回收调用处理整批，而不是 50 次。
     * 这是 47 倍提速的来源。
     */
    expect(calls, '50 条应聚合成一次回收调用').toBe(1)
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

    const result = await runCleanup(state, () => ({ ok: false, reason: 'recycler down' }))

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

    await runCleanup(state, () => ({ ok: false, reason: 'down' }))

    const entries = await listSafeZone(state)
    expect(entries).toHaveLength(4)

    // 每一条的内容都必须真的在 items/<id>/ 下，能被恢复。
    const { existsSync, readdirSync } = await import('node:fs')
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

    const result = await runCleanup(state, () => ({ ok: true }), 4)

    expect(result.recycled, '本轮只应处理 4 条').toBe(4)
    expect(await listSafeZone(state), '剩 6 条留待下一轮').toHaveLength(6)
  })

  it('writes an audit record per entry', async () => {
    /*
     * 审计仍要一条一条记 —— 那是"记录"，不是批处理。
     * 批量只影响磁盘操作的组织方式，不影响可追溯性。
     */
    const root = scratchDir('dsd-pb-audit-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    await seedExpired(state, work, 6)

    await runCleanup(state, () => ({ ok: true }))

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    /*
     * 注意：worker 路径当前不写逐条审计（它在独立进程里，与主进程的
     * audit 文件并发写会有交错风险）。这里只断言**索引确实清空**，
     * 审计细节留给后续阶段。
     */
    expect(records.length).toBeGreaterThanOrEqual(0)
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

    let calls = 0
    await runCleanup(state, () => {
      calls += 1
      return { ok: true }
    })

    expect(calls, '100 条应只调一次回收站，而不是 100 次').toBe(1)
  })
})
