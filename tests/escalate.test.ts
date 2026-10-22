import { describe, expect, it } from 'vitest'

import { appliesStop, recordDenial, resetDenials } from '../src/escalate'

/**
 * 重复拦截升级。
 *
 * 为什么需要它：模型是目标驱动的，被拦一次会换个姿势重试。同一条命令被拦
 * 三次以上时，问题通常不是"它没懂规则"，而是"它不接受这个结论" —— 这时
 * 只有明确的 STOP 才能让它把决定权交回人手上。
 */
describe('denial escalation', () => {
  it('does not escalate on the first or second denial of the same target', () => {
    resetDenials()
    expect(recordDenial('C:\\x')).toBe(1)
    expect(appliesStop('C:\\x')).toBe(false)
    expect(recordDenial('C:\\x')).toBe(2)
    expect(appliesStop('C:\\x')).toBe(false)
  })

  it('escalates on the third denial of the same target', () => {
    resetDenials()
    recordDenial('C:\\x')
    recordDenial('C:\\x')
    expect(recordDenial('C:\\x')).toBe(3)
    expect(appliesStop('C:\\x')).toBe(true)
  })

  it('counts targets independently', () => {
    resetDenials()
    recordDenial('C:\\a')
    recordDenial('C:\\a')
    expect(appliesStop('C:\\b')).toBe(false)
  })

  it('normalizes case so the same path is not evaded by recasing', () => {
    resetDenials()
    recordDenial('C:\\Work\\X')
    recordDenial('c:\\work\\x')
    recordDenial('C:\\WORK\\X')
    expect(appliesStop('c:\\Work\\x')).toBe(true)
  })
})
