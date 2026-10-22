import { describe, expect, it } from 'vitest'

import { Config, unwrapConfig } from '../src/config'

/**
 * `.volatile()` 配置的读取。
 *
 * 为什么这个测试重要：`.volatile()` 字段是**引用**（`.get()`），不是普通值。
 * 如果插件直接拿它做 `> 0` / `!== undefined` 比较，结果恒为假 ——
 * 表现是「设置面板改了值，插件行为一点没变」，而且**不报错**。
 */

describe('config schema', () => {
  it('parses an empty config into the documented defaults', () => {
    const parsed = Config({})
    const values = unwrapConfig(parsed) as Record<string, unknown>
    expect(values['retentionDays']).toBe(7)
    expect(values['maxBytes']).toBe(20 * 1024 ** 3)
    expect(values['pruneAtPercent']).toBe(90)
    expect(values['autoPruneIntervalMs']).toBe(60 * 60 * 1000)
    expect(values['confirmFileCount']).toBe(5000)
    expect(values['confirmBytes']).toBe(2 * 1024 ** 3)
    expect(values['autoPrune']).toBe(true)
  })

  it('exposes volatile fields as references that unwrapConfig resolves', () => {
    const parsed = Config({ maxBytes: 1234 })
    const rawValue = (parsed as unknown as Record<string, unknown>)['maxBytes']
    // 引用本身不是数字 —— 这就是为什么必须解包。
    expect(typeof rawValue).not.toBe('number')
    expect((rawValue as { get: () => unknown }).get()).toBe(1234)
    expect((unwrapConfig(parsed) as Record<string, unknown>)['maxBytes']).toBe(1234)
  })

  it('keeps non-volatile fields as plain values', () => {
    const parsed = Config({})
    const rawValue = (parsed as unknown as Record<string, unknown>)['crossVolumeCopy']
    expect(typeof rawValue).toBe('boolean')
    expect(rawValue).toBe(false)
  })

  it('preserves an explicitly configured value over the default', () => {
    const parsed = Config({ retentionDays: 30, confirmFileCount: 0, pruneAtPercent: 50 })
    const values = unwrapConfig(parsed) as Record<string, unknown>
    expect(values['retentionDays']).toBe(30)
    // 0 是有效值（表示关闭该阈值），不能被默认值吃掉。
    expect(values['confirmFileCount']).toBe(0)
    expect(values['pruneAtPercent']).toBe(50)
  })
})
