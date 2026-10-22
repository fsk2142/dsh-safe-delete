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
    expect(selectForPrune(entries, { now: 500, maxBytes: 100 }).map((e) => e.id)).toEqual(['old'])
  })

  it('keeps everything when nothing expired and the cap is not exceeded', () => {
    const entries = [entry({ id: 'a', expiresAt: 1000, bytes: 10 })]
    expect(selectForPrune(entries, { now: 0, maxBytes: 100 })).toEqual([])
  })

  it('destroys oldest first until the safe zone fits the byte cap', () => {
    const entries = [
      entry({ id: 'newest', expiresAt: 9e9, bytes: 50 * GB, movedAt: 300 }),
      entry({ id: 'oldest', expiresAt: 9e9, bytes: 50 * GB, movedAt: 100 }),
      entry({ id: 'middle', expiresAt: 9e9, bytes: 50 * GB, movedAt: 200 }),
    ]
    const selected = selectForPrune(entries, { now: 0, maxBytes: 60 * GB })
    expect(selected.map((e) => e.id)).toEqual(['oldest', 'middle'])
    expect(safeZoneBytes(entries) - safeZoneBytes(selected)).toBeLessThanOrEqual(60 * GB)
  })

  it('never selects an entry twice when it is both expired and over the cap', () => {
    const entries = [entry({ id: 'only', expiresAt: 10, bytes: 90 * GB, movedAt: 1 })]
    expect(selectForPrune(entries, { now: 100, maxBytes: 10 * GB }).map((e) => e.id)).toEqual(['only'])
  })

  it('measures age with the real day length rather than a magic number', () => {
    const entries = [entry({ id: 'justPast', expiresAt: 7 * DAY })]
    expect(selectForPrune(entries, { now: 7 * DAY - 1, maxBytes: GB * 100 })).toEqual([])
    expect(selectForPrune(entries, { now: 7 * DAY + 1, maxBytes: GB * 100 }).map((e) => e.id)).toEqual(['justPast'])
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
