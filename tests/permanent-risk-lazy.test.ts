import { describe, expect, it, vi } from 'vitest'

import { createPermanentDeleteRiskProvider, type PermanentDeleteRisk } from '../src/recycle'

describe('permanent-delete risk provider is lazy and TTL-cached', () => {
  it('does not probe until the first recycle-bin decision', () => {
    let calls = 0
    const detect = vi.fn((): PermanentDeleteRisk => {
      calls += 1
      return { status: 'safe', risky: false }
    })
    const provider = createPermanentDeleteRiskProvider({ detect, now: () => 1_000 })

    expect(calls).toBe(0)
    expect(provider().status).toBe('safe')
    expect(calls).toBe(1)
  })

  it('reuses a fresh result and refreshes it after the TTL', () => {
    let clock = 1_000
    let calls = 0
    const provider = createPermanentDeleteRiskProvider({
      detect: () => {
        calls += 1
        return { status: calls === 1 ? 'safe' : 'risky', risky: calls !== 1, reason: `read ${calls}` }
      },
      now: () => clock,
    })

    expect(provider().status).toBe('safe')
    clock += 59_999
    expect(provider().status).toBe('safe')
    expect(calls).toBe(1)

    clock += 1
    expect(provider().status).toBe('risky')
    expect(calls).toBe(2)
  })

  it('turns a thrown probe into a cached unknown result', () => {
    let calls = 0
    const provider = createPermanentDeleteRiskProvider({
      detect: () => {
        calls += 1
        throw new Error('registry blocked')
      },
      now: () => 1_000,
    })

    const first = provider()
    const second = provider()
    expect(first.status).toBe('unknown')
    expect(first.risky).toBe(false)
    expect(first.reason).toMatch(/registry blocked/)
    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  it('turns a thrown probe into a cached unknown result', () => {
    let calls = 0
    const provider = createPermanentDeleteRiskProvider({
      detect: () => {
        calls += 1
        throw new Error('registry blocked')
      },
      now: () => 1_000,
    })

    const first = provider()
    const second = provider()
    expect(first.status).toBe('unknown')
    expect(first.risky).toBe(false)
    expect(first.reason).toMatch(/registry blocked/)
    expect(second).toBe(first)
    expect(calls).toBe(1)
  })
})
