import { describe, expect, it } from 'vitest'

import { describeSpaceRisks, forecastSpace, type SpaceForecast } from '../src/delete-core'
import type { TargetDescription } from '../src/types'

/**
 * 空间风险预告。
 *
 * ## 为什么必须靠模拟
 *
 * 这两个场景在单盘设备上**无法真实复现**：
 *   - 安全区放不下（要求上限小于待删文件）
 *   - 跨盘复制（要求两个真实盘符，且目标盘空间紧张）
 *
 * 所以测试注入「已用字节」与「安全区路径」，用路径的盘符差异来驱动跨盘判定。
 * 这不是"假装跨盘"，而是**直接验证判定逻辑**：`path.parse().root` 不同即跨盘。
 */

/**
 * 造描述。
 *
 * @param bytes 大小。
 * @returns 目标描述。
 */
function desc(bytes: number): TargetDescription {
  return {
    bytes,
    fileCount: 1,
    isDirectory: false,
    topEntries: [],
    truncated: false,
    exists: true,
  } as TargetDescription
}

/** 构造一个"已用 X 字节"的读取器。 */
const used = (n: number) => async (): Promise<number> => n

describe('forecastSpace: safe zone capacity', () => {
  it('flags over-cap when the delete would exceed the cap', async () => {
    const f = await forecastSpace(
      desc(500),
      { stateDir: 'C:\\safe', safeZoneCapBytes: 1000, readSafeZoneUsageBytes: used(800) },
      'C:\\safe\\..\\file.bin',
    )
    // 800 + 500 = 1300 > 1000
    expect(f.overCap).toBe(true)
    expect(f.afterBytes).toBe(1300)
  })

  it('does not flag when it still fits', async () => {
    const f = await forecastSpace(
      desc(100),
      { stateDir: 'C:\\safe', safeZoneCapBytes: 1000, readSafeZoneUsageBytes: used(800) },
      'C:\\safe\\..\\file.bin',
    )
    expect(f.overCap).toBe(false)
  })

  it('treats an unset cap as no judgement', async () => {
    const f = await forecastSpace(desc(10 ** 12), { stateDir: 'C:\\safe', readSafeZoneUsageBytes: used(0) }, 'C:\\x')
    expect(f.overCap).toBe(false)
    expect(f.capBytes).toBeUndefined()
  })

  it('survives a failing usage read instead of blocking', async () => {
    // 读不到占用就按 0 算：宁可少提示一句，也不能因此拒绝删除。
    const f = await forecastSpace(
      desc(100),
      {
        stateDir: 'C:\\safe',
        safeZoneCapBytes: 1000,
        readSafeZoneUsageBytes: async () => {
          throw new Error('index unreadable')
        },
      },
      'C:\\safe\\..\\x',
    )
    expect(f.overCap).toBe(false)
    expect(f.afterBytes).toBe(100)
  })
})

describe('forecastSpace: cross-volume detection', () => {
  it('treats same-drive paths as NOT crossing', async () => {
    // 关键：开关打开并不代表真的会复制。同盘时是 rename，一个字节都不占。
    const f = await forecastSpace(
      desc(5000),
      { stateDir: 'C:\\safe', crossVolumeCopy: true },
      'C:\\Work\\data.bin',
    )
    expect(f.crossesVolumes).toBe(false)
    expect(f.copyBytes).toBe(0)
  })

  it('detects different drive letters', async () => {
    const f = await forecastSpace(
      desc(5000),
      { stateDir: 'C:\\safe', crossVolumeCopy: true },
      'D:\\data.bin',
    )
    expect(f.crossesVolumes).toBe(true)
    expect(f.copyBytes).toBe(5000)
  })

  it('reports the policy block when crossing without crossVolumeCopy', async () => {
    const f = await forecastSpace(desc(5000), { stateDir: 'C:\\safe' }, 'D:\\data.bin')
    expect(f.crossesVolumes).toBe(true)
    expect(f.blockedByPolicy, '跨盘且未开开关，会被直接拒绝').toBe(true)
  })

  it('does not report the policy block when the switch is on', async () => {
    const f = await forecastSpace(desc(5000), { stateDir: 'C:\\safe', crossVolumeCopy: true }, 'D:\\data.bin')
    expect(f.blockedByPolicy).toBe(false)
  })
})

describe('describeSpaceRisks: wording', () => {
  const base: SpaceForecast = {
    afterBytes: 0,
    overCap: false,
    crossesVolumes: false,
    copyBytes: 0,
    copyWillNotFit: false,
    blockedByPolicy: false,
  }

  it('says nothing when there is no risk (no gratuitous prompts)', () => {
    // 用户明确要求：没有风险就不要打扰。
    expect(describeSpaceRisks(base, 7)).toHaveLength(0)
  })

  it('explains the over-cap consequence honestly', () => {
    const risks = describeSpaceRisks({ ...base, overCap: true, capBytes: 1000, afterBytes: 5000 }, 7)
    expect(risks).toHaveLength(1)
    // 关键是说清"保留期承诺不适用"，而不是含糊地"可能被清理"。
    expect(risks[0]).toContain('recycle bin')
    expect(risks[0]).toContain('7-day')
  })

  it('warns that a cross-volume copy is not freed by pruning', () => {
    const risks = describeSpaceRisks({ ...base, crossesVolumes: true, copyBytes: 5000 }, 7)
    expect(risks[0]).toContain('crosses volumes')
    expect(risks[0], '要指出清理不会释放这份空间').toContain('does not free')
  })

  it('escalates when the copy will not fit', () => {
    const risks = describeSpaceRisks(
      { ...base, crossesVolumes: true, copyBytes: 5000, freeBytes: 100, copyWillNotFit: true },
      7,
    )
    expect(risks[0]).toContain('only')
    expect(risks[0]).toContain('free')
  })

  it('offers both ways out when crossVolumeCopy is off', () => {
    const risks = describeSpaceRisks({ ...base, crossesVolumes: true, blockedByPolicy: true }, 7)
    expect(risks[0]).toContain('crossVolumeCopy')
    // 与其让用户撞一条报错，不如说明两条出路。
    expect(risks[0]).toContain('move the safe zone')
  })
})
