import { describe, expect, it } from 'vitest'

import { describeSpaceRisks, forecastSpace, type SpaceForecast } from '../src/delete-core'
import type { TargetDescription } from '../src/types'

/**
 * 跨卷删除的空间风险。
 *
 * ## 只剩一件事要判断
 *
 * v0.3.0 移除了容量层，所以不再有"会不会撑爆安全区"的判定。剩下的真实风险是：
 *
 *   1. `crossVolumeCopy` 关着而源与安全区**真的**跨盘 → 删除会被拒绝；
 *   2. 开着但目标盘放不下 → 复制中途失败。
 *
 * 另外要分清"跨盘"与"开关打开"：**同盘时即使开关打开也不会复制**，
 * 一个字节都不占。按开关误报"将占用 X GB"比不报更糟。
 *
 * ## 为什么靠模拟
 *
 * 单盘设备无法真实复现跨盘。这里用路径的盘符差异驱动判定——`path.parse().root`
 * 不同即跨盘，这正是生产代码的判断依据，所以测的是真逻辑而非替身。
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

describe('forecastSpace: cross-volume detection', () => {
  it('treats same-drive paths as NOT crossing, even with the switch on', async () => {
    // 关键：开关打开不等于真的会复制。同盘是 rename，不占额外空间。
    const f = await forecastSpace(desc(5000), { stateDir: 'C:\\safe', crossVolumeCopy: true }, 'C:\\Work\\data.bin')
    expect(f.crossesVolumes).toBe(false)
    expect(f.copyBytes).toBe(0)
  })

  it('detects different drive letters', async () => {
    const f = await forecastSpace(desc(5000), { stateDir: 'C:\\safe', crossVolumeCopy: true }, 'D:\\data.bin')
    expect(f.crossesVolumes).toBe(true)
    expect(f.copyBytes).toBe(5000)
  })

  it('reports the policy block when crossing without the switch', async () => {
    const f = await forecastSpace(desc(5000), { stateDir: 'C:\\safe' }, 'D:\\data.bin')
    expect(f.crossesVolumes).toBe(true)
    expect(f.blockedByPolicy, '跨盘且未开开关，会被直接拒绝').toBe(true)
  })

  it('does not report the policy block when the switch is on', async () => {
    const f = await forecastSpace(desc(5000), { stateDir: 'C:\\safe', crossVolumeCopy: true }, 'D:\\data.bin')
    expect(f.blockedByPolicy).toBe(false)
  })

  it('never blocks when source and safe zone share a volume', async () => {
    const f = await forecastSpace(desc(10 ** 12), { stateDir: 'C:\\safe' }, 'C:\\huge.bin')
    expect(f.crossesVolumes).toBe(false)
    expect(f.blockedByPolicy).toBe(false)
    expect(f.copyWillNotFit).toBe(false)
  })
})

describe('describeSpaceRisks: wording', () => {
  const base: SpaceForecast = {
    crossesVolumes: false,
    copyBytes: 0,
    copyWillNotFit: false,
    blockedByPolicy: false,
  }

  it('says nothing when there is no risk (no gratuitous prompts)', () => {
    // 用户明确要求：没有风险就不要打扰。
    expect(describeSpaceRisks(base)).toHaveLength(0)
  })

  it('warns that a cross-volume copy is not freed by pruning', () => {
    const risks = describeSpaceRisks({ ...base, crossesVolumes: true, copyBytes: 5000 })
    expect(risks[0]).toContain('crosses volumes')
    expect(risks[0], '要指出清理不会释放这份空间').toContain('does not free')
  })

  it('escalates when the copy will not fit', () => {
    const risks = describeSpaceRisks({
      ...base,
      crossesVolumes: true,
      copyBytes: 5000,
      freeBytes: 100,
      copyWillNotFit: true,
    })
    expect(risks[0]).toContain('only')
    expect(risks[0]).toContain('free')
  })

  it('offers both ways out when crossVolumeCopy is off', () => {
    const risks = describeSpaceRisks({ ...base, crossesVolumes: true, blockedByPolicy: true })
    expect(risks[0]).toContain('crossVolumeCopy')
    // 与其让用户撞一条报错，不如说明两条出路。
    expect(risks[0]).toContain('move the safe zone')
  })

  it('no longer mentions any capacity cap', () => {
    // 容量层已移除，任何风险文案都不该再提"上限/撑爆"。
    const all = [
      ...describeSpaceRisks({ ...base, crossesVolumes: true, copyBytes: 1 }),
      ...describeSpaceRisks({ ...base, crossesVolumes: true, copyBytes: 1, copyWillNotFit: true, freeBytes: 0 }),
      ...describeSpaceRisks({ ...base, crossesVolumes: true, blockedByPolicy: true }),
    ]
    for (const text of all) {
      expect(text.toLowerCase()).not.toContain('cap')
      expect(text.toLowerCase()).not.toContain('over its')
    }
  })
})
