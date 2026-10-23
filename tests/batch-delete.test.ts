import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { scratchDir } from './support/tmpdir'

/**
 * 批量删除（`paths`）。
 *
 * ## 为什么要它
 *
 * 原来 `safe_delete` 只接受单个 `path`，删 N 个文件就得调用 N 次工具，超阈值时
 * 还要确认 N 次。用户会开始无脑点"允许"，确认失去意义。
 *
 * `paths` 的目标：**一次调用、一次确认**，但仍然逐条检查、逐条审计。
 *
 * ## 这里守的三条不变量
 *
 * 1. 批量的审批只调用一次（不是 N 次）
 * 2. 单条失败不影响其他条（各自独立走 deletePath）
 * 3. `path` 与 `paths` 不能同时给（模糊语义会让人猜行为）
 */

interface Harness {
  tools: ReturnType<typeof createTools>
  approvals: string[]
  work: string
}

/**
 * 建一个测试用工具集。
 *
 * @param over 覆盖 ToolDeps 的部分字段。
 * @returns 工具、审批记录、工作目录。
 */
function harness(over: Partial<ToolDeps> = {}): Harness {
  const root = scratchDir('dsd-batch-')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  const approvals: string[] = []
  const deps: ToolDeps = {
    stateDir: join(root, 'state'),
    env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
    requestApproval: async (reason: string) => {
      approvals.push(reason)
      return 'allowed-once'
    },
    retentionDays: 7,
    maxBytes: 20 * 1024 ** 3,
    // 替身：不碰真实回收站。
    recycler: (absPath: string) => {
      const { rmSync } = require('node:fs') as typeof import('node:fs')
      rmSync(absPath, { recursive: true, force: true })
      return { ok: true as const }
    },
    ...over,
  }
  return { tools: createTools(deps), approvals, work }
}

/**
 * 取 safe_delete 工具。
 *
 * @param tools 工具列表。
 * @returns 工具定义。
 */
function safeDeleteOf(tools: ReturnType<typeof createTools>) {
  const found = tools.find((t) => t.name === 'safe_delete')
  if (found === undefined) throw new Error('missing safe_delete')
  return found
}

describe('safe_delete with paths (batch)', () => {
  it('deletes several files in one call', async () => {
    const { tools, work } = harness()
    const files: string[] = []
    for (const name of ['a', 'b', 'c']) {
      const p = join(work, `${name}.txt`)
      writeFileSync(p, 'x')
      files.push(p)
    }

    const result = await safeDeleteOf(tools).execute({ paths: files })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Deleted 3 of 3')
  })

  it('asks for approval only ONCE for the whole batch', async () => {
    // 这是批量的核心价值：删 5 个超阈值文件只确认一次。
    const { tools, work, approvals } = harness({ confirmFileCount: 0, confirmBytes: 1 })
    const files: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const p = join(work, `f${i}.txt`)
      writeFileSync(p, 'xx')
      files.push(p)
    }

    const result = await safeDeleteOf(tools).execute({ paths: files })
    expect(result.ok).toBe(true)
    expect(approvals, '五次删除只应弹一次确认').toHaveLength(1)
    expect(approvals[0], '文案应说明这是批量').toContain('batch')
  })

  it('does not delete anything when the batch is refused', async () => {
    const { tools, work } = harness({
      confirmFileCount: 0,
      confirmBytes: 1,
      requestApproval: async () => 'rejected',
    })
    const a = join(work, 'reject-a.txt')
    const b = join(work, 'reject-b.txt')
    writeFileSync(a, 'xx')
    writeFileSync(b, 'xx')

    const result = await safeDeleteOf(tools).execute({ paths: [a, b] })
    expect(result.ok).toBe(false)
    // 文件必须原地不动。
    expect(require('node:fs').existsSync(a)).toBe(true)
    expect(require('node:fs').existsSync(b)).toBe(true)
  })

  it('reports missing paths without aborting the rest', async () => {
    const { tools, work } = harness()
    const real = join(work, 'real.txt')
    writeFileSync(real, 'x')
    const ghost = join(work, 'does-not-exist.txt')

    const result = await safeDeleteOf(tools).execute({ paths: [real, ghost] })
    expect(result.text).toContain('Deleted 1 of 2')
    expect(result.text).toContain('NOT moved')
    expect(result.text).toContain('does-not-exist')
    // 有失败项时 ok=false，让调用方知道不是全部成功。
    expect(result.ok).toBe(false)
  })

  it('rejects passing both path and paths', async () => {
    const { tools, work } = harness()
    const p = join(work, 'x.txt')
    writeFileSync(p, 'x')

    const result = await safeDeleteOf(tools).execute({ path: p, paths: [p] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not both')
  })

  it('rejects an empty call', async () => {
    const { tools } = harness()
    const result = await safeDeleteOf(tools).execute({})
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('deduplicates repeated paths', async () => {
    // 同一个路径传两次不该产生一条"not found"噪音，也不该删两次。
    const { tools, work } = harness()
    const p = join(work, 'dup.txt')
    writeFileSync(p, 'x')

    const result = await safeDeleteOf(tools).execute({ paths: [p, p] })
    expect(result.ok, '去重后只剩一项，应正常删除').toBe(true)
    // 只剩一项时走单路径分支，输出是 "moved to the safe zone" 而不是批量汇总 ——
    // 两种格式都表示成功，这里断言"没有报错且确实移动了"更稳妥。
    expect(result.text.toLowerCase()).toMatch(/moved to the safe zone|deleted 1 of 1/)
    expect(result.text, '不应出现"未找到"的噪音').not.toContain('NOT moved')
    expect(require('node:fs').existsSync(p), '应已移走').toBe(false)
  })

  it('preview lists everything and moves nothing', async () => {
    const { tools, work, approvals } = harness({ confirmFileCount: 0, confirmBytes: 1 })
    const a = join(work, 'prev-a.txt')
    const b = join(work, 'prev-b.txt')
    writeFileSync(a, 'xx')
    writeFileSync(b, 'xx')

    const result = await safeDeleteOf(tools).execute({ paths: [a, b], preview: true })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('PREVIEW')
    expect(result.text).toContain('would need one confirmation')
    expect(approvals, '预览不该触发审批').toHaveLength(0)
    expect(require('node:fs').existsSync(a), '预览不该移动任何文件').toBe(true)
  })

  it('advertises the array parameter to the model', async () => {
    // schema 里必须有 items，否则模型看到的是裸 array、不知道该传什么。
    const { tools } = harness()
    const props = safeDeleteOf(tools).parameters.properties
    expect(props['paths'], 'schema 应包含 paths').toBeDefined()
    expect(props['paths']?.type).toBe('array')
    expect(props['paths']?.items?.type, 'items 不能被 toJsonSchema 丢掉').toBe('string')
  })
})
