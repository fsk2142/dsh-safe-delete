/*
 * 2026-11-05 第二轮复审 R02：注册表读不到时不能当成"确认安全"。
 *
 * ## 问题
 *
 * `detectPermanentDeleteRisk` 在 `read()` **抛错**时返回 `{ risky: false }`，
 * 注释理由是"不能因为一次读注册表失败就拦住所有删除"。但那是把两种完全不同
 * 的状态混成了一个布尔：
 *
 *   - **确认安全**：读到了，值不是 1；
 *   - **无法确认**：读失败 / 值解析不了 / 根本没读到键。
 *
 * 旧代码把后者也报成 `risky: false`，而 `risky: false` 的下游动作是
 * **不问、直接进回收站**（可能是永久删除）。这就是 fail-open：保护性检查
 * 只是停止保护，不抛错、不打日志。
 *
 * HANDOVER 里那句「读不到注册表 → 判无风险」正是这条缺陷的诚实记录 ——
 * 诚实不等于正确。
 *
 * ## 新契约
 *
 * `status: 'risky' | 'safe' | 'unknown'`。`risky` 保留是为了兼容既有调用点
 * （它等价于 `status === 'risky'`）。`unknown` 必须按风险处理：
 * 回收站模式下 ask，never 下拒绝。
 */
import { describe, expect, it } from 'vitest'

import { detectPermanentDeleteRisk, detectQuotaRisk, resetQuotaCache } from '../src/recycle'

describe('R02: 读不到策略时状态是 unknown，不是 safe', () => {
  it('reports risky when NoRecycleFiles is enabled', () => {
    const r = detectPermanentDeleteRisk({ platform: 'win32', readRegistry: () => '1' })
    expect(r.status).toBe('risky')
    expect(r.risky).toBe(true)
  })

  it('reports safe when the policy is explicitly disabled', () => {
    const r = detectPermanentDeleteRisk({ platform: 'win32', readRegistry: () => '0' })
    expect(r.status).toBe('safe')
    expect(r.risky).toBe(false)
  })

  it('reports safe when the policy is absent but the read succeeded', () => {
    /*
     * 键不存在（reg 返回 ERROR_FILE_NOT_FOUND）与"读失败"不同：
     * 前者说明这条策略确实没设置。这里用 `undefined` 表示前者。
     */
    const r = detectPermanentDeleteRisk({ platform: 'win32', readRegistry: () => undefined })
    expect(r.status).toBe('safe')
  })

  it('reports unknown when the registry read throws', () => {
    const r = detectPermanentDeleteRisk({
      platform: 'win32',
      readRegistry: () => {
        throw new Error('access denied')
      },
    })
    expect(r.status, '读失败 ≠ 确认安全').toBe('unknown')
    // 兼容字段仍然是 false，避免把"未知"误读成"确定会永久删除"。
    expect(r.risky).toBe(false)
    expect(r.reason).toMatch(/could not (read|verify)|unknown/i)
  })

  it('reports unknown for a value it cannot parse', () => {
    const r = detectPermanentDeleteRisk({ platform: 'win32', readRegistry: () => 'maybe' })
    expect(r.status).toBe('unknown')
  })

  it('is not applicable off Windows (safe, not unknown)', () => {
    const r = detectPermanentDeleteRisk({ platform: 'linux', readRegistry: () => '1' })
    expect(r.status).toBe('safe')
  })
})

describe('R02: 配额上限读不到时同样是 unknown', () => {
  it('distinguishes a file that fits from an unknown limit', () => {
    resetQuotaCache()
    const known = detectQuotaRisk(1 * 1024 * 1024, {
      platform: 'win32',
      listVolumeKeys: () => ['vol'],
      readCapacityMb: () => 50_877,
    })
    // 已知上限、文件没超 → 明确"没风险"。
    expect(known).toBeUndefined()

    resetQuotaCache()
    const unknown = detectQuotaRisk(1 * 1024 * 1024, {
      platform: 'win32',
      listVolumeKeys: () => {
        throw new Error('reg is blocked by policy')
      },
      readCapacityMb: () => undefined,
    })
    // 读不到上限 → 不能说"没风险"，要能区分出来。
    expect(unknown, '读不到上限时不能静默返回 undefined').toBeDefined()
    expect(unknown).toMatch(/could not|cannot verify|unknown/i)
  })

  it('still reports a definite quota breach', () => {
    resetQuotaCache()
    const breach = detectQuotaRisk(60_000 * 1024 * 1024, {
      platform: 'win32',
      listVolumeKeys: () => ['vol'],
      readCapacityMb: () => 50_877,
    })
    expect(breach).toMatch(/per-volume limit/)
  })
})

/*
 * 接线：三态必须真的传到决策层。
 *
 * 这一层容易被"函数改好了、调用点没改"漏掉 —— R02 的第一版就是这样：
 * `detectPermanentDeleteRisk` 返回了 unknown，而 `deletePath` / `deleteMany` /
 * `decideHookRisk` 仍在判 `risky === true`，于是 unknown 仍然被当成安全。
 */
describe('R02: 三态真的接进了三个决策点', () => {
  it('decideHookRisk asks for an unknown policy status', async () => {
    const { decideHookRisk } = await import('../src/index')
    const verdict = decideHookRisk({
      destination: 'recycle-bin',
      permanentDeleteRisk: { status: 'unknown', risky: false, reason: 'registry unreadable' },
      targets: ['C:/work/a.txt'],
      sizes: [10],
    })
    expect(verdict.kind, 'unknown 必须问人，不能当 safe').toBe('ask')
  })

  it('decideHookRisk stays quiet for a confirmed safe policy', async () => {
    const { decideHookRisk } = await import('../src/index')
    const verdict = decideHookRisk({
      destination: 'recycle-bin',
      permanentDeleteRisk: { status: 'safe', risky: false },
      targets: ['C:/work/a.txt'],
      sizes: [10],
    })
    expect(verdict.kind).toBe('next')
  })

  it('deletePath asks before recycling when the policy status is unknown', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { deletePath } = await import('../src/delete-core')

    const root = mkdtempSync(join(tmpdir(), 'dsd-r02-wire-'))
    try {
      const file = join(root, 'a.txt')
      writeFileSync(file, 'x')
      const asked: string[] = []
      const result = await deletePath(
        { path: file },
        {
          stateDir: join(root, 'state'),
          env: {
            home: join(root, 'home'),
            workdir: join(root, 'work'),
            dshHome: join(root, 'home', '.dsh'),
            safeZoneDir: join(root, 'state'),
            tmpdir: join(root, 'not-the-temp'),
          },
          retentionDays: 1,
          confirmFileCount: 0,
          confirmBytes: 0,
          destination: 'recycle-bin',
          permanentDeleteRisk: { status: 'unknown', risky: false, reason: 'registry unreadable' },
          requestApproval: async (text: string) => {
            asked.push(text)
            return 'rejected'
          },
          recycler: () => ({ ok: true, recycled: 1 }),
          now: () => Date.now(),
        } as never,
      )
      expect(asked.length, 'unknown 时 deletePath 必须先问').toBeGreaterThan(0)
      expect(result.ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
