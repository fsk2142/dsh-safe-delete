import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { destroyEntry, listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 清理 = **移入系统回收站**，不是永久删除。
 *
 * 这是三层结构里的中间一层：
 *
 *   删除 → 安全区（保留期内 `safe_zone_restore`）
 *        → 到期 → **系统回收站**（用户清空之前都能还原）
 *        → 用户手动清空回收站 → 才真正消失
 *
 * 所以这里有一个压倒一切的不变量：**移入回收站失败时，绝不永久删除。**
 * 宁可占着磁盘，也不能在用户不知情的情况下把数据抹掉。
 */

const DAY = 24 * 60 * 60 * 1000

function setup() {
  const root = scratchDir('dsd-recycle-')
  const work = join(root, 'work')
  const state = join(root, 'state')
  mkdirSync(work, { recursive: true })
  return { root, work, state }
}

describe('destroyEntry routes through the recycle bin', () => {
  it('reports via="recycle" when the recycler succeeds', async () => {
    const { work, state } = setup()
    const file = join(work, 'a.txt')
    writeFileSync(file, 'x')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })

    const result = await destroyEntry(state, entry.id, {
      recycler: (absPath) => {
        // 替身把内容移走，模拟「进了回收站、原位置没了」。
        expect(existsSync(absPath)).toBe(true)
        return { ok: true }
      },
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.via).toBe('recycle')
    // 索引里该条目已移除。
    expect(await listSafeZone(state)).toHaveLength(0)
  })

  it('keeps the entry when the recycler fails', async () => {
    // 这是最重要的一条：回收站不可用时，文件必须留在安全区。
    const { work, state } = setup()
    const file = join(work, 'keep.txt')
    writeFileSync(file, 'precious')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })

    const result = await destroyEntry(state, entry.id, {
      recycler: () => ({ ok: false, reason: 'PowerShell unavailable' }),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('PowerShell')

    // 索引还在、磁盘内容还在 —— 一个都不能丢。
    const remaining = await listSafeZone(state)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(entry.id)
    expect(existsSync(join(state, 'items', entry.id))).toBe(true)
  })

  it('does not delete anything when the recycler is unsupported', async () => {
    const { work, state } = setup()
    const file = join(work, 'b.txt')
    writeFileSync(file, 'x')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })

    const result = await destroyEntry(state, entry.id, {
      recycler: () => ({ ok: false, reason: 'unsupported platform', unsupported: true }),
    })

    expect(result.ok).toBe(false)
    const items = existsSync(join(state, 'items')) ? readdirSync(join(state, 'items')) : []
    expect(items).toContain(entry.id)
  })

  it('only rmSyncs when explicitly told permanent', async () => {
    const { work, state } = setup()
    const file = join(work, 'c.txt')
    writeFileSync(file, 'x')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })

    const result = await destroyEntry(state, entry.id, { permanent: true })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.via).toBe('permanent')
    expect(existsSync(join(state, 'items', entry.id))).toBe(false)
  })

  it('clears a stale index row when the content is already gone', async () => {
    const { work, state } = setup()
    const file = join(work, 'd.txt')
    writeFileSync(file, 'x')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })
    // 手工删掉内容，模拟外部清理 / 崩溃残留。
    const { rmSync } = await import('node:fs')
    rmSync(join(state, 'items', entry.id), { recursive: true, force: true })

    const result = await destroyEntry(state, entry.id, {
      recycler: () => {
        throw new Error('should not be called when content is gone')
      },
    })
    expect(result.ok).toBe(true)
    expect(await listSafeZone(state)).toHaveLength(0)
  })
})

describe('auto-prune keeps entries it cannot recycle', () => {
  const toolOf = (list: ReturnType<typeof createTools>, name: string) => {
    const found = list.find((t) => t.name === name)
    if (!found) throw new Error(`missing tool ${name}`)
    return found
  }

  function deps(over: Partial<ToolDeps> = {}): ToolDeps {
    const root = scratchDir('dsd-noprune-')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    return {
      stateDir: join(root, 'state'),
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => 'allowed-once',
      retentionDays: 7,
      maxBytes: 20 * 1024 ** 3,
      ...over,
    }
  }

  it('leaves expired entries in place when recycling fails', async () => {
    let clock = 0
    const d = deps({
      now: () => clock,
      autoPruneIntervalMs: DAY,
      recycler: () => ({ ok: false, reason: 'recycle bin unavailable' }),
    })
    const dir = join(d.env.workdir, 'old')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    await moveToSafeZone(d.stateDir, dir, { retentionDays: 1, now: 0 })
    expect(await listSafeZone(d.stateDir)).toHaveLength(1)

    clock = 2 * DAY
    await toolOf(createTools(d), 'safe_zone_status').execute({})

    // 过期了，但回收站不可用 → 必须留着。
    expect(await listSafeZone(d.stateDir)).toHaveLength(1)
  })

  it('removes entries when recycling succeeds', async () => {
    let clock = 0
    const d = deps({
      now: () => clock,
      autoPruneIntervalMs: DAY,
      recycler: () => ({ ok: true }),
    })
    const dir = join(d.env.workdir, 'old')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    await moveToSafeZone(d.stateDir, dir, { retentionDays: 1, now: 0 })

    clock = 2 * DAY
    await toolOf(createTools(d), 'safe_zone_status').execute({})

    expect(await listSafeZone(d.stateDir)).toHaveLength(0)
  })
})
