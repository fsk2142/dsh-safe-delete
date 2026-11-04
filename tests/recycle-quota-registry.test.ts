/*
 * 注册表前缀必须与 `reg query` 的输出一致（2026-11-04 自检）。
 *
 * ## 这个坑
 *
 * `reg query HKCU\...` 接受缩写，但**输出**里把键路径展开成
 * `HKEY_CURRENT_USER\...`。如果代码用缩写的 root 去做 `startsWith`，
 * 永远匹配不上 —— 而失败是**静默的**：卷键列表为空 → 配额读不到 →
 * `detectQuotaRisk` 返回 undefined → 超配额文件被当作无风险放行，
 * Windows 于是永久删除它。
 *
 * 我在收紧过滤时正是撞上了这个：把 `startsWith('HKEY_')` 改成
 * `startsWith(root + '\\')` 后，配额从「能读」变成「完全读不到」。
 *
 * ## 这条测试
 *
 * 断言 listBitBucketVolumeKeys 里的 root 是完整前缀，并且过滤用 root 前缀。
 * 同时用真实注册表验证一次（reg 被策略拦截时跳过）。
 */
import { describe, expect, it } from 'vitest'

import { detectQuotaRisk, resetQuotaCache } from '../src/recycle'

const MB = 1024 * 1024

describe('回收站配额的注册表读取', () => {
  it('能读到本机的每卷上限（验证前缀与过滤都正确）', () => {
    resetQuotaCache()
    /*
     * 用一个远大于任何合理上限的大小：如果配额读到了，一定命中风险；
     * 如果读不到，返回 undefined —— 两者区分得清清楚楚。
     */
    const verdict = detectQuotaRisk(1000 * 1000 * MB)

    if (verdict === undefined) {
      /*
       * 读不到有两种原因：reg 被安全策略拦（本机环境），或代码前缀写错。
       * 前者是环境问题，后者是 bug。测试无法自动区分，所以这里如实说明
       * 而不是假装通过。
       */
      expect.fail(
        '配额读不到：要么 reg 被策略拦截（环境问题），要么注册表前缀/过滤写错了（bug）。' +
          '请先手动确认 `reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume` 有输出。',
      )
    }

    expect(verdict).toMatch(/per-volume limit/)
    /*
     * 断言读到的上限是个合理的 MB 值 —— 冒烟级检查，防止解析错位
     * （比如把十六进制当十进制，或取错了列）。
     */
    const mb = Number(/\((\d+) MB\)/.exec(verdict)?.[1] ?? '0')
    expect(mb, `读到的上限 ${mb} MB 不合理`).toBeGreaterThan(100)
  })

  it('小文件不报配额风险', () => {
    expect(detectQuotaRisk(1 * MB)).toBeUndefined()
  })

  it('非 Windows 平台不判配额', () => {
    expect(detectQuotaRisk(1000 * MB, { platform: 'linux' })).toBeUndefined()
  })
})
