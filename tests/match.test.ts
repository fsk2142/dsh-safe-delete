import { describe, expect, it } from 'vitest'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { matchInTree, parseDuration } from '../src/match'
import { scratchDir } from './support/tmpdir'

/**
 * 按模式 / 时间 / 排除挑出待删项。
 *
 * ## 为什么这组测试重要
 *
 * 这是唯一一处「用户输入的模式直接决定删什么」的地方。模式写错会多删。
 * 所以每个边界都要钉住：`**` 的跨层语义、`{a,b}` 的多选、exclude 优先于
 * include、root 自身不入选、符号链接不跟随。
 */
describe('matchInTree: pattern', () => {
  /**
   * 造一棵固定的测试树。
   *
   * ```
   * root/
   *   a.log  b.log  c.txt
   *   sub/d.log  sub/e.txt
   *   sub/deep/f.log
   *   keep/keep.log
   * ```
   *
   * @returns 根目录与全部文件路径。
   */
  function tree(): { root: string; files: string[] } {
    const root = scratchDir('dsd-match-')
    const files: string[] = []
    const make = (rel: string): void => {
      const p = join(root, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, 'x')
      files.push(p)
    }
    for (const rel of ['a.log', 'b.log', 'c.txt', 'sub/d.log', 'sub/e.txt', 'sub/deep/f.log', 'keep/keep.log']) {
      make(rel)
    }
    return { root, files }
  }

  it('matches a simple extension pattern at one level', () => {
    const { root } = tree()
    const r = matchInTree({ root, pattern: '*.log' })
    expect(r.paths.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual(['a.log', 'b.log'])
  })

  it('matches recursively with ** slash prefix', () => {
    const { root } = tree()
    const r = matchInTree({ root, pattern: '**/*.log' })
    expect(r.paths).toHaveLength(5) // a, b, sub/d, sub/deep/f, keep/keep
  })

  it('matches several extensions with braces', () => {
    const { root } = tree()
    const r = matchInTree({ root, pattern: '**/*.{log,txt}' })
    expect(r.paths).toHaveLength(7) // 全部
  })

  it('never includes the root itself', () => {
    // 关键安全约束：写 root: C:\Work 时不该把 C:\Work 本身列为待删项。
    const { root } = tree()
    const r = matchInTree({ root, pattern: '**/*' })
    expect(r.paths).not.toContain(root)
  })

  it('returns nothing for a pattern that matches nothing', () => {
    const { root } = tree()
    const r = matchInTree({ root, pattern: '**/*.nope' })
    expect(r.paths).toHaveLength(0)
    expect(r.truncated).toBe(false)
  })

  it('matches everything when the pattern is omitted', () => {
    const { root } = tree()
    const r = matchInTree({ root })
    expect(r.paths).toHaveLength(7)
  })
})

describe('matchInTree: exclude', () => {
  it('excludes before matching, and skips whole subtrees', () => {
    const root = scratchDir('dsd-match-ex-')
    mkdirSync(join(root, 'keep'), { recursive: true })
    mkdirSync(join(root, 'drop'), { recursive: true })
    for (const rel of ['a.log', 'keep/k.log', 'drop/d.log']) {
      writeFileSync(join(root, rel), 'x')
    }

    const r = matchInTree({ root, pattern: '**/*.log', exclude: ['keep/**'] })
    const names = r.paths.map((p) => p.split(/[\\/]/).pop()).sort()
    expect(names).toEqual(['a.log', 'd.log'])
  })

  it('exclude wins over include', () => {
    const root = scratchDir('dsd-match-ex2-')
    writeFileSync(join(root, 'a.log'), 'x')
    writeFileSync(join(root, 'b.log'), 'x')
    const r = matchInTree({ root, pattern: '*.log', exclude: ['a.log'] })
    expect(r.paths.map((p) => p.split(/[\\/]/).pop())).toEqual(['b.log'])
  })
})

describe('matchInTree: olderThan', () => {
  it('only picks files older than the cutoff', () => {
    const root = scratchDir('dsd-match-time-')
    const oldFile = join(root, 'old.log')
    const newFile = join(root, 'new.log')
    writeFileSync(oldFile, 'x')
    writeFileSync(newFile, 'x')

    // 把 old.log 的 mtime 设到 10 天前。
    const tenDaysAgo = (Date.now() - 10 * 86400000) / 1000
    utimesSync(oldFile, tenDaysAgo, tenDaysAgo)

    const r = matchInTree({ root, pattern: '*.log', olderThanMs: 7 * 86400000 })
    expect(r.paths.map((p) => p.split(/[\\/]/).pop())).toEqual(['old.log'])
  })

  it('picks nothing when everything is newer than the cutoff', () => {
    const root = scratchDir('dsd-match-time2-')
    writeFileSync(join(root, 'fresh.log'), 'x')
    const r = matchInTree({ root, pattern: '*.log', olderThanMs: 7 * 86400000 })
    expect(r.paths).toHaveLength(0)
  })
})

describe('matchInTree: safety', () => {
  it('does not follow symlinks', () => {
    const root = scratchDir('dsd-match-link-')
    const outside = scratchDir('dsd-match-outside-')
    writeFileSync(join(outside, 'target.log'), 'x')
    writeFileSync(join(root, 'real.log'), 'x')

    // Windows 上创建符号链接需要权限，失败就跳过这条（不假装通过）。
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { symlinkSync } = require('node:fs') as typeof import('node:fs')
      symlinkSync(join(outside, 'target.log'), join(root, 'link.log'))
    } catch {
      console.log('本机不允许创建符号链接，跳过该断言')
      return
    }

    const r = matchInTree({ root, pattern: '*.log' })
    const names = r.paths.map((p) => p.split(/[\\/]/).pop())
    expect(names, '链接本身不该被删（那会删到外部文件）').not.toContain('link.log')
    expect(names).toContain('real.log')
  })

  it('reports how many entries it scanned', () => {
    const { root } = tree()
    const r = matchInTree({ root })
    expect(r.scanned, '应统计扫描过的条目数').toBeGreaterThan(0)
    expect(r.truncated).toBe(false)
  })

  function tree(): { root: string } {
    const root = scratchDir('dsd-match-scan-')
    writeFileSync(join(root, 'a.log'), 'x')
    writeFileSync(join(root, 'b.log'), 'x')
    return { root }
  }
})

describe('parseDuration', () => {
  it('parses minutes, hours and days', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000)
    expect(parseDuration('6h')).toBe(6 * 3_600_000)
    expect(parseDuration('7d')).toBe(7 * 86_400_000)
  })

  it('treats a bare number as days', () => {
    // 与 retentionDays 的语义一致，避免"写 7 被当成 7 毫秒"。
    expect(parseDuration('7')).toBe(7 * 86_400_000)
  })

  it('rejects garbage instead of guessing', () => {
    expect(parseDuration('abc')).toBeUndefined()
    expect(parseDuration('')).toBeUndefined()
    expect(parseDuration('-1d')).toBeUndefined()
    expect(parseDuration('7y')).toBeUndefined()
  })
})
