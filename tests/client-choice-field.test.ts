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

  it('explains the trade-off in the hint', () => {
    const field = __destinationFieldForTest()

    // 两种模式的代价必须写在用户看得到的地方。
    expect(field?.hint).toMatch(/统计/)
    expect(field?.hint).toMatch(/回收站/)
  })

  it('keeps the numeric fields working', () => {
    const keys = __fieldsForTest().map((f) => f.key)
    expect(keys).toContain('retentionDays')
    expect(keys).toContain('confirmFileCount')
    expect(keys).toContain('confirmBytes')
  })
})
