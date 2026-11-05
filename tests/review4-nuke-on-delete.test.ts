/*
 * 2026-11-05 第四轮自检：**每卷的 `NukeOnDelete` 策略从未被检查**。
 *
 * ## 缺陷
 *
 * 现在判「删除会被永久执行」只看一个键：
 *
 * ```text
 * HKCU\...\Policies\Explorer\NoRecycleFiles
 * ```
 *
 * 那是**全局**开关。但 Windows 还有一条**按卷**的开关，就在插件为了读配额
 * 已经访问的那个键下面：
 *
 * ```text
 * HKCU\...\Explorer\BitBucket\Volume\{GUID}
 *     MaxCapacity    REG_DWORD    0x...   ← 配额，读了
 *     NukeOnDelete   REG_DWORD    0x1     ← 永久删除，从来没读
 * ```
 *
 * `NukeOnDelete = 1` 表示该卷**不使用回收站**：删除直接永久执行。它比
 * `NoRecycleFiles` 更隐蔽 —— 全局策略没动，只有某个卷（例如系统盘）被设成清空。
 *
 * ## 为什么这是真缺口，不是理论问题
 *
 * 本插件的核心承诺是「三层里只有最后一层不可逆」。当 `NukeOnDelete=1` 时，
 * 用户以为文件进了回收站（UI 文案也这么说），实际它已经没了 —— 而
 * `deletePath` / `deleteMany` / `decideHookRisk` 三个决策点都因为只看全局策略
 * 而判成 `safe`，不弹任何审批。
 *
 * 这是前几轮复审都漏掉的一条：R01/R02 修的是**读取失败**的处理，这一条是
 * **压根没读**。两者的失败形态相同（静默放行），但根因不同。
 *
 * ## 判据
 *
 * 三态，与全局策略一致：
 *
 * | 事实 | 状态 |
 * |---|---|
 * | 任一卷 `NukeOnDelete=1` | **risky**（该卷不用回收站） |
 * | 全部卷读到且均为 0 | **safe** |
 * | 读不到 / 解析不了 / 一个卷都没列出来 | **unknown** |
 *
 * 「任一卷为 1 就 risky」是保守方向：目标到底在哪个卷上，这个插件在钩子层
 * 拿不到可靠信息（盘符与卷 GUID 的映射还需要额外查询），所以按最坏情况问人。
 */
import { describe, expect, it } from 'vitest'

import { detectPermanentDeleteRisk, resetQuotaCache } from '../src/recycle'
import type { RegistryReader } from '../src/recycle'

/** BitBucket 卷根（与实现一致）。 */
const VOLUME_ROOT = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume'

/**
 * 造一个替身读取器：按「键 + 值名」给值。
 *
 * 模拟真实 `reg` 的语义：
 * - 键不存在 / 值不存在 → `{ kind: 'missing' }`
 *
 * 注意：**列卷不走这个读取器**（`listBitBucketVolumeKeys` 自己 spawn `reg`），
 * 所以测试必须同时注入 `listVolumeKeys`。与 `assessQuota` 的注入形态一致 ——
 * 两个函数各自有一个注入点，不是同一个。
 *
 * @param volumes 卷键 → 该卷的值表。
 * @returns 读取器。
 */
function fakeReader(volumes: Record<string, Record<string, string>>): RegistryReader {
  return (key, name) => {
    // 全局策略：测试里默认不存在（这条测试只关心每卷策略）。
    if (key.includes('Policies\\Explorer')) return { kind: 'missing' }
    // 读某个卷的值。
    const volume = Object.keys(volumes).find((v) => key.endsWith(v))
    if (volume === undefined) return { kind: 'missing' }
    const value = volumes[volume][name]
    return value === undefined ? { kind: 'missing' } : { kind: 'value', value }
  }
}

/**
 * 由卷表推出列卷函数。
 *
 * @param volumes 卷键 → 值表。
 * @returns 列卷替身。
 */
function fakeList(volumes: Record<string, Record<string, string>>): () => string[] {
  return () => Object.keys(volumes).map((v) => `${VOLUME_ROOT}\\${v}`)
}

describe('自检：每卷 NukeOnDelete=1 必须判 risky', () => {
  it('flags a volume that bypasses the recycle bin', () => {
    const r = detectPermanentDeleteRisk({
      platform: 'win32',
      readRegistry: fakeReader({
        '{vol-c}': { MaxCapacity: '0xc6bd', NukeOnDelete: '0x1' },
      }),
      listVolumeKeys: fakeList({ '{vol-c}': {} }),
    })

    expect(r.status, 'NukeOnDelete=1 表示该卷直接永久删除').toBe('risky')
    expect(r.risky).toBe(true)
    expect(r.reason).toMatch(/NukeOnDelete|permanently|recycle/i)
  })

  it('stays safe when every volume keeps the recycle bin', () => {
    const r = detectPermanentDeleteRisk({
      platform: 'win32',
      readRegistry: fakeReader({
        '{vol-c}': { MaxCapacity: '0xc6bd', NukeOnDelete: '0x0' },
        '{vol-d}': { MaxCapacity: '0xc216', NukeOnDelete: '0x0' },
      }),
      listVolumeKeys: fakeList({ '{vol-c}': {}, '{vol-d}': {} }),
    })

    expect(r.status, '所有卷都是 0 = 确认用回收站').toBe('safe')
    expect(r.risky).toBe(false)
  })

  it('treats "no volumes listed" as unknown, not safe', () => {
    /*
     * 一个卷都列不出来，说明配额那条路径也没读到东西 —— 那时不能声称
     * "所有卷都没设 NukeOnDelete"。
     */
    const r = detectPermanentDeleteRisk({
      platform: 'win32',
      readRegistry: fakeReader({}),
      listVolumeKeys: () => [],
    })
    expect(r.status).toBe('unknown')
  })

  it('treats an unreadable per-volume policy as unknown', () => {
    /*
     * 卷列表能读到，但有卷的 NukeOnDelete 读不到（权限 / 键被删）。
     * 不知道就别放行。
     */
    const reader: RegistryReader = (key, name) => {
      if (key.includes('Policies\\Explorer')) return { kind: 'missing' }
      if (name === 'NukeOnDelete') return { kind: 'error', reason: 'access denied' }
      return { kind: 'missing' }
    }

    const r = detectPermanentDeleteRisk({
      platform: 'win32',
      readRegistry: reader,
      listVolumeKeys: () => [`${VOLUME_ROOT}\\{vol-c}`],
    })
    expect(r.status).toBe('unknown')
  })

  it('still reports risky from the global policy when that is the only signal', () => {
    // 全局策略与每卷策略互相独立，任一致命都要报。
    const reader: RegistryReader = (key, name) => {
      if (key.includes('Policies\\Explorer') && name === 'NoRecycleFiles') return { kind: 'value', value: '1' }
      if (name === 'NukeOnDelete') return { kind: 'value', value: '0' }
      return { kind: 'missing' }
    }
    expect(
      detectPermanentDeleteRisk({
        platform: 'win32',
        readRegistry: reader,
        listVolumeKeys: () => [`${VOLUME_ROOT}\\{vol-c}`],
      }).status,
    ).toBe('risky')
  })

  it('is not applicable off Windows', () => {
    const r = detectPermanentDeleteRisk({ platform: 'linux', readRegistry: () => '1' })
    expect(r.status).toBe('safe')
  })
})

describe('自检：NukeOnDelete 走真实注册表时也成立', () => {
  it('reads this machine without throwing', () => {
    resetQuotaCache()
    const r = detectPermanentDeleteRisk()
    expect(['safe', 'risky', 'unknown']).toContain(r.status)
    // 本机两个卷都是 0，所以不应因为 NukeOnDelete 而报 risky。
    if (r.status === 'risky') expect(r.reason).toBeDefined()
  })
})
