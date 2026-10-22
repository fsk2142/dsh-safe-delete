import { describe, expect, it } from 'vitest'

import { effectiveCapBytes, safeZoneBytes, selectForPrune } from '../src/prune'
import type { TrashEntry } from '../src/types'

const GB = 1024 ** 3
const DAY = 24 * 60 * 60 * 1000

function entry(over: Partial<TrashEntry>): TrashEntry {
  return {
    id: 'id',
    originalPath: 'C:\\x',
    movedAt: 0,
    expiresAt: 99 * DAY,
    bytes: 0,
    fileCount: 1,
    isDirectory: false,
    crossVolume: false,
    ...over,
  }
}

describe('effectiveCapBytes', () => {
  it('uses the percentage when it is a sensible value', () => {
    expect(effectiveCapBytes({ now: 0, maxBytes: 1000, pruneAtPercent: 90 })).toBe(900)
    expect(effectiveCapBytes({ now: 0, maxBytes: 1000, pruneAtPercent: 50 })).toBe(500)
  })

  it('falls back to maxBytes when the percentage is missing or out of range', () => {
    expect(effectiveCapBytes({ now: 0, maxBytes: 1000 })).toBe(1000)
    expect(effectiveCapBytes({ now: 0, maxBytes: 1000, pruneAtPercent: 0 })).toBe(1000)
    expect(effectiveCapBytes({ now: 0, maxBytes: 1000, pruneAtPercent: 100 })).toBe(1000)
    expect(effectiveCapBytes({ now: 0, maxBytes: 1000, pruneAtPercent: -5 })).toBe(1000)
    expect(effectiveCapBytes({ now: 0, maxBytes: 1000, pruneAtPercent: Number.NaN })).toBe(1000)
  })
})

describe('early pruning at a percentage', () => {
  it('starts clearing at the threshold instead of waiting for the hard cap', () => {
    // 上限 10 GB，阈值 90% → 9 GB 就该动手。
    const entries = [
      entry({ id: 'old', bytes: 5 * GB, movedAt: 1 }),
      entry({ id: 'new', bytes: 5 * GB, movedAt: 2 }),
    ]
    const atTen = selectForPrune(entries, { now: 0, maxBytes: 10 * GB })
    // 没有阈值时：10 GB 正好等于上限，不清理。
    expect(atTen).toHaveLength(0)

    const atNinety = selectForPrune(entries, { now: 0, maxBytes: 10 * GB, pruneAtPercent: 90 })
    // 有阈值时：10 GB > 9 GB，清掉最旧的一条。
    expect(atNinety.map((e) => e.id)).toEqual(['old'])
  })

  it('keeps clearing oldest-first until it is under the threshold', () => {
    const entries = [
      entry({ id: 'a', bytes: 4 * GB, movedAt: 1 }),
      entry({ id: 'b', bytes: 4 * GB, movedAt: 2 }),
      entry({ id: 'c', bytes: 4 * GB, movedAt: 3 }),
    ]
    // 上限 10 GB、阈值 50% → 5 GB。清掉 a、b 后剩 4 GB，够了。
    const selected = selectForPrune(entries, { now: 0, maxBytes: 10 * GB, pruneAtPercent: 50 })
    expect(selected.map((e) => e.id)).toEqual(['a', 'b'])
    expect(safeZoneBytes(entries.filter((e) => !selected.includes(e)))).toBeLessThanOrEqual(5 * GB)
  })

  it('still prunes expired entries first regardless of the percentage', () => {
    const entries = [
      entry({ id: 'expired', bytes: 1, movedAt: 1, expiresAt: 10 }),
      entry({ id: 'fresh', bytes: 1, movedAt: 2, expiresAt: 99 * DAY }),
    ]
    const selected = selectForPrune(entries, { now: 100, maxBytes: 10 * GB, pruneAtPercent: 90 })
    expect(selected.map((e) => e.id)).toEqual(['expired'])
  })

  it('does not prune when the safe zone is already below the threshold', () => {
    const entries = [entry({ id: 'only', bytes: 1 * GB, movedAt: 1 })]
    expect(selectForPrune(entries, { now: 0, maxBytes: 10 * GB, pruneAtPercent: 90 })).toHaveLength(0)
  })
})
