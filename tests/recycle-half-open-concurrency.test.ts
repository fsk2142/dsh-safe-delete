import { beforeEach, describe, expect, it } from 'vitest'

import {
  endRecycleProbe,
  recordRecycleFailure,
  recycleBreakerCooldownMs,
  recycleBreakerThreshold,
  resetRecycleBreaker,
  tryBeginRecycleProbe,
} from '../src/recycle'

describe('half-open recycle probe is mutually exclusive', () => {
  beforeEach(() => resetRecycleBreaker())

  it('allows only one probe after cooldown', () => {
    const threshold = recycleBreakerThreshold()
    for (let i = 0; i < threshold; i += 1) recordRecycleFailure()
    const now = Date.now() + recycleBreakerCooldownMs() + 1

    expect(tryBeginRecycleProbe(now)).toBe(true)
    for (let i = 0; i < 10; i += 1) expect(tryBeginRecycleProbe(now)).toBe(false)

    endRecycleProbe()
    expect(tryBeginRecycleProbe(now)).toBe(true)
    endRecycleProbe()
  })

  it('does not claim a probe while the breaker is still closed', () => {
    expect(tryBeginRecycleProbe()).toBe(true)
    expect(tryBeginRecycleProbe()).toBe(true)
  })
})
