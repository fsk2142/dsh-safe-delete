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

    const result = await destroyEntry(state, entry.id, {
      permanent: { reason: 'test: explicit permanent deletion', confirmedByUser: true },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.via).toBe('permanent')
    expect(existsSync(join(state, 'items', entry.id))).toBe(false)
  })

  it('rejects a permanent request without user confirmation', async () => {
    /*
     * 2026-10-30 的教训：`permanent: true` 这个布尔开关太容易顺手写上。
     * 那次我用它把 1086 MB 永久删掉了，而用户的真实意图是"移进回收站"。
     *
     * 现在要求显式的 `confirmedByUser` 与 `reason` —— 缺一个就拒绝，
     * 而不是"默认按更彻底的做"。
     */
    const { work, state } = setup()
    const file = join(work, 'd.txt')
    writeFileSync(file, 'x')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })

    await expect(
      destroyEntry(state, entry.id, {
        // 类型上就不允许省略 confirmedByUser；这里强转模拟"忘了写"的调用方。
        permanent: { reason: 'test' } as unknown as { reason: string; confirmedByUser: true },
      }),
    ).rejects.toThrow(/confirmedByUser/)

    // 内容必须还在 —— 拒绝要发生在删除之前。
    expect(existsSync(join(state, 'items', entry.id)), '拒绝时不该删内容').toBe(true)
  })

  it('rejects a permanent request without a reason', async () => {
    const { work, state } = setup()
    const file = join(work, 'e.txt')
    writeFileSync(file, 'x')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })

    await expect(
      destroyEntry(state, entry.id, {
        permanent: { reason: '   ', confirmedByUser: true },
      }),
    ).rejects.toThrow(/reason/)
    expect(existsSync(join(state, 'items', entry.id))).toBe(true)
  })

  it('defaults to the recycle bin when permanent is omitted', async () => {
    // 不传 permanent 就走回收站 —— 这是默认且可恢复的路径。
    const { work, state } = setup()
    const file = join(work, 'f.txt')
    writeFileSync(file, 'x')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })

    let called = 0
    const result = await destroyEntry(state, entry.id, {
      recycler: () => {
        called += 1
        return { ok: true }
      },
    })
    expect(called, '不传 permanent 应调用回收站').toBe(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.via).toBe('recycle')
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
      ...over,
    }
  }

  it('leaves expired entries in place when recycling fails', async () => {
    let clock = 0
    const d = deps({
      now: () => clock,
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
      recycler: () => ({ ok: true }),
    })
    const dir = join(d.env.workdir, 'old')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    await moveToSafeZone(d.stateDir, dir, { retentionDays: 1, now: 0 })

    clock = 2 * DAY

    /*
     * 直接驱动 worker 的执行体。
     *
     * 自动清理现在跑在独立子进程里，从工具调用入口无法同步观察结果 ——
     * 那正是修掉事故的关键（工具调用不再等清理）。所以这里测的是
     * **worker 内部逻辑**：给定过期条目，它确实回收并把索引清干净。
     */
    const { pruneNowForWorker } = await import('../src/cleanup-run')
    /*
     * 必须传 recycler 替身：省略它会走真实 `moveToSystemRecycleBin`
     * （PowerShell，约 1 秒/次），既慢、又真的往系统回收站扔东西。
     */
    const result = await pruneNowForWorker(d.stateDir, 100, () => ({ ok: true }))

    expect(result.recycled, '应回收 1 条').toBe(1)
    expect(result.skipped).toBe(0)
    expect(await listSafeZone(d.stateDir), '索引应清空').toHaveLength(0)
  })
})
