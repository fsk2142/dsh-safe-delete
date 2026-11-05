import { describe, expect, it } from 'vitest'

import { detectPermanentDeleteRisk } from '../src/recycle'

describe('detectPermanentDeleteRisk', () => {
  it('flags the policy when NoRecycleFiles is enabled', () => {
    const r = detectPermanentDeleteRisk({
      platform: 'win32',
      readRegistry: (_key, name) => (name === 'NoRecycleFiles' ? '1' : { kind: 'missing' }),
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
    /*
     * 2026-11-05 第三轮复审 R01：`undefined` 不再表示"值不存在"。
     * 想表达"确认没有这条策略"必须写 `{ kind: 'missing' }` —— 这样
     * "读不到"就没有任何办法被悄悄写成"不存在"。
     */
    const r = detectPermanentDeleteRisk({ platform: 'win32', readRegistry: () => ({ kind: 'missing' }) })
    expect(r.risky).toBe(false)
    expect(r.status).toBe('safe')
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

  it('does not throw when the registry is unreadable, and reports unknown', () => {
    const r = detectPermanentDeleteRisk({
      platform: 'win32',
      readRegistry: () => {
        throw new Error('access denied')
      },
    })
    expect(r.risky).toBe(false)
    // 读失败不是"确认安全"（第三轮复审 R01）。
    expect(r.status).toBe('unknown')
  })
})
