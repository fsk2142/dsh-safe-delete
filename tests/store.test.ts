import { describe, expect, it } from 'vitest'

import { destroyEntry, listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { scratchDir } from './support/tmpdir'

const DAY = 24 * 60 * 60 * 1000

function scratch() {
  const root = scratchDir('dsd-store-')
  return { work: join(root, 'work'), state: join(root, 'state') }
}

describe('moveToSafeZone', () => {
  it('moves a file out of its original location and records it', async () => {
    const { work, state } = scratch()
    mkdirSync(work)
    const file = join(work, 'a.txt')
    writeFileSync(file, 'hello')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7, now: 0 })
    expect(existsSync(file)).toBe(false)
    expect(entry.originalPath).toBe(file)
    expect(entry.bytes).toBe(5)
    expect(entry.expiresAt).toBe(7 * DAY)
    expect(await listSafeZone(state)).toHaveLength(1)
  })

  it('moves a whole directory tree', async () => {
    const { work, state } = scratch()
    const dir = join(work, 'tree')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    const entry = await moveToSafeZone(state, dir, { retentionDays: 7 })
    expect(existsSync(dir)).toBe(false)
    expect(entry).toMatchObject({ isDirectory: true, fileCount: 1 })
  })

  it('keeps two entries when the same path is deleted twice', async () => {
    const { work, state } = scratch()
    const dir = join(work, 'twice')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'one')
    const first = await moveToSafeZone(state, dir, { retentionDays: 7 })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'two')
    const second = await moveToSafeZone(state, dir, { retentionDays: 7 })
    expect(first.id).not.toBe(second.id)
    expect(await listSafeZone(state)).toHaveLength(2)
  })

  it('refuses to move the safe zone into itself', async () => {
    const { state } = scratch()
    mkdirSync(state, { recursive: true })
    await expect(moveToSafeZone(state, state, { retentionDays: 7 })).rejects.toThrow(/safe zone/i)
  })
})

describe('restoreFromSafeZone', () => {
  it('restores to the original path', async () => {
    const { work, state } = scratch()
    mkdirSync(work)
    const file = join(work, 'a.txt')
    writeFileSync(file, 'hello')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })
    const { restoredTo } = await restoreFromSafeZone(state, entry.id)
    expect(restoredTo).toBe(file)
    expect(readFileSync(file, 'utf8')).toBe('hello')
    expect(await listSafeZone(state)).toHaveLength(0)
  })

  it('restores to a .restored sibling instead of overwriting an occupied path', async () => {
    const { work, state } = scratch()
    mkdirSync(work)
    const file = join(work, 'a.txt')
    writeFileSync(file, 'old')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })
    writeFileSync(file, 'new')
    const { restoredTo } = await restoreFromSafeZone(state, entry.id)
    expect(restoredTo).not.toBe(file)
    expect(readFileSync(restoredTo, 'utf8')).toBe('old')
    expect(readFileSync(file, 'utf8')).toBe('new')
  })

  it('rejects an unknown id', async () => {
    const { state } = scratch()
    await expect(restoreFromSafeZone(state, 'nope')).rejects.toThrow(/unknown/i)
  })
})

describe('destroyEntry', () => {
  it('removes the entry from disk and from the index', async () => {
    const { work, state } = scratch()
    mkdirSync(work)
    const file = join(work, 'a.txt')
    writeFileSync(file, 'hello')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })

    // **必须注入假回收器。** 不注入就会走真实的 Shell 调用：
    //   - 慢（一次约 1–20 秒，取决于系统状态）；
    //   - 偶发超时 → 测试变红但代码没问题（第九轮实测到过一次）；
    //   - 往用户真实回收站里扔东西。
    // 真实路径的行为由 scripts/verify-recycle-e2e.ts 覆盖，那里是显式的 e2e。
    //
    // 替身要**真的把内容移走**：`destroyEntry` 在 recycler 返回 ok 后只写索引，
    // 不负责删磁盘。替身什么都不做会留下孤儿目录，让测试的临时目录清理变成假象。
    await destroyEntry(state, entry.id, {
      recycler: (absPath) => {
        rmSync(absPath, { recursive: true, force: true })
        return { ok: true }
      },
    })
    expect(await listSafeZone(state)).toHaveLength(0)
  })
})
