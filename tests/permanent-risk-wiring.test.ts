import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/*
 * 接线测试：`detectPermanentDeleteRisk` 必须真的被调用，而不是写好了放着。
 *
 * ## 为什么用静态断言（2026-11-04 审查 Critical-1）
 *
 * 上一版的 `destination` 接线缺口就是这样漏掉的：单元测试直接往 ctx 里塞字段，
 * 于是「配置 → deps → ctx」这条链从没被测过。
 *
 * 这里直接断言源码里有这条调用 —— 一旦有人删掉接线，测试立刻红。
 * 静态断言比行为测试更可靠：它不依赖测试自己注入的字段。
 */
describe('permanent-delete risk wiring', () => {
  it('index.ts actually calls detectPermanentDeleteRisk', () => {
    const src = readFileSync('src/index.ts', 'utf8')
    expect(src).toMatch(/detectPermanentDeleteRisk\s*\(/)
  })

  it('index.ts passes the risk into the tool deps', () => {
    const src = readFileSync('src/index.ts', 'utf8')
    expect(src).toMatch(/permanentDeleteRisk/)
  })

  it('tools.ts forwards the risk into the delete context', () => {
    const src = readFileSync('src/tools.ts', 'utf8')
    expect(src).toMatch(/permanentDeleteRisk/)
  })

  it('the batch route consults the risk too', () => {
    const src = readFileSync('src/tools.ts', 'utf8')
    // deleteMany 里必须出现这个判断，否则「删几千个」那条路依然静默。
    expect(src).toMatch(/permanentDeleteRisk\?\.risky/)
  })
})
