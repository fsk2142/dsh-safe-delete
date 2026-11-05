/*
 * 配额上限只读一次（2026-11-04 自检）。
 *
 * ## 这个测试防的是什么
 *
 * `deleteMany` 对每个文件调 `detectQuotaRisk`。如果每次都读注册表，
 * 实测 162.8ms/次 —— 删 1000 个文件要 163 秒，删 5000 个要 13.6 分钟。
 * 那正是用户抱怨的「大量删除卡顿」。
 *
 * 上限在运行期不会变，所以读一次就够。这条测试锁住「不随文件数增长」。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { detectQuotaRisk, resetQuotaCache } from '../src/recycle'

const MB = 1024 * 1024

beforeEach(() => {
  resetQuotaCache()
})

describe('detectQuotaRisk 的调用成本', () => {
  it('判 N 个文件只读一次注册表', () => {
    let listCalls = 0
    let readCalls = 0
    const options = {
      platform: 'win32' as const,
      listVolumeKeys: () => {
        listCalls += 1
        return ['vol-a']
      },
      readCapacityMb: () => {
        readCalls += 1
        return 50_877
      },
    }

    for (let i = 0; i < 200; i += 1) detectQuotaRisk(60_000 * MB, options)

    expect(listCalls, `列卷读取次数不该随文件数增长，实际 ${listCalls}`).toBe(1)
    expect(readCalls, `容量读取次数不该随文件数增长，实际 ${readCalls}`).toBe(1)
  })

  it('缓存后判断结果仍正确', () => {
    // 100 MB 上限
    const options = {
      platform: 'win32' as const,
      listVolumeKeys: () => ['vol-a'],
      readCapacityMb: () => 100,
    }

    expect(detectQuotaRisk(200 * MB, options), '超限应命中').toBeDefined()
    expect(detectQuotaRisk(50 * MB, options), '未超限应放行').toBeUndefined()
    expect(detectQuotaRisk(101 * MB, options), '略超应命中').toBeDefined()
  })

  it('读不到上限时报 unknown，且不反复重试', () => {
    let listCalls = 0
    const options = {
      platform: 'win32' as const,
      listVolumeKeys: () => {
        listCalls += 1
        return []
      },
      readCapacityMb: () => undefined,
    }

    for (let i = 0; i < 10; i += 1) {
      /*
       * 2026-11-05 第二轮复审 R02：读不到上限不再是"无风险"（undefined），
       * 而是 unknown —— 返回一句说明，让上层按风险处理。
       */
      expect(detectQuotaRisk(999 * MB, options)).toBeDefined()
    }
    expect(listCalls, '读不到也只该试一次').toBe(1)
  })
})
