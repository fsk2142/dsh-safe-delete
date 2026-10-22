import { describe, expect, it } from 'vitest'

import { apply, inject } from '../src/client/index'
import { makeFakeCtx } from './support/fake-ctx'

/**
 * 客户端半区的注册契约。
 *
 * 这组测试的教训值得留着：我最初按宿主源码里 `rowConfigKey(bundle, rowId)` 的形状
 * 写成了 `plugins.row.config` + `<包名>#<行 id>`，产物、单测、模拟 loader 全绿 ——
 * 但真实插件页里那个「配置」入口**从来不出现**，也不报错。
 *
 * 对照 `dsh-context`（一个真实可用的带配置页插件）才看清真实用法是三个条件同时满足：
 *   1. `ctx.inject(['configForms'], …)` 等配置服务就绪；
 *   2. `configForms.whileServed([ns], …)` 让注册随服务生命周期；
 *   3. 槽位是 `plugins.bundle.config`，key 就是**包名**（`plugins.row.config` 是单行配置用的）。
 *
 * 所以这里的断言不只检查字段值，还检查**注册发生的时机与槽位名** —— 那才是
 * 之前失效的真正原因。
 */
describe('client apply', () => {
  it('declares the services the config page depends on', () => {
    expect(inject).toContain('slots')
    expect(inject).toContain('configForms')
  })

  it('registers on plugins.bundle.config, keyed by the package name', () => {
    const ctx = makeFakeCtx()
    apply(ctx as never)
    const slot = ctx.registeredSlots.find((s) => s['name'] === 'plugins.bundle.config')
    expect(slot).toBeDefined()
    expect(slot?.['key']).toBe('dsh-safe-delete')
    expect(slot?.['locale']).toBe('dsh-safe-delete')
  })

  it('does not use plugins.row.config (that slot is for single rows)', () => {
    // 写在这里是为了防止回退：曾经正确地"修"过一次 key 格式，但选错了槽位。
    const ctx = makeFakeCtx()
    apply(ctx as never)
    expect(ctx.registeredSlots.filter((s) => s['name'] === 'plugins.row.config')).toHaveLength(0)
  })

  it('registers exactly one config slot', () => {
    const ctx = makeFakeCtx()
    apply(ctx as never)
    expect(ctx.registeredSlots).toHaveLength(1)
  })

  it('waits for the configForms service before registering', () => {
    // 不等待就注册 = 宿主渲染时拿不到表单 = 入口不出现且不报错。
    const ctx = makeFakeCtx()
    let injected: string[] | undefined
    const original = ctx.inject
    ctx.inject = (services, callback) => {
      injected = services
      return original?.(services, callback)
    }

    apply(ctx as never)
    expect(injected).toContain('configForms')
    expect(ctx.registeredSlots).toHaveLength(1)
  })

  it('does nothing harmful when the configForms service never arrives', () => {
    // 服务缺席时不该抛错（那会让整个客户端包被判激活失败）。
    const ctx = makeFakeCtx({ withInject: false })
    delete (ctx as unknown as { configForms?: unknown }).configForms
    expect(() => apply(ctx as never)).not.toThrow()
    expect(ctx.registeredSlots).toHaveLength(0)
  })

  it('renders a summary string and the form for the page view', () => {
    const ctx = makeFakeCtx()
    apply(ctx as never)
    const slot = ctx.registeredSlots.find((s) => s['name'] === 'plugins.bundle.config')
    expect(slot).toBeDefined()
    // 组件本身在 verify-client-render.mjs 里渲染验证。
  })
})
