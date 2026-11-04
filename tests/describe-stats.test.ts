import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { describeTarget } from '../src/describe'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-describe-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('describeTarget stats option', () => {
  it('counts a directory recursively by default', () => {
    const dir = join(root, 'dir')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'aaaa')
    writeFileSync(join(dir, 'sub', 'b.txt'), 'bb')

    const d = describeTarget(dir)
    expect(d.isDirectory).toBe(true)
    expect(d.fileCount).toBe(2)
    expect(d.bytes).toBe(6)
    expect(d.statsOmitted).toBeUndefined()
  })

  it('skips recursion when stats is false and marks the omission', () => {
    const dir = join(root, 'dir')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'aaaa')
    writeFileSync(join(dir, 'sub', 'b.txt'), 'bb')

    const d = describeTarget(dir, { stats: false })
    expect(d.isDirectory).toBe(true)
    expect(d.fileCount).toBe(0)
    /*
     * 2026-11-04 第 24 次审查 R24-9：`bytes` 不再是 0。
     *
     * 回收站模式跳过递归统计是为了速度，但目录的 `bytes` 恒为 0 会让
     * **配额判定对目录永远失效** —— 而目录恰恰最容易超配额。
     *
     * 现在改成只量顶层直接子项（O(顶层数)，不递归）：这里顶层是 4 字节的文件。
     * 递归的 fileCount 仍然为 0（那才是真正贵的部分）。
     */
    expect(d.bytes, '顶层文件大小应被计入（配额判定要用）').toBe(4)
    expect(d.statsOmitted, '仍要标记统计不完整').toBe(true)
    expect(d.statsOmitted).toBe(true)
    // 顶层条目仍然要列出来，卡片靠它说明「里面有什么」。
    expect(d.topEntries).toContain('a.txt')
    expect(d.topEntries).toContain('sub')
  })

  it('reports a real size for a single file even when stats is false', () => {
    const file = join(root, 'big.bin')
    writeFileSync(file, 'x'.repeat(1024))

    const d = describeTarget(file, { stats: false })
    expect(d.isDirectory).toBe(false)
    expect(d.fileCount).toBe(1)
    expect(d.bytes).toBe(1024)
    expect(d.statsOmitted).toBeUndefined()
  })
})
