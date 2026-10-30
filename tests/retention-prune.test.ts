import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { selectForPrune, safeZoneBytes } from '../src/prune'
import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'
import type { TrashEntry } from '../src/types'

/**
 * 安全区的清理策略：**只按保留期**。
 *
 * ## 曾经的三层，现在的一层
 *
 * 旧实现有「时间 + 容量 + 提前阈值」三层，参数互相影响，用户无法预判一次删除的
 * 后果。更糟的是：删进去的东西可能因为"超上限"被**立刻**推走，而提示仍写着
 * 可恢复 N 天 —— 承诺与实际不符。
 *
 * 现在只剩一条规则：**进安全区的条目，保留期一到就移入系统回收站。**
 * 没有容量上限，没有百分比，没有检查间隔。
 *
 * ## 「到期」不等于「准点」
 *
 * 没有后台定时器（那会让插件在 DSH 空闲时保有生命周期）。清理在每次
 * `safe_zone_*` 工具调用时顺路发生。所以保留期是"最早"，不是"恰好"。
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/**
 * 造条目。
 *
 * @param id 标识。
 * @param bytes 字节数。
 * @param ageMs 移入至今毫秒。
 * @param retentionDays 保留天数。
 * @returns 条目。
 */
function entry(id: string, bytes: number, ageMs: number, retentionDays = 1): TrashEntry {
  const movedAt = Date.now() - ageMs
  return {
    id,
    originalPath: `/tmp/${id}`,
    bytes,
    movedAt,
    expiresAt: movedAt + retentionDays * DAY,
    fileCount: 1,
    isDirectory: false,
    crossVolume: false,
    reason: 'test',
  }
}

describe('selectForPrune: retention only', () => {
  it('picks entries past their expiry', () => {
    const old = entry('old', 100, 2 * DAY)
    const fresh = entry('fresh', 100, HOUR)
    expect(selectForPrune([old, fresh], { now: Date.now() }).map((e) => e.id)).toEqual(['old'])
  })

  it('never picks fresh entries, however large', () => {
    // 关键差异：旧实现会因为"超容量"把未到期的大条目推走。现在不会。
    const huge = entry('huge', 100 * 1024 ** 3, HOUR) // 100 GB，1 小时前
    expect(selectForPrune([huge], { now: Date.now() })).toHaveLength(0)
  })

  it('returns oldest first', () => {
    const a = entry('a', 1, 3 * DAY)
    const b = entry('b', 1, 2 * DAY)
    expect(selectForPrune([b, a], { now: Date.now() }).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('keeps zero-byte entries until they expire', () => {
    // 0 字节条目曾因容量循环提前退出而漏选；现在只有一条规则，不存在这个边界。
    expect(selectForPrune([entry('empty', 0, HOUR)], { now: Date.now() })).toHaveLength(0)
    expect(selectForPrune([entry('empty', 0, 2 * DAY)], { now: Date.now() })).toHaveLength(1)
  })

  it('handles an empty safe zone', () => {
    expect(selectForPrune([], { now: Date.now() })).toHaveLength(0)
  })

  it('sums bytes for status display', () => {
    expect(safeZoneBytes([entry('a', 10, 0), entry('b', 5, 0)])).toBe(15)
  })
})

describe('prune timing', () => {
  /**
   * 建工具集。
   *
   * @param over 覆盖项。
   * @returns ToolDeps。
   */
  function deps(over: Partial<ToolDeps> = {}): ToolDeps {
    const root = scratchDir('dsd-retention-')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    return {
      stateDir: join(root, 'state'),
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => 'allowed-once',
      retentionDays: 1,
      recycler: (p: string) => {
        const { rmSync } = require('node:fs') as typeof import('node:fs')
        rmSync(p, { recursive: true, force: true })
        return { ok: true as const }
      },
      ...over,
    }
  }

  it('moves an expired entry to the recycle bin on the next tool call', async () => {
    let clock = Date.now()
    const d = deps({ now: () => clock })
    const file = join(d.env.workdir, 'a.txt')
    writeFileSync(file, 'x')
    await moveToSafeZone(d.stateDir, file, { retentionDays: 1 })

    const status = createTools(d).find((t) => t.name === 'safe_zone_status')
    if (status === undefined) throw new Error('missing status')

    await status.execute({})
    expect(await listSafeZone(d.stateDir), '未到期应保留').toHaveLength(1)

    clock += 2 * DAY

    /*
     * 到期后的清理现在跑在独立子进程里，工具调用不再同步等它完成。
     * 这里直接驱动 worker 执行体验证清理逻辑本身。
     *
     * 必须显式传时钟与回收替身：
     *   - 不传 `now` 会用真实时间，条目"刚移入"不算过期；
     *   - 不传 recycler 会真的往系统回收站扔东西。
     */
    const { pruneNowForWorker } = await import('../src/cleanup-run')
    await pruneNowForWorker(d.stateDir, 100, () => ({ ok: true }), () => clock)
    expect(await listSafeZone(d.stateDir), '到期后应已移入回收站').toHaveLength(0)
  })

  it('does not prune when autoPrune is off', async () => {
    let clock = Date.now()
    const d = deps({ now: () => clock, autoPrune: false })
    const file = join(d.env.workdir, 'a.txt')
    writeFileSync(file, 'x')
    await moveToSafeZone(d.stateDir, file, { retentionDays: 1 })

    clock += 2 * DAY
    const status = createTools(d).find((t) => t.name === 'safe_zone_status')
    if (status === undefined) throw new Error('missing status')
    await status.execute({})
    expect(await listSafeZone(d.stateDir), '关掉自动清理后应保留').toHaveLength(1)
  })

  it('states the timing honestly in status output', async () => {
    // 用户必须知道清理不是准点同步的，而是后台任务。
    const tools = createTools(deps())
    const status = tools.find((t) => t.name === 'safe_zone_status')
    if (status === undefined) throw new Error('missing status')
    const r = await status.execute({})
    expect(r.text).toContain('time-only, no capacity cap')
    expect(r.text).toContain('cleanup:')
    expect(r.text).toContain('recycle bin')
  })
})
