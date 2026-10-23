import { describe, expect, it } from 'vitest'

import { apply } from '../src/index'

/**
 * `apply` 必须 **fail-soft**：任何宿主异常都不能抛回宿主。
 *
 * ## 为什么这条比"功能正确"更硬
 *
 * 用户报告过 DSH 崩溃后完全起不来、只能重置。排查后元凶是另一个插件
 * （`dsh-free-search` 在模块顶层 `import` 一个宿主已不再提供的包，
 * 加载即 `ERR_MODULE_NOT_FOUND`）。那次事故给出的判定标准很清楚：
 *
 * | 失败位置 | 后果 |
 * |---|---|
 * | 模块顶层 import 抛错 | **可能中断启动** —— 插件加载失败会传染 |
 * | `apply` 内抛错 | 有 try/catch，降级 |
 * | 钩子内抛错 | 只影响那一次工具调用 |
 *
 * 所以对**除顶层 import 之外**的每一层，我们都要证明它不会向上抛。
 * 顶层 import 无法 try/catch（ESM 语法），只能靠把依赖面压到最小。
 *
 * ## 这个测试在证明什么
 *
 * 不是"代码里有 try/catch"（那只说明意图），而是**逐个注入真实的坏宿主**，
 * 观察 `apply` 是否真的没抛。
 */

/** 假 ctx：每个成员都可注入异常。 */
function ctxWith(overrides: Record<string, unknown> = {}): unknown {
  return {
    get: () => undefined,
    on: () => () => {},
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    inject: (_s: string[], cb: (scoped: unknown) => void) => {
      cb({})
      return () => {}
    },
    ...overrides,
  }
}

/**
 * 跑一次 apply，返回是否抛错。
 *
 * @param ctx 假 ctx。
 * @returns 抛出的错误，未抛出则 undefined。
 */
function applyError(ctx: unknown): unknown {
  try {
    apply(ctx as never, {} as never)
    return undefined
  } catch (error) {
    return error
  }
}

describe('apply: fail-soft against a broken host', () => {
  it('does not throw when every ctx.get returns undefined', () => {
    expect(applyError(ctxWith())).toBeUndefined()
  })

  it('does not throw when ctx.get itself throws', () => {
    expect(
      applyError(
        ctxWith({
          get: () => {
            throw new Error('host service registry bug')
          },
        }),
      ),
    ).toBeUndefined()
  })

  it('does not throw when registering the hook fails', () => {
    // 注册钩子失败意味着拦截链装不上，但那是"少一层保护"，
    // 不该升级成"DSH 起不来"。
    expect(
      applyError(
        ctxWith({
          on: () => {
            throw new Error('hook registry broken')
          },
        }),
      ),
    ).toBeUndefined()
  })

  it('does not throw when ctx.effect throws', () => {
    expect(
      applyError(
        ctxWith({
          effect: () => {
            throw new Error('effect scope broken')
          },
        }),
      ),
    ).toBeUndefined()
  })

  it('does not throw for an empty ctx object', () => {
    // 连方法都不存在（不是"返回 undefined"，是"没有这个属性"）。
    expect(applyError({})).toBeUndefined()
  })

  it('does not throw for null or undefined ctx', () => {
    expect(applyError(null)).toBeUndefined()
    expect(applyError(undefined)).toBeUndefined()
  })

  it('does not throw for a garbage config', () => {
    const ctx = ctxWith()
    expect(() => apply(ctx as never, { retentionDays: 'not-a-number' } as never)).not.toThrow()
    expect(() => apply(ctx as never, null as never)).not.toThrow()
  })
})

describe('pre-execute hook: tolerates garbage input', () => {
  /**
   * 取真实钩子（走 apply 接线，不是自己造）。
   *
   * @returns 钩子数组。
   */
  function hooks(): Array<(exec: unknown, next: () => unknown) => unknown> {
    const collected: Array<(exec: unknown, next: () => unknown) => unknown> = []
    apply(
      {
        get: (id: string) => (id === 'tools' ? { register: () => () => {} } : undefined),
        on: (event: string, handler: unknown) => {
          if (event === 'tools/pre-execute') {
            collected.push(handler as (exec: unknown, next: () => unknown) => unknown)
          }
          return () => {}
        },
        effect: (fn: () => unknown) => {
          fn()
          return () => {}
        },
        inject: (_s: string[], cb: (scoped: unknown) => void) => {
          cb({})
          return () => {}
        },
      } as never,
      {} as never,
    )
    return collected
  }

  /** 一次性坏输入集合：形状全部不对，但都取自真实可能出现的畸形调用。 */
  const garbage: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['numeric name', { name: 123, arguments: {} }],
    ['null arguments', { name: 'safe_delete', arguments: null }],
    ['string arguments', { name: 'safe_delete', arguments: 'not-an-object' }],
    ['object path', { name: 'safe_delete', arguments: { path: {} } }],
    ['numeric paths', { name: 'safe_delete', arguments: { paths: 42 } }],
    ['garbage agent', { name: 'safe_delete', arguments: { path: 'C:\\x' }, agent: 'garbage' }],
    ['deeply nested junk', { name: 'safe_delete', arguments: { paths: [[[]]], path: null } }],
  ]

  for (const [label, exec] of garbage) {
    it(`does not throw for ${label}`, async () => {
      const hs = hooks()
      expect(hs.length, '接线应注册至少一个钩子').toBeGreaterThan(0)
      /*
       * 只断言"不抛错"，**不**断言返回值。
       *
       * 钩子返回 `undefined` 是合法的放行（调用 `next()` 之后本来就没有返回值）。
       * 我第一版写成 `resolves.toBeDefined()` 是错的 —— 那会把正常放行判成失败，
       * 是断言的问题，不是插件的问题。
       */
      await expect(hs[0]?.(exec, () => undefined)).resolves.toBeUndefined()
    })
  }
})
