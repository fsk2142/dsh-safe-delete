import { describe, expect, it } from 'vitest'

import { safeZoneBytes, selectForPrune } from '../src/prune'
import type { TrashEntry } from '../src/types'

const DAY = 24 * 60 * 60 * 1000
const GB = 1024 ** 3

function entry(over: Partial<TrashEntry>): TrashEntry {
  return {
    id: 'id',
    originalPath: 'C:\\x',
    movedAt: 0,
    expiresAt: 0,
    bytes: 0,
    fileCount: 1,
    isDirectory: false,
    crossVolume: false,
    ...over,
  }
}

describe('selectForPrune', () => {
  it('selects entries past their expiry', () => {
    const entries = [entry({ id: 'old', expiresAt: 100 }), entry({ id: 'fresh', expiresAt: 1000 })]
    expect(selectForPrune(entries, { now: 500}).map((e) => e.id)).toEqual(['old'])
  })

  it('keeps everything when nothing expired and the cap is not exceeded', () => {
    const entries = [entry({ id: 'a', expiresAt: 1000, bytes: 10 })]
    expect(selectForPrune(entries, { now: 0})).toEqual([])
  })

  it('does NOT evict fresh entries for size any more', () => {
    /*
     * 这条测试记录一次**语义删除**。
     *
     * 旧实现有三层：时间 + 容量 + 提前阈值。容量层会在条目还没到期时把它推走，
     * 于是「删进去的东西可能立刻被清走，而提示仍写着可恢复 N 天」。
     * 现在容量层已从产品中移除，未过期的条目无论多大都不动。
     */
    const entries = [
      entry({ id: 'newest', expiresAt: 9e9, bytes: 50 * GB, movedAt: 300 }),
      entry({ id: 'oldest', expiresAt: 9e9, bytes: 50 * GB, movedAt: 100 }),
      entry({ id: 'middle', expiresAt: 9e9, bytes: 50 * GB, movedAt: 200 }),
    ]
    expect(selectForPrune(entries, { now: 0 }), '未过期就不该被容量推走').toEqual([])
    expect(safeZoneBytes(entries)).toBe(150 * GB)
  })

  it('returns expired entries oldest first', () => {
    const entries = [
      entry({ id: 'newest', expiresAt: 10, bytes: 1, movedAt: 300 }),
      entry({ id: 'oldest', expiresAt: 10, bytes: 1, movedAt: 100 }),
      entry({ id: 'middle', expiresAt: 10, bytes: 1, movedAt: 200 }),
    ]
    expect(selectForPrune(entries, { now: 100 }).map((e) => e.id)).toEqual(['oldest', 'middle', 'newest'])
  })

  it('never selects an entry twice when it is both expired and over the cap', () => {
    const entries = [entry({ id: 'only', expiresAt: 10, bytes: 90 * GB, movedAt: 1 })]
    expect(selectForPrune(entries, { now: 100}).map((e) => e.id)).toEqual(['only'])
  })

  it('measures age with the real day length rather than a magic number', () => {
    const entries = [entry({ id: 'justPast', expiresAt: 7 * DAY })]
    expect(selectForPrune(entries, { now: 7 * DAY - 1})).toEqual([])
    expect(selectForPrune(entries, { now: 7 * DAY + 1}).map((e) => e.id)).toEqual(['justPast'])
  })
})

describe('safeZoneBytes', () => {
  it('sums entry sizes', () => {
    expect(safeZoneBytes([entry({ bytes: 5 }), entry({ bytes: 7 })])).toBe(12)
  })

  it('is zero for an empty safe zone', () => {
    expect(safeZoneBytes([])).toBe(0)
  })
})
