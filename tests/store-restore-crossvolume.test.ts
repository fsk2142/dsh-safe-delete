import { describe, expect, it, vi } from 'vitest'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, restoreFromSafeZone } from '../src/store'

import { scratchDir } from './support/tmpdir'

/**
 * 跨卷**还原**路径（复审 M3 / N6）。
 *
 * 移入方向早就有「复制 + 删源」的回退，还原方向曾经只有裸 `rename` —— 跨卷时
 * 必抛 EXDEV，于是 `crossVolumeCopy` 造出来的条目**恰好全都取不回来**，与
 * 「可逆删除」的核心承诺直接矛盾。这个文件专门驱动那条回退分支。
 *
 * 为什么单独一个文件：`vi.mock('node:fs')` 是模块级的，同一文件里没法同时
 * 模拟两个方向的 EXDEV —— 移入方向的测试在 `store-crossvolume.test.ts`。
 */
const realFs = await import('node:fs')

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      // 只让「从 items/<id>/ 里把内容搬出去」这一步失败，模拟还原时跨卷。
      if (/[\\/]items[\\/]/.test(from) && !/[\\/]items[\\/]/.test(to)) {
        const error = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
        error.code = 'EXDEV'
        throw error
      }
      actual.renameSync(from, to)
    },
  }
})

describe('cross-volume restore', () => {
  it('copies the content back instead of failing on EXDEV', async () => {
    const root = scratchDir('dsd-restore-cv-')
    const state = join(root, 'state')
    const original = join(root, 'restored.txt')

    // 直接摆好一条「已经跨卷移入」的安全区条目。
    const id = '20261022-000000-testid'
    const itemDir = join(state, 'items', id)
    mkdirSync(itemDir, { recursive: true })
    writeFileSync(join(itemDir, 'restored.txt'), 'the original content')
    writeFileSync(
      join(state, 'index.json'),
      JSON.stringify(
        [
          {
            id,
            originalPath: original,
            movedAt: Date.now(),
            expiresAt: Date.now() + 86_400_000,
            bytes: 19,
            fileCount: 1,
            isDirectory: false,
            crossVolume: true,
          },
        ],
        null,
        2,
      ),
    )

    const result = await restoreFromSafeZone(state, id)

    // 内容必须真的回到原路径，且逐字节一致 —— 跨卷复制最容易出的是截断。
    expect(result.restoredTo).toBe(original)
    expect(existsSync(original)).toBe(true)
    expect(readFileSync(original, 'utf8')).toBe('the original content')

    // 索引里该条目应被移除；源目录也应清掉。
    expect(await listSafeZone(state)).toHaveLength(0)
    expect(realFs.existsSync(itemDir)).toBe(false)
  })

  it('still restores a directory across volumes', async () => {
    const root = scratchDir('dsd-restore-cv-dir-')
    const state = join(root, 'state')
    const original = join(root, 'restored-dir')

    const id = '20261022-000001-dirtest'
    const itemDir = join(state, 'items', id)
    mkdirSync(join(itemDir, 'restored-dir'), { recursive: true })
    writeFileSync(join(itemDir, 'restored-dir', 'inner.txt'), 'nested')
    writeFileSync(
      join(state, 'index.json'),
      JSON.stringify(
        [
          {
            id,
            originalPath: original,
            movedAt: Date.now(),
            expiresAt: Date.now() + 86_400_000,
            bytes: 6,
            fileCount: 1,
            isDirectory: true,
            crossVolume: true,
          },
        ],
        null,
        2,
      ),
    )

    await restoreFromSafeZone(state, id)

    expect(existsSync(join(original, 'inner.txt'))).toBe(true)
    expect(readFileSync(join(original, 'inner.txt'), 'utf8')).toBe('nested')
  })

  it('never leaves the content in limbo when the original path is occupied', async () => {
    // 原路径被占：还原到 `.restored-` 兄弟，绝不覆盖现有文件。
    const root = scratchDir('dsd-restore-cv-clash-')
    const state = join(root, 'state')
    const original = join(root, 'clash.txt')
    writeFileSync(original, 'current owner')

    const id = '20261022-000002-clash'
    const itemDir = join(state, 'items', id)
    mkdirSync(itemDir, { recursive: true })
    writeFileSync(join(itemDir, 'clash.txt'), 'old content')
    writeFileSync(
      join(state, 'index.json'),
      JSON.stringify([
        {
          id,
          originalPath: original,
          movedAt: Date.now(),
          expiresAt: Date.now() + 86_400_000,
          bytes: 11,
          fileCount: 1,
          isDirectory: false,
          crossVolume: true,
        },
      ]),
    )

    const result = await restoreFromSafeZone(state, id)

    expect(result.restoredTo).not.toBe(original)
    expect(result.restoredTo).toContain('.restored-')
    // 现有文件没被覆盖，旧内容在新位置上完整。
    expect(readFileSync(original, 'utf8')).toBe('current owner')
    expect(readFileSync(result.restoredTo, 'utf8')).toBe('old content')
  })
})
