import { describe, expect, it } from 'vitest'

import { __destinationFieldForTest, __fieldsForTest } from '../src/client/index'

describe('settings form fields', () => {
  it('offers the delete destination as two buttons, not a dropdown', () => {
    const field = __destinationFieldForTest()

    expect(field).toBeDefined()
    expect(field?.kind).toBe('choice')
    expect(field?.options?.map((o) => o.value)).toEqual(['safe-zone', 'recycle-bin'])
    expect(field?.options?.map((o) => o.label)).toEqual(['放入安全区', '直接进回收站'])
  })

  it('keeps the safety-relevant trade-off in the hint', () => {
    const field = __destinationFieldForTest()

    /*
     * 两种模式的**操作后果**必须写在用户看得到的地方。
     *
     * ## 2026-11-06 收紧了断言，但没有放松要求
     *
     * 原来这里断言 hint 里出现「统计」—— 那是实现手段，不是用户要做的决定。
     * 用户明确要求设置页"主要保留操作说明"，所以那句设计取舍（怎么统计、
     * 卡片显不显示总大小）挪去了 README。
     *
     * 但有一条**不能**跟着删：选「直接进回收站」就失去了「删太多先问一次」
     * 这层额外确认。那是用户在做这个选择时必须要知道的后果，属于操作说明，
     * 不属于设计文档。所以断言改成守住这一点。
     */
    expect(field?.hint, '必须说明取回要去哪儿').toMatch(/回收站/)
    expect(field?.hint, '必须说明还能不能取回').toMatch(/取回/)
    expect(field?.hint, '必须说明会失去额外确认').toMatch(/确认/)
  })

  it('keeps the numeric fields working', () => {
    const keys = __fieldsForTest().map((f) => f.key)
    expect(keys).toContain('retentionDays')
    expect(keys).toContain('confirmFileCount')
    expect(keys).toContain('confirmBytes')
  })
})
