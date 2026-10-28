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

  it('is far faster than rewriting the index per file', async () => {
    /*
     * 性能回归测试。
     *
     * 阈值取得宽松（500 个文件 2 秒）：修复前是 2 秒左右，修复后应在 100 ms 级。
     * 目的是抓「有人把索引写入改回逐条」这类回归，不是精确基准。
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
    expect(ms, `500 个文件应在 2 秒内完成，实际 ${ms} ms`).toBeLessThan(2000)
  })
})
