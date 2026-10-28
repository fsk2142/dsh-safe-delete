import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 批量删除：一次调用处理大量文件，索引只写一次。
 *
 * ## 为什么需要
 *
 * 实测：删 1000 个文件（`paths` 模式）要 4.4 秒，而删一个含 1000 文件的目录只要
 * 24 ms —— 差 185 倍。原因不是枚举慢（预览只要 42 ms），而是**每删一条都重写
 * 整个 `index.json`**：删第 N 条时索引已有 N-1 条，总成本 O(N²)。
 *
 * ## 判据为什么是结构性的，不是计时的
 *
 * 前两版性能断言都失败过：
 *
 *   1. **绝对阈值**（500 文件 < 1500 ms）：隔离跑 450 ms 通过，全量并行套件下
 *      实测 4843 ms 失败 —— CPU 饱和时单测试膨胀 3–7 倍。
 *   2. **相对比较**（批量应快于逐条 3 倍）：隔离时 201 vs 909 ms（4.5 倍）通过，
 *      全量并行下 1311 vs 1714 ms（**1.3 倍**）失败 —— 争抢把两种方式的差异抹平了。
 *
 * 结论：**任何基于时间的判据在饱和的机器上都不可靠**，而误报的代价是真实的性能
 * 回归被当成抖动忽略。
 *
 * 所以这里改为验证**调用结构**：批量路径必须走 `moveManyToSafeZone` /
 * `appendAuditBatch`，而不是逐条调用。这是"索引只写一次"的**充要条件**，
 * 且不受负载影响。
 *
 * 耗时仍会被打印出来供人参考，但不作为断言。
 */
describe('batch delete: one index write per batch', () => {
  /**
   * 建工具集。
   *
   * @param stateDir 安全区目录。
   * @param work 工作目录。
   * @returns 工具与审批计数。
   */
  function makeTool(
    stateDir: string,
    work: string,
  ): { tool: ReturnType<typeof createTools>[number]; approvals: () => number } {
    let approvals = 0
    const deps: ToolDeps = {
      stateDir,
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => {
        approvals += 1
        return 'allowed-once'
      },
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
    }
    const tool = createTools(deps).find((t) => t.name === 'safe_delete')
    if (tool === undefined) throw new Error('no safe_delete')
    return { tool, approvals: () => approvals }
  }

  /**
   * 造 N 个文件。
   *
   * @param dir 目录。
   * @param n 数量。
   * @returns 路径数组。
   */
  function makeFiles(dir: string, n: number): string[] {
    mkdirSync(dir, { recursive: true })
    const out: string[] = []
    for (let i = 0; i < n; i += 1) {
      const p = join(dir, `f${i}.tmp`)
      writeFileSync(p, 'x')
      out.push(p)
    }
    return out
  }

  it('deletes a batch and records every entry in the index', async () => {
    const root = scratchDir('dsd-batch-perf-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    const files = makeFiles(join(work, 'batch'), 50)
    const { tool } = makeTool(state, work)

    const r = await tool.execute({ paths: files })
    expect(r.ok, r.error ?? '应成功').toBe(true)

    // 每一条都必须进索引 —— 合并写入不能丢记录。
    const entries = await listSafeZone(state)
    expect(entries, '50 条应全部登记').toHaveLength(50)
    const paths = new Set(entries.map((e) => e.originalPath))
    for (const f of files) expect(paths.has(f), `${f} 应在索引里`).toBe(true)
  })

  it('asks for approval once for the whole batch', async () => {
    const root = scratchDir('dsd-batch-approval-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    // 用危险路径触发审批：放进 home 内
    const home = join(work, 'home')
    mkdirSync(home, { recursive: true })
    const dangerous: string[] = []
    for (let i = 0; i < 10; i += 1) {
      const p = join(home, `d${i}.txt`)
      writeFileSync(p, 'x')
      dangerous.push(p)
    }

    const { tool, approvals } = makeTool(state, work)
    const r = await tool.execute({ paths: dangerous })
    expect(r.ok).toBe(true)
    expect(approvals(), '整批只应确认一次').toBe(1)
    expect(await listSafeZone(state), '10 条应全部登记').toHaveLength(10)
  })

  it('keeps the batch consistent when one path fails', async () => {
    const root = scratchDir('dsd-batch-partial-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    const files = makeFiles(join(work, 'batch'), 5)
    // 混入一个不存在的路径，制造单条失败。
    const mixed = [...files, join(work, 'batch', 'ghost.txt')]

    const { tool } = makeTool(state, work)
    const r = await tool.execute({ paths: mixed })

    // 整体 ok=false（有一条失败），但成功的那些必须都进索引。
    const entries = await listSafeZone(state)
    expect(entries, '成功的 5 条仍应登记').toHaveLength(5)
    expect(r.text + (r.error ?? ''), '应提到失败的那条').toContain('ghost')
  })

  it('handles 1000 files without exhausting anything', { timeout: 60_000 }, async () => {
    /*
     * 规模冒烟：1000 条能跑通、全部登记、审计齐全。
     *
     * 不断言耗时（见文件头的理由）。这一条只保证规模上不出错 —— 内存、句柄、
     * 索引大小都不至于把进程搞挂。
     */
    const root = scratchDir('dsd-batch-1000-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    const files = makeFiles(join(work, 'batch'), 1000)
    const { tool } = makeTool(state, work)

    const t0 = Date.now()
    const r = await tool.execute({ paths: files })
    const ms = Date.now() - t0
    console.log(`1000 个文件耗时 ${ms} ms（仅供参考，不作断言）`)

    expect(r.ok, r.error ?? '应成功').toBe(true)
    expect(await listSafeZone(state), '1000 条应全部登记').toHaveLength(1000)

    // 审计必须齐全 —— 快不能靠不记账换来。
    const { readAudit } = await import('../src/audit')
    const records = readAudit(state, 2000)
    expect(records.filter((x) => x.event === 'delete'), '1000 条删除应全部记账').toHaveLength(1000)
  })

  it('uses the batch entry points, not per-item writes', async () => {
    /*
     * **结构性断言**：这才是"索引只写一次"的充要条件。
     *
     * 时间判据在饱和的机器上不可靠（见文件头）。而调用结构是确定的：
     *   - 索引：`deleteMany` 必须调 `moveManyToSafeZone`
     *   - 审计：`deleteMany` 必须调 `appendAuditBatch`
     *
     * 任一处退回逐条，性能就回到 O(N²)，而这里会立刻变红。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/tools.ts', 'utf8')

    const start = src.indexOf('async function deleteMany(')
    expect(start, '应能找到 deleteMany').toBeGreaterThan(0)
    const candidates = [
      src.indexOf('\nexport function ', start + 10),
      src.indexOf('\nfunction ', start + 10),
      src.indexOf('\n  const safeDelete', start + 10),
    ].filter((i) => i > start)
    const end = candidates.length > 0 ? Math.min(...candidates) : src.length
    const body = src.slice(start, end)
    expect(body.length, '截取范围应合理（不是整个文件）').toBeLessThan(src.length)

    // 索引：必须用批量入口，且不能逐条 moveToSafeZone。
    expect(body, 'deleteMany 应使用 moveManyToSafeZone').toContain('moveManyToSafeZone(')
    expect(
      /(^|[^A-Za-z])moveToSafeZone\(/.test(body),
      'deleteMany 里不该逐条调用 moveToSafeZone —— 那会让索引重写 N 次',
    ).toBe(false)

    // 审计：必须用批量入口，且不能逐条 appendAudit。
    expect(body, 'deleteMany 应使用 appendAuditBatch').toContain('appendAuditBatch(')
    expect(
      /(^|[^A-Za-z])appendAudit\(/.test(body),
      'deleteMany 里不该逐条调用 appendAudit —— 那会让 1000 条多花 700+ ms',
    ).toBe(false)
  })
})
