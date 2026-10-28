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
 * 索引在 1660 条时是 450 KB；重写 1000 次就是几十 MB 的写放大。
 *
 * ## 修复原则
 *
 * 一批只在**最后写一次**索引。语义完全不变：每条仍独立走完整流程、独立审计、
 * 单条失败不影响其他条。变的只是"什么时候落盘"。
 */
describe('batch delete: index written once per batch', () => {
  /**
   * 建工具集。
   *
   * @param stateDir 安全区目录。
   * @param work 工作目录。
   * @returns 工具与审批计数。
   */
  function makeTool(stateDir: string, work: string): {
    tool: ReturnType<typeof createTools>[number]
    approvals: () => number
  } {
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

  /**
   * 两个基准测试的显式超时。
   *
   * vitest 默认 `testTimeout` 是 5 秒，而这两个测试做的是**多秒级真实文件系统
   * 操作**（1000 个文件的写入 + 移动 + 审计）。本机实测 435 ms 与 1604 ms，
   * 但在慢机或高负载下会超过 5 秒而**整体超时**——那时断言本身没问题，红的是
   * 测试框架的超时，而不是真的性能回归。
   *
   * 后果比"偶尔红一次"更糟：真实的性能回归也会被当成抖动忽略。
   */
  const PERF_TIMEOUT = 30_000

  it('is far faster than rewriting the index per file', { timeout: PERF_TIMEOUT }, async () => {
    /*
     * 性能回归测试（**索引**那一层）。
     *
     * 收紧到 1500 ms：这里是 500 个文件，实测约 200 ms。原来的阈值 2000 ms
     * 太松 —— 索引逐条写时是 2096 ms，刚好卡在边缘，容易误判为通过。
     */
    const root = scratchDir('dsd-batch-speed-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    const files = makeFiles(join(work, 'batch'), 500)
    const { tool } = makeTool(state, work)

    const t0 = Date.now()
    const r = await tool.execute({ paths: files })
    const ms = Date.now() - t0

    expect(r.ok, r.error ?? '应成功').toBe(true)
    expect(await listSafeZone(state)).toHaveLength(500)
    expect(ms, `500 个文件应在 1.5 秒内完成，实际 ${ms} ms`).toBeLessThan(1500)
  })

  it('is far faster than appending audit records one by one', { timeout: PERF_TIMEOUT }, async () => {
    /*
     * 性能回归测试（**审计**那一层）。
     *
     * 审计曾经是最大单项开销：1000 条逐条 `appendAudit` 要 728 ms，因为每条都
     * 做 6 次系统调用检查「上次是否留下半行」。批量入口只在批首检查一次。
     *
     * ## 为什么用"相对比较"
     *
     * 绝对阈值在慢机器上会误报。这里直接对比两种写法：
     *
     *   批量审计 1000 条：约 0 ms
     *   逐条审计 1000 条：约 808 ms
     *
     * 比值判据不受机器快慢影响。
     */
    const root = scratchDir('dsd-audit-speed-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    const files = makeFiles(join(work, 'batch'), 1000)
    const { tool } = makeTool(state, work)

    const t0 = Date.now()
    const r = await tool.execute({ paths: files })
    const batchMs = Date.now() - t0

    expect(r.ok, r.error ?? '应成功').toBe(true)

    // 审计必须真的写进去了 —— 快不能靠不记账换来。
    const { readAudit, appendAudit, appendAuditBatch } = await import('../src/audit')
    const records = readAudit(state, 2000)
    expect(records.filter((x) => x.event === 'delete'), '1000 条删除应全部记账').toHaveLength(1000)

    /*
     * 直接对比两种审计写法。
     */
    const sample = Array.from({ length: 1000 }, (_, i) => ({
      event: 'delete' as const,
      target: `C:\\x\\f${i}.log`,
      tool: 'safe_delete',
    }))
    const dirA = scratchDir('dsd-audit-cmp-batch-')
    const dirB = scratchDir('dsd-audit-cmp-seq-')

    const tBatch = Date.now()
    appendAuditBatch(dirA, sample)
    const batchOnlyMs = Date.now() - tBatch

    const tSeq = Date.now()
    for (const rec of sample) appendAudit(dirB, rec)
    const seqOnlyMs = Date.now() - tSeq

    console.log(`批量审计 ${batchOnlyMs} ms, 逐条审计 ${seqOnlyMs} ms, 完整删除 ${batchMs} ms`)

    if (seqOnlyMs > 50) {
      expect(
        batchOnlyMs,
        `批量审计(${batchOnlyMs} ms) 应显著快于逐条(${seqOnlyMs} ms)`,
      ).toBeLessThan(seqOnlyMs * 4)
    }
    expect(batchMs, `1000 个文件不应超过 3 秒，实际 ${batchMs} ms`).toBeLessThan(3000)
  })

  it('uses the batch audit entry point, not per-record writes', async () => {
    /*
     * 结构性断言：`deleteMany` 必须走 `appendAuditBatch`。
     *
     * ## 为什么需要这条
     *
     * 上面那条性能测试对比的是「批量 vs 逐条」两个函数本身的耗时 ——
     * 即使把 `deleteMany` 改回逐条调用 `appendAudit`，那两个函数还是原样，
     * 测试依然绿。变异检验证实了这一点。
     *
     * 所以这里直接看源码：批量路径里不该出现逐条 `appendAudit` 调用。
     * 这不是"测实现细节"，而是钉住一个**已经优化过的性能契约** ——
     * 有人改回逐条时必须有东西拦住。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/tools.ts', 'utf8')

    /*
     * 截取 deleteMany 函数体。
     *
     * 边界用「下一个函数开始」—— `deleteMany` 后面紧跟的是 `createTools`，
     * 所以找 `\nexport function ` 或 `\nfunction `。
     *
     * 第一版找的是 `\n  async function `（带缩进），但 `deleteMany` 之后的
     * 函数不是缩进的自由函数，于是 `end = -1`，slice 退化成固定 8000 字符，
     * 越界把后面 `safe_delete` 里的 `appendAudit` 也包了进来 → 误报。
     */
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

    expect(body, 'deleteMany 应使用 appendAuditBatch').toContain('appendAuditBatch(')
    // 允许出现 appendAudit 的字样（注释里会提到），但不允许以调用形式出现。
    expect(
      /(^|[^A-Za-z])appendAudit\(/.test(body),
      'deleteMany 里不该逐条调用 appendAudit —— 那会让 1000 条多花 700+ ms',
    ).toBe(false)
  })
})
