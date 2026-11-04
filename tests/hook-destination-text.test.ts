import { describe, expect, it } from 'vitest'

import { buildInterceptReason } from '../src/index'

const base = {
  resolved: ['C:\\x\\dir'],
  fileCount: 42,
  bytes: 1024,
  reasons: ['it is under your home directory'],
  retentionDays: 7,
}

describe('buildInterceptReason', () => {
  it('promises a retention window in safe-zone mode', () => {
    const text = buildInterceptReason({ ...base, destination: 'safe-zone' })
    expect(text).toMatch(/safe zone/i)
    expect(text).toMatch(/7 days/)
  })

  it('promises the recycle bin and no retention window in recycle-bin mode', () => {
    const text = buildInterceptReason({ ...base, destination: 'recycle-bin' })
    expect(text).toMatch(/recycle bin/i)
    expect(text).not.toMatch(/7 days/)
  })

  it('does not claim a file count when the walk was skipped', () => {
    const text = buildInterceptReason({
      ...base,
      destination: 'recycle-bin',
      statsOmitted: true,
    })
    // 统计被跳过时不能报「42 entries」这种看似精确的数字。
    expect(text).not.toMatch(/42 entries/)
  })
})
