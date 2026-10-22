import { describe, expect, it, vi } from 'vitest'

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone } from '../src/store'

import { scratchDir } from './support/tmpdir'

/**
 * 跨卷降级路径的顺序正确性。
 *
 * 场景：`rename` 抛 EXDEV（安全区与目标不在同一卷），`crossVolumeCopy` 为真。
 * 此时「复制 → 登记索引 → 删源」的顺序是正确性的一部分：如果先删源再登记，
 * 登记失败就会留下「磁盘上没了、安全区索引里也没有」的孤儿数据。
 *
 * 这里通过伪造 EXDEV 来驱动该分支；`node:fs` 的部分函数被替换成受控实现。
 */
const realFs = await import('node:fs')

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      // 只让「把用户目标移进 items/<id>」这一步失败；索引的原子写
      // （tmp → index.json）必须照常工作，否则测不到这里关心的顺序。
      if (/[\\/]items[\\/]/.test(to)) {
        const error = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
        error.code = 'EXDEV'
        throw error
      }
      actual.renameSync(from, to)
    },
  }
})

describe('cross-volume fallback', () => {
  it('refuses by default and leaves the source untouched', async () => {
    const root = scratchDir('dsd-crossvol-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    const file = join(work, 'a.txt')
    writeFileSync(file, 'keep me')

    await expect(moveToSafeZone(state, file, { retentionDays: 7 })).rejects.toThrow(/different volumes/i)
    // 默认拒绝时，源必须原样还在。
    expect(existsSync(file)).toBe(true)
    expect(await listSafeZone(state)).toHaveLength(0)
  })

  it('copies, records the entry, and only then removes the source', async () => {
    const root = scratchDir('dsd-crossvol-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    const file = join(work, 'a.txt')
    writeFileSync(file, 'keep me')

    const entry = await moveToSafeZone(state, file, { retentionDays: 7, crossVolumeCopy: true })

    expect(entry.crossVolume).toBe(true)
    // 索引里有记录，源也确实被移走了 —— 两者必须同时成立。
    expect(await listSafeZone(state)).toHaveLength(1)
    expect(existsSync(file)).toBe(false)
    expect(realFs.existsSync(join(state, 'items', entry.id, 'a.txt'))).toBe(true)
  })
})
