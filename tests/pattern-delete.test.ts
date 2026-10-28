import { describe, expect, it } from 'vitest'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * `safe_delete` 的模式形态：`root` + `match` / `olderThan` / `exclude`。
 *
 * ## 这组测试要钉住的东西
 *
 * 1. 模式真的能挑出文件并删掉（基本功能）
 * 2. **root 本身不会被删** —— 误写 `root: C:\Work` 时不该把整个目录端走
 * 3. exclude 生效
 * 4. olderThan 生效
 * 5. 匹配为空时**报错**而非静默成功
 * 6. 与 `path`/`paths` 互斥
 */
describe('safe_delete: pattern form', () => {
  /**
   * 建工具集。
   *
   * @param root 测试根目录。
   * @returns tool 与审批计数。
   */
  function setup(root: string): { tool: ReturnType<typeof createTools>[number]; approvals: () => number } {
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    let approvals = 0
    const deps: ToolDeps = {
      stateDir: join(root, 'state'),
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
   * 造文件。
   *
   * @param base 基目录。
   * @param rels 相对路径列表。
   * @returns 绝对路径列表。
   */
  function make(base: string, rels: string[]): string[] {
    const out: string[] = []
    for (const rel of rels) {
      const p = join(base, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, 'x')
      out.push(p)
    }
    return out
  }

  it('deletes matched files and keeps the root', async () => {
    const root = scratchDir('dsd-pat-')
    const base = join(root, 'work', 'logs')
    make(base, ['a.log', 'b.log', 'c.txt'])
    const { tool } = setup(root)

    const r = await tool.execute({ root: base, match: '*.log' })
    expect(r.ok, r.error ?? '应成功').toBe(true)

    // 关键：root 本身必须还在。
    const { existsSync } = await import('node:fs')
    expect(existsSync(base), 'root 目录本身不该被删').toBe(true)
    // 命中的文件进了安全区。
    const entries = await listSafeZone(join(root, 'state'))
    expect(entries).toHaveLength(2)
    const names = entries.map((e) => e.originalPath.split(/[\\/]/).pop()).sort()
    expect(names).toEqual(['a.log', 'b.log'])
  })

  it('honours exclude', async () => {
    const root = scratchDir('dsd-pat-ex-')
    const base = join(root, 'work', 'tmp')
    make(base, ['a.log', 'keep/k.log'])
    const { tool } = setup(root)

    const r = await tool.execute({ root: base, match: '**/*.log', exclude: ['keep/**'] })
    expect(r.ok, r.error ?? '应成功').toBe(true)

    const entries = await listSafeZone(join(root, 'state'))
    expect(entries.map((e) => e.originalPath.split(/[\\/]/).pop())).toEqual(['a.log'])
  })

  it('honours olderThan', async () => {
    const root = scratchDir('dsd-pat-time-')
    const base = join(root, 'work', 'logs')
    const made = make(base, ['old.log', 'new.log'])
    // 把 old.log 设到 10 天前。
    const tenDaysAgo = (Date.now() - 10 * 86400000) / 1000
    utimesSync(made[0] as string, tenDaysAgo, tenDaysAgo)
    const { tool } = setup(root)

    const r = await tool.execute({ root: base, match: '*.log', olderThan: '7d' })
    expect(r.ok, r.error ?? '应成功').toBe(true)

    const entries = await listSafeZone(join(root, 'state'))
    expect(entries.map((e) => e.originalPath.split(/[\\/]/).pop())).toEqual(['old.log'])
  })

  it('errors instead of silently succeeding when nothing matches', async () => {
    const root = scratchDir('dsd-pat-none-')
    const base = join(root, 'work', 'logs')
    make(base, ['a.log'])
    const { tool } = setup(root)

    const r = await tool.execute({ root: base, match: '*.nope' })
    expect(r.ok, '没匹配到必须是失败，不能静默 ok').toBe(false)
    expect(r.error ?? '').toContain('no files matched')
    expect(await listSafeZone(join(root, 'state')), '不该删任何东西').toHaveLength(0)
  })

  it('refuses to combine with path or paths', async () => {
    const root = scratchDir('dsd-pat-mix-')
    const base = join(root, 'work', 'logs')
    make(base, ['a.log'])
    const { tool } = setup(root)

    const r1 = await tool.execute({ path: join(base, 'a.log'), root: base, match: '*.log' })
    expect(r1.ok).toBe(false)
    expect(r1.error ?? '').toContain('cannot be combined')

    const r2 = await tool.execute({ paths: [join(base, 'a.log')], root: base })
    expect(r2.ok).toBe(false)
    expect(r2.error ?? '').toContain('cannot be combined')
  })

  it('requires root when match is given', async () => {
    const root = scratchDir('dsd-pat-noroot-')
    const { tool } = setup(root)
    const r = await tool.execute({ match: '*.log' })
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('need `root`')
  })

  it('rejects a non-array exclude instead of silently ignoring it', async () => {
    /*
     * 静默忽略的后果是**删得比用户预期多**：他写了排除规则，以为某些目录会被
     * 保留，实际全部命中、全部移走。
     *
     * 这类「参数写错但操作照常执行」比直接报错危险得多。
     */
    const root = scratchDir('dsd-pat-badexclude-')
    const base = join(root, 'work', 'logs')
    make(base, ['a.log', 'keep/k.log'])
    const { tool } = setup(root)

    const r = await tool.execute({ root: base, match: '*.log', exclude: 'keep/**' })
    expect(r.ok, '传字符串应报错').toBe(false)
    expect(r.error ?? '').toContain('must be an array')
    // 关键：报错时不能已经删了东西。
    expect(await listSafeZone(join(root, 'state')), '报错时不该删任何东西').toHaveLength(0)
  })

  it('rejects a non-string entry inside exclude', async () => {
    const root = scratchDir('dsd-pat-badexclude2-')
    const base = join(root, 'work', 'logs')
    make(base, ['a.log'])
    const { tool } = setup(root)

    const r = await tool.execute({ root: base, match: '*.log', exclude: [123] })
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('must be non-empty glob strings')
  })

  it('rejects an unparseable olderThan', async () => {
    const root = scratchDir('dsd-pat-badtime-')
    const base = join(root, 'work', 'logs')
    make(base, ['a.log'])
    const { tool } = setup(root)
    const r = await tool.execute({ root: base, olderThan: 'yesterday' })
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('cannot parse')
  })

  it('previews without moving anything', async () => {
    const root = scratchDir('dsd-pat-preview-')
    const base = join(root, 'work', 'logs')
    const made = make(base, ['a.log', 'b.log'])
    const { tool } = setup(root)

    const r = await tool.execute({ root: base, match: '*.log', preview: true })
    expect(r.ok).toBe(true)
    expect(r.text).toContain('PREVIEW')
    const { existsSync } = await import('node:fs')
    for (const f of made) expect(existsSync(f), `${f} 应还在`).toBe(true)
    expect(await listSafeZone(join(root, 'state'))).toHaveLength(0)
  })
})
