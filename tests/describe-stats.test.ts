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
    expect(d.bytes).toBe(0)
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
