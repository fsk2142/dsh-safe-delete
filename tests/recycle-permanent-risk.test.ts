import { describe, expect, it } from 'vitest'

import { detectPermanentDeleteRisk } from '../src/recycle'

describe('detectPermanentDeleteRisk', () => {
  it('flags the policy when NoRecycleFiles is enabled', () => {
    const r = detectPermanentDeleteRisk({
      platform: 'win32',
      readRegistry: (_key, name) => (name === 'NoRecycleFiles' ? '1' : undefined),
    })

    expect(r.risky).toBe(true)
    expect(r.reason).toMatch(/NoRecycleFiles/)
  })

  it('treats the textual value as enabled too', () => {
    const r = detectPermanentDeleteRisk({
      platform: 'win32',
      readRegistry: () => 'true',
    })
    expect(r.risky).toBe(true)
  })

  it('stays quiet when the policy is absent', () => {
    const r = detectPermanentDeleteRisk({ platform: 'win32', readRegistry: () => undefined })
    expect(r.risky).toBe(false)
  })

  it('stays quiet when the policy is explicitly disabled', () => {
    const r = detectPermanentDeleteRisk({
      platform: 'win32',
      readRegistry: () => '0',
    })
    expect(r.risky).toBe(false)
  })

  it('stays quiet on other platforms', () => {
    const r = detectPermanentDeleteRisk({ platform: 'linux', readRegistry: () => '1' })
    expect(r.risky).toBe(false)
  })

  it('does not throw when the registry is unreadable', () => {
    const r = detectPermanentDeleteRisk({
      platform: 'win32',
      readRegistry: () => {
        throw new Error('access denied')
      },
    })
    expect(r.risky).toBe(false)
  })
})
