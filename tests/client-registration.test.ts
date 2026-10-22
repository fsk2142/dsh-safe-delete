import { describe, expect, it } from 'vitest'

import { apply, inject } from '../src/client/index'
import { makeFakeCtx } from './support/fake-ctx'

/**
 * 客户端半区的注册契约。
 *
 * 为什么不放在 index.test.ts：槽位注册在**客户端**（`src/client/index.tsx`），
 * host 半区不碰 UI。之前我就是在这里想错了一层。
 */
describe('client apply', () => {
  it('declares the client services it needs', () => {
    expect(inject).toContain('slots')
  })

  it('registers the config slot under <package>#<row id>', () => {
    // 宿主按 `rowConfigKey(pkg.name, row.rowId)` 找行。key 写错不会报错 ——
    // 只是插件页里永远不出现「配置」入口，用户会以为插件根本没有设置项。
    const ctx = makeFakeCtx()
    apply(ctx as never)
    const slot = ctx.registeredSlots.find((s) => s['name'] === 'plugins.row.config')
    expect(slot).toBeDefined()
    // 包名与行 id 都是 dsh-safe-delete（见 cordis.patch.yml）。
    expect(slot?.['key']).toBe('dsh-safe-delete#dsh-safe-delete')
  })

  it('registers exactly one config slot', () => {
    const ctx = makeFakeCtx()
    apply(ctx as never)
    expect(ctx.registeredSlots.filter((s) => s['name'] === 'plugins.row.config')).toHaveLength(1)
  })
})
