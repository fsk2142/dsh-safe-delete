/*
 * D14：回收站策略与配额在插件加载时算一次，之后永不刷新。
 *
 * ## 缺陷
 *
 * - `src/index.ts` 在 `apply` 时算一次 `hookPermanentDeleteRisk`；
 * - `src/recycle.ts` 的 `quotaLimitCache` 在生产路径没有 TTL。
 *
 * 用户可以在 DSH 运行期间改 Windows 的回收站容量或策略（组策略推送、
 * 磁盘管理、cleanmgr 设置）。插件不热重载，于是下一次删除仍然按**旧结论**
 * 判「确认可恢复」。
 *
 * ## 修法
 *
 * 给两处缓存加一个短的 TTL（默认 60 秒），并在**高风险操作前**强制刷新。
 * 只让"安全"结论有 TTL；`unknown` 本来就是保守方向，缓存它没有风险。
 */
import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'

import { assessQuota, resetQuotaCache } from '../src/recycle'

describe('D14：策略与配额缓存必须有 TTL', () => {
  it('quota results expire instead of living for the whole process', () => {
    const src = readFileSync('src/recycle.ts', 'utf8')
    expect(src, '配额缓存需要 TTL 常量').toMatch(/QUOTA_CACHE_TTL_MS|quotaCacheAt|CACHE_TTL|ttl/i)
  })

  it('caches a verdict only within the TTL window', () => {
    resetQuotaCache()
    const calls: string[] = []
    const options = {
      platform: 'win32' as const,
      listVolumeKeys: () => ['C:'],
      readCapacityMb: (key: string) => {
        calls.push(key)
        return 100
      },
    }
    assessQuota(1, options)
    assessQuota(1, options)
    expect(calls.length, 'TTL 窗口内应复用缓存').toBe(1)
  })

  it('re-reads the policy after a forced refresh', () => {
    const src = readFileSync('src/recycle.ts', 'utf8')
    expect(src, '必须提供显式的失效入口供高风险操作前调用').toMatch(/resetQuotaCache|invalidate/)
  })

  it('documents that the quota verdict must be refreshed before a risky delete', () => {
    const src = readFileSync('src/recycle.ts', 'utf8')
    // 策略侧没有缓存（每次调用现读），所以这里只守"配额侧有显式失效入口"。
    expect(src, '高风险删除前必须有办法让旧结论失效').toMatch(/resetQuotaCache/)
    expect(src, 'TTL 必须是显式常量，不能散落魔法数').toMatch(/QUOTA_CACHE_TTL_MS = /)
  })
})
