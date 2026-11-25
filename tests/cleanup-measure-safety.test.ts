import { describe, expect, it } from 'vitest'

import { measureDirectoryBytes } from '../src/cleanup-run'

describe('cleanup byte measurement fails closed', () => {
  it('propagates an unreadable child instead of counting it as zero', () => {
    const root = '/batch'
    const child = '/batch/child'
    const io = {
      readdirSync: (dir: string) => dir === root ? ['child'] : ['hidden'],
      lstatSync: (p: string) => ({
        isSymbolicLink: () => false,
        isDirectory: () => p !== child + '/hidden',
        size: p === child + '/hidden' ? 10 : 0,
      }),
    }

    expect(measureDirectoryBytes(root, io)).toBeUndefined()
  })

  it('does not follow a symbolic link or junction', () => {
    const io = {
      readdirSync: () => ['link'],
      lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => false, size: 42 }),
    }
    expect(measureDirectoryBytes('/batch', io)).toBe(42)
  })
})
