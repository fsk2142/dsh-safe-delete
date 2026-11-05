/*
 * 2026-11-05 自检（提交后）：三态重构引入的**加载期崩溃**。
 *
 * ## 缺陷
 *
 * 第三轮复审 R01 把 `RegistryReader` 的返回类型从 `string | undefined` 收窄成
 * `RegistryReadResult | string` —— `undefined` 不再被接受。类型层做到了"读不到
 * 不能被写成不存在"，但**运行时**没有兜住漏网的 `undefined`：
 *
 * ```text
 * detectPermanentDeleteRisk()
 *   -> raw = read(key, 'NoRecycleFiles')   // 某个实现仍返回 undefined
 *   -> raw.kind                            // TypeError
 * ```
 *
 * ## 为什么这是 P1 而不是小事
 *
 * `detectPermanentDeleteRisk()` 是在 `applyInner()` 里第 281 行**同步**调用的，
 * 而那一步排在最前面 —— 在它之后才有：
 *
 * ```text
 * 281  detectPermanentDeleteRisk()   ← 抛在这里
 * 339  createTools(...)              ← 装不上
 * 364  registry.register(tool)       ← safe_delete 不存在
 * 924  on('tools/pre-execute', ...)  ← 拦截钩子没注册
 * ```
 *
 * `apply()` 本身是 fail-soft 的（try/catch + 记日志），所以宿主**不会**崩 ——
 * 但插件会变成完全无效：`safe_delete` 没注册，拦截线也没接上。用户看到的是
 * "插件装了但什么都不管"，而宿主原生删除照常工作。
 *
 * 也就是说，一个**保护性检查**的崩溃让保护完全消失：比它想修的那个 fail-open
 * 更糟 —— fail-open 至少还留着安全区，这里什么都不留，而且只在日志里留一行。
 *
 * 这正是本项目反复出现的失败形态：**失败是静默的**。
 *
 * ## 修法
 *
 * 运行时**接受**任何形态的返回值，把不能识别的都判成 `unknown`：
 *
 * - 字符串 → value（旧测试的便利写法）
 * - `{kind:'missing'}` → missing
 * - `{kind:'error'}` → unknown
 * - `undefined` / `null` / 其它对象 / 数字 → **unknown**
 *
 * 类型层仍然要求判别式类型（写代码时就挡住），运行时再兜一层。两层不是重复：
 * 一层防"写错"，一层防"加载崩"。这个插件的核心断言是**绝不能因为自己的
 * 内部问题而停止保护**。
 */
import { describe, expect, it } from 'vitest'

import { detectPermanentDeleteRisk } from '../src/recycle'

describe('自检：不可识别的读取结果必须判 unknown，不能抛错', () => {
  it('does not throw when a reader returns undefined', () => {
    // 直接绕过类型（模拟 JS 调用方 / 旧版本注入的适配器）。
    const read = (() => undefined) as never

    let result: ReturnType<typeof detectPermanentDeleteRisk>
    expect(() => {
      result = detectPermanentDeleteRisk({ platform: 'win32', readRegistry: read })
    }, '返回 undefined 不能把 apply() 炸掉').not.toThrow()

    expect(result!.status, '读不到 ≠ 确认安全').toBe('unknown')
    expect(result!.risky).toBe(false)
  })

  it('does not throw for null, numbers, or arbitrary objects', () => {
    for (const weird of [null, 0, 42, {}, { foo: 'bar' }, [], true]) {
      const read = (() => weird) as never
      expect(
        () => detectPermanentDeleteRisk({ platform: 'win32', readRegistry: read }),
        `返回值 ${JSON.stringify(weird)} 不能把 apply() 炸掉`,
      ).not.toThrow()
      const r = detectPermanentDeleteRisk({ platform: 'win32', readRegistry: read })
      expect(r.status, `返回值 ${JSON.stringify(weird)} 只能是 unknown`).toBe('unknown')
    }
  })

  it('still understands the recognised shapes', () => {
    expect(detectPermanentDeleteRisk({ platform: 'win32', readRegistry: (() => '1') as never }).status).toBe('risky')
    expect(
      detectPermanentDeleteRisk({ platform: 'win32', readRegistry: (() => ({ kind: 'missing' })) as never }).status,
    ).toBe('safe')
    expect(
      detectPermanentDeleteRisk({
        platform: 'win32',
        readRegistry: (() => ({ kind: 'error', reason: 'denied' })) as never,
      }).status,
    ).toBe('unknown')
    expect(
      detectPermanentDeleteRisk({
        platform: 'win32',
        readRegistry: (() => ({ kind: 'value', value: '0' })) as never,
      }).status,
    ).toBe('safe')
  })

  it('keeps the crash away from the boot path by coercing, not by catching', async () => {
    /*
     * ## 这条测的是"崩溃点被搬走了"，不是"apply 还能跑"
     *
     * 第一版写的是"调 apply() 断言 pre-execute 注册了"。它**在修复前也通过** ——
     * 因为 `apply()` 用的是真实注册表读取器，在这台机器上读得好好的，根本走不到
     * 那条崩溃分支。那就是一条空转的测试，留着只会让人以为覆盖到了。
     *
     * 真正的不变量是更具体的：`detectPermanentDeleteRisk` 的**调用点排在
     * `createTools()`（339）和 `on('tools/pre-execute')`（924）之前**，所以它
     * 绝不能抛 —— 而这个"不能抛"必须是**函数自己**保证的，不能指望外层 try/catch。
     *
     * 原因：`apply()` 的 fail-soft 会把整个 `applyInner` 吞掉，于是 `safe_delete`
     * 不注册、拦截钩子不接上，失败只在日志里留一行。静默失效。
     *
     * 所以这条测试直接把最坏输入喂给函数本身，并断言返回的是一个合法的三态，
     * 而不是抛出。
     */
    const { detectPermanentDeleteRisk: detect } = await import('../src/recycle')

    const worst = [() => undefined, () => null, () => ({ kind: 'value' }), () => ({ kind: 'error' })]
    for (const read of worst) {
      const r = detect({ platform: 'win32', readRegistry: read as never })
      // 必须是三态之一，且 risky 只在 risky 时为真。
      expect(['safe', 'risky', 'unknown'], `${String(read)} 必须收敛成三态`).toContain(r.status)
      expect(r.risky).toBe(r.status === 'risky')
    }
  })

  it('would throw if the call site ever moved above the guard', async () => {
    /*
     * 把"为什么这件事要紧"变成可执行的证据：`applyInner` 里
     * `detectPermanentDeleteRisk()` 必须先于 `createTools()` 与钩子注册。
     *
     * 如果哪天有人把这次调用挪到后面，崩溃的影响面会变小 —— 那时这条测试会红，
     * 提醒改注释与断言，而不是让文档悄悄失真。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/index.ts', 'utf8')

    const detectAt = src.indexOf('const hookPermanentDeleteRisk = detectPermanentDeleteRisk()')
    const createToolsAt = src.indexOf('const tools: ToolDefinition[] = createTools({')
    const hookAt = src.indexOf("'tools/pre-execute'")

    expect(detectAt, '应能找到风险检测的调用点').toBeGreaterThan(0)
    expect(createToolsAt, '应能找到工具创建').toBeGreaterThan(0)
    expect(hookAt, '应能找到钩子注册').toBeGreaterThan(0)

    // 检测排在最前面 —— 这正是"它抛错就什么都装不上"的原因。
    expect(detectAt).toBeLessThan(createToolsAt)
    expect(detectAt).toBeLessThan(hookAt)
  })
})
