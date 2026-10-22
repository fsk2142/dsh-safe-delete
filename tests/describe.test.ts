import { describe, expect, it } from 'vitest'

import { describeTarget } from '../src/describe'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { scratchDir } from './support/tmpdir'

function scratch(): string {
  return scratchDir('dsd-describe-')
}

describe('describeTarget', () => {
  it('reports a missing path without throwing', () => {
    const result = describeTarget(join(scratch(), 'nope'))
    expect(result.exists).toBe(false)
  })

  it('reports a single file size', () => {
    const dir = scratch()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x'.repeat(1234))
    const result = describeTarget(file)
    expect(result).toMatchObject({ exists: true, isDirectory: false, bytes: 1234, fileCount: 1 })
  })

  it('counts nested files and bytes in a directory', () => {
    const dir = scratch()
    const nested = join(dir, 'sub')
    mkdirSync(nested)
    writeFileSync(join(dir, 'a.txt'), 'x'.repeat(100))
    writeFileSync(join(nested, 'b.txt'), 'x'.repeat(200))
    const result = describeTarget(dir)
    expect(result).toMatchObject({ exists: true, isDirectory: true, bytes: 300, fileCount: 2 })
  })

  it('lists at most the first 20 top-level entries and flags truncation', () => {
    const dir = scratch()
    for (let i = 0; i < 25; i += 1) writeFileSync(join(dir, `f${i}.txt`), 'x')
    const result = describeTarget(dir)
    expect(result.topEntries).toHaveLength(20)
    expect(result.truncated).toBe(true)
  })
})
