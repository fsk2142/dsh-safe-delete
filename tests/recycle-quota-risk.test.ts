import { describe, expect, it } from 'vitest'

import { detectQuotaRisk } from '../src/recycle'

/*
 * 单文件超回收站配额的检测（2026-11-04 审查 Important-9）。
 *
 * Windows 在条目超过回收站上限时**永久删除并返回成功**，插件无法感知。
 * 只能事前判断并问人。
 */
const MB = 1024 * 1024

describe('detectQuotaRisk', () => {
  it('flags a file larger than the smallest per-volume limit', () => {
    // 50 GB 上限 与 60 GB 文件 —— 真的超了。
    const reason = detectQuotaRisk(60_000 * MB, {
      platform: 'win32',
      listVolumeKeys: () => ['vol-a', 'vol-b'],
      readCapacityMb: () => 50_877,
    })

    expect(reason).toBeDefined()
    expect(reason).toMatch(/permanently/i)
  })

  it('stays quiet when the file fits', () => {
    const reason = detectQuotaRisk(10 * MB, {
      platform: 'win32',
      listVolumeKeys: () => ['vol-a'],
      readCapacityMb: () => 50_877,
    })

    expect(reason).toBeUndefined()
  })

  it('uses the smallest limit when volumes disagree', () => {
    // 一个卷 100 MB、另一个 1 MB —— 按最严的那个判。
    const reason = detectQuotaRisk(5 * MB, {
      platform: 'win32',
      listVolumeKeys: () => ['big', 'small'],
      readCapacityMb: (key) => (key === 'big' ? 100 : 1),
    })

    expect(reason).toBeDefined()
  })

  it('reports unknown when no limit can be read', () => {
    /*
     * 2026-11-05 第二轮复审 R02：这里原来断言 `undefined`（"不报风险"）。
     * 但"读不到上限"与"文件没超"的安全含义完全相反 —— 前者是**不知道**会不会
     * 被永久删除。现在改成返回说明，由上层按风险处理。
     */
    const reason = detectQuotaRisk(999 * MB, {
      platform: 'win32',
      listVolumeKeys: () => [],
      readCapacityMb: () => undefined,
    })

    expect(reason).toBeDefined()
    expect(reason).toMatch(/could not|cannot be verified/i)
  })

  it('does not throw when the registry read throws, and reports unknown', () => {
    const reason = detectQuotaRisk(999 * MB, {
      platform: 'win32',
      listVolumeKeys: () => ['vol'],
      readCapacityMb: () => {
        throw new Error('access denied')
      },
    })

    expect(reason, '读失败是未知，不是安全').toBeDefined()
    expect(reason).toMatch(/could not|cannot be verified/i)
  })

  it('is not applicable off Windows', () => {
    const reason = detectQuotaRisk(999 * MB, {
      platform: 'linux',
      listVolumeKeys: () => ['vol'],
      readCapacityMb: () => 1,
    })

    expect(reason).toBeUndefined()
  })
})
