import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readAudit } from '../src/audit'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { pruneNowForWorker } from '../src/cleanup-run'
import { makeFakeRecycler } from './support/fake-recycler'
import { scratchDir } from './support/tmpdir'

/**
 * SD-F1：worker 清理必须留下可追溯的审计记录。
 *
 * ## 缺陷（2026-10-30 复审）
 *
 * Worker 回收成功后只调 `writeIndexFiltered`，**不写任何审计** ——
 * `safe_zone_journal` 的说明承诺可追溯，而自动清理搬走的条目在流水里查不到。
 *
 * 更糟的是原测试的审计断言写成了：
 *
 * ```js
 * expect(records.length).toBeGreaterThanOrEqual(0)   // 恒真，永远通过
 * ```
 *
 * 那不是一个断言，是一句话。它掩盖了这个缺口一整个版本。
 *
 * ## 这里的断言原则
 *
 * 必须断言**确切数量**和**具体 id**，不允许 `>= 0` 之类的恒真检查。
 */
describe('SD-F1: worker prune writes audit records', () => {
  /**
   * 造 N 条已过期条目。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param n 条数。
   * @returns 条目 id 列表。
   */
  async function seedExpired(state: string, work: string, n: number): Promise<string[]> {
    mkdirSync(work, { recursive: true })
    for (let i = 0; i < n; i += 1) {
      const p = join(work, `old${i}.txt`)
      writeFileSync(p, 'x')
      await moveToSafeZone(state, p, { retentionDays: 1, now: Date.now() - 10 * 86_400_000 })
    }
    return (await listSafeZone(state)).map((e) => e.id)
  }

  it('writes one prune record per recycled entry', async () => {
    /*
     * 核心断言：清理 3 条 → journal 里必须有 **3 条** prune 记录，
     * 且 id 一一对应。
     */
    const root = scratchDir('dsd-sdf1-count-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const ids = await seedExpired(state, work, 3)
    expect(ids).toHaveLength(3)

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 100, bin)
    expect(result.recycled, '3 条都应回收').toBe(3)

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')

    /*
     * **确切数量**，不是 >= 0。
     *
     * 原测试就是 `>= 0`，永远不会失败 —— 它让"worker 完全不写审计"
     * 这个问题隐藏了一整个版本。
     */
    expect(records, '必须正好 3 条审计记录').toHaveLength(3)

    // 每条记录的 id 都要能对上。
    const auditedIds = new Set(
      records.map((r) => /id=([^\s]+)/.exec(r.detail ?? '')?.[1]).filter(Boolean),
    )
    for (const id of ids) {
      expect(auditedIds, `条目 ${id} 必须有审计记录`).toContain(id)
    }
  })

  it('records the tool and batch so a run can be traced', async () => {
    // 记录里要能看出"谁清的"和"哪一批"，否则几条流水无法聚合成一次操作。
    const root = scratchDir('dsd-sdf1-trace-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    await seedExpired(state, work, 2)
    await pruneNowForWorker(state, 100, makeFakeRecycler(join(root, 'bin')))

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    expect(records.length).toBe(2)

    for (const r of records) {
      expect(r.tool, '应标明是 worker 清的').toBe('cleanup-worker')
      expect(r.detail, '应带批次号').toMatch(/batch=/)
      expect(r.target, '应记录原路径').toContain('.txt')
    }

    // 同一批次的条目应共享同一个 batch id。
    const batches = new Set(records.map((r) => /batch=(\S+)/.exec(r.detail ?? '')?.[1]))
    expect(batches.size, '同一批应只有一个 batch id').toBe(1)
  })

  it('does not record entries that failed to recycle', async () => {
    /*
     * 反向约束：回收失败时**不能**记成"已清理"。
     *
     * 虚报成功比不记录更糟 —— 用户会以为那条已经安全移除。
     */
    const root = scratchDir('dsd-sdf1-fail-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    await seedExpired(state, work, 3)

    // 什么都不移动、报告失败。
    const result = await pruneNowForWorker(state, 100, () => ({ ok: false, reason: 'down' }))
    expect(result.recycled).toBe(0)

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    expect(records, '失败的回收不该产生 prune 记录').toHaveLength(0)

    // 条目仍在索引里。
    expect(await listSafeZone(state)).toHaveLength(3)
  })

  it('records nothing when there is nothing to prune', async () => {
    // 没有过期条目时不该凭空产生记录。
    const root = scratchDir('dsd-sdf1-empty-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    const result = await pruneNowForWorker(state, 100, makeFakeRecycler(join(root, 'bin')))
    expect(result.recycled).toBe(0)

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    expect(records).toHaveLength(0)
  })
})
