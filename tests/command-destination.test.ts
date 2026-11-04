import { describe, expect, it } from 'vitest'

import { guideOf, parseSetting } from '../src/settings-guide'

describe('deleteDestination as a slash-command setting', () => {
  it('is listed with its own guide', () => {
    const guide = guideOf('deleteDestination')
    expect(guide).toBeDefined()
    expect(guide?.defaultValue).toBe('safe-zone')
  })

  it('accepts both destinations', () => {
    const guide = guideOf('deleteDestination')!
    expect(parseSetting(guide, 'safe-zone')).toEqual({ ok: true, value: 'safe-zone' })
    expect(parseSetting(guide, 'recycle-bin')).toEqual({ ok: true, value: 'recycle-bin' })
  })

  it('rejects an unknown destination and names the valid ones', () => {
    const guide = guideOf('deleteDestination')!
    const parsed = parseSetting(guide, 'recycle')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(/safe-zone/)
  })

  it('explains the trade-off in its summary', () => {
    const guide = guideOf('deleteDestination')!
    expect(guide.summary).toMatch(/回收站/)
  })
})
