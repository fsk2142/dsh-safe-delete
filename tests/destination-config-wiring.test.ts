import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/*
 * 接线断言：配置必须真的从 `index.ts` 流到工具依赖。
 *
 * ## 为什么用静态断言（2026-11-04 审查 Important-10）
 *
 * `destination-wiring.test.ts` 声称验证「配置 → deps」，但它直接把
 * `destination` 塞进 `createTools` —— 中间那一跳（index.ts 读配置并传递）
 * 从没被测过。上一版的 `permanentDeleteRisk` 就是这样漏的。
 *
 * 静态断言不依赖测试自己注入的字段，删掉接线就会红。
 */
describe('destination wiring from config', () => {
  it('index.ts passes destination into the tool deps', () => {
    const src = readFileSync('src/index.ts', 'utf8')
    expect(src).toMatch(/destination:\s*normalizeDestination\(unwrap\(raw\['deleteDestination'\]\)\)/)
  })

  it('tools.ts forwards destination into the delete context', () => {
    const src = readFileSync('src/tools.ts', 'utf8')
    expect(src).toMatch(/deps\.destination/)
  })

  it('config schema declares deleteDestination with the right default', () => {
    const src = readFileSync('src/config.ts', 'utf8')
    expect(src).toMatch(/deleteDestination/)
    expect(src).toMatch(/recycle-bin/)
    // 默认必须是安全区：那是「删除可反悔」的那条路。
    expect(src).toMatch(/default\(['"]safe-zone['"]\)/)
  })
})
