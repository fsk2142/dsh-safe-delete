import { describe, expect, it } from 'vitest'

import { Config, unwrapConfig } from '../src/config'

/**
 * `.volatile()` 配置的读取。
 *
 * 为什么这个测试重要：`.volatile()` 字段是**引用**（`.get()`），不是普通值。
 * 如果插件直接拿它做 `> 0` / `!== undefined` 比较，结果恒为假 ——
 * 表现是「设置面板改了值，插件行为一点没变」，而且**不报错**。
 *
 * ## 默认值已经简化
 *
 * 容量相关的三个参数（`maxBytes` / `pruneAtPercent` / `autoPruneIntervalMs`）
 * 已从 schema 移除。保留期默认 **1 天**：安全区只是短暂缓冲，到期交给系统回收站。
 */

describe('config schema', () => {
  it('parses an empty config into the documented defaults', () => {
    const parsed = Config({})
    const values = unwrapConfig(parsed) as Record<string, unknown>
    expect(values['retentionDays']).toBe(1)
    expect(values['confirmFileCount']).toBe(5000)
    expect(values['confirmBytes']).toBe(2 * 1024 ** 3)
    expect(values['autoPrune']).toBe(true)
    expect(values['crossVolumeCopy']).toBe(false)
  })

  it('no longer exposes the capacity parameters', () => {
    // 这三个不是"默认值变了"，而是**从产品里移除了**。
    // 留一条断言，防止以后有人「顺手加回来」。
    const values = unwrapConfig(Config({})) as Record<string, unknown>
    expect(values['maxBytes']).toBeUndefined()
    expect(values['pruneAtPercent']).toBeUndefined()
    expect(values['autoPruneIntervalMs']).toBeUndefined()
  })

  it('exposes volatile fields as references that unwrapConfig resolves', () => {
    const parsed = Config({ confirmBytes: 1234 })
    const rawValue = (parsed as unknown as Record<string, unknown>)['confirmBytes']
    // 引用本身不是数字 —— 这就是为什么必须解包。
    expect(typeof rawValue).not.toBe('number')
    expect((rawValue as { get: () => unknown }).get()).toBe(1234)
    expect((unwrapConfig(parsed) as Record<string, unknown>)['confirmBytes']).toBe(1234)
  })

  it('declares retentionDays as volatile so the settings form can edit it', () => {
    /*
     * 宿主只在 settings 表单里暴露 `.volatile()` 字段。`retentionDays` 是从
     * 「固定 1 天」改成可编辑的，如果漏了 `.volatile()`，界面会**不显示**这个
     * 输入框 —— 而且不报错。
     *
     * 这条只看声明形态（是引用而不是裸数字），不看值。
     */
    const parsed = Config({ retentionDays: 5 })
    const raw = (parsed as unknown as Record<string, unknown>)['retentionDays']
    expect(typeof raw, 'retentionDays 必须是引用（.volatile()），否则界面改不了').not.toBe('number')
    expect((raw as { get: () => unknown }).get()).toBe(5)
    expect((unwrapConfig(parsed) as Record<string, unknown>)['retentionDays']).toBe(5)
  })

  it('keeps non-volatile fields as plain values', () => {
    const parsed = Config({})
    const rawValue = (parsed as unknown as Record<string, unknown>)['crossVolumeCopy']
    expect(typeof rawValue).toBe('boolean')
    expect(rawValue).toBe(false)
  })

  it('preserves an explicitly configured value over the default', () => {
    const parsed = Config({ retentionDays: 3, confirmFileCount: 0 })
    const values = unwrapConfig(parsed) as Record<string, unknown>
    expect(values['retentionDays']).toBe(3)
    // 0 是有效值（表示关闭该阈值），不能被默认值吃掉。
    expect(values['confirmFileCount']).toBe(0)
  })
})
