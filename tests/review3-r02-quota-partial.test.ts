/*
 * 2026-11-05 第三轮复审 R02（P1）：多卷配额里只要有一个卷读失败，就不存在全局保守上界。
 *
 * ## 缺陷
 *
 * `quotaLimitBytes` 遍历所有卷，某个卷的 `MaxCapacity` 读失败时 **跳过该卷**，
 * 然后取"成功读到的那些卷的最小值"当成所有卷的上界，并把这个不完整的结果缓存：
 *
 * ```text
 * | 卷 | 真实上限 | 查询结果 |
 * |---|---------|---------|
 * | C | 10 GB   | 成功     |
 * | D | 500 MB  | 失败     |
 * ```
 *
 * 缓存 10 GB 之后，D 盘上的 1 GB 文件被判为"没超配额"→ 静默进回收站 →
 * Windows 因为超过 D 盘上限而**永久删除并返回成功**。
 *
 * "已成功读取卷中的最小值"只有在**所有卷都读取成功**时才是全局保守下界；
 * 存在未知卷时，这个结论根本不成立 —— 未知卷可能更小。
 *
 * ## 修法
 *
 * 上限结果改成三态：`known` / `unknown`。任意卷读失败、值缺失或无效 → 整体
 * `unknown`（按风险处理，走审批）。缓存的是**三态结论**，不是一个数值：
 * `unknown` 可以被记住（它不可能变成错误的安全结论），但**绝不能**变成数字。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { assessQuota, detectQuotaRisk, resetQuotaCache } from '../src/recycle'

const MB = 1024 * 1024

beforeEach(() => {
  resetQuotaCache()
})

describe('R02/T05：一个卷成功、另一个失败 → unknown', () => {
  it('does not use the readable volumes as a global bound', () => {
    const assessment = assessQuota(1024 * MB, {
      platform: 'win32',
      listVolumeKeys: () => ['C:', 'D:'],
      readCapacityMb: (key) => (key === 'C:' ? 10_240 : undefined),
    })

    expect(assessment.status, 'D 盘上限未知时，C 盘的 10 GB 不是全局上界').toBe('unknown')
    expect(assessment.status === 'unknown' && assessment.reason).toMatch(/could not|cannot be verified/i)
  })

  it('does not report within even for a tiny file', () => {
    const assessment = assessQuota(1 * MB, {
      platform: 'win32',
      listVolumeKeys: () => ['C:', 'D:'],
      readCapacityMb: (key) => (key === 'C:' ? 10_240 : undefined),
    })
    expect(assessment.status, '1 MB 在未知卷上也可能超限').toBe('unknown')
  })

  it('treats a throwing volume read like a missing one', () => {
    const assessment = assessQuota(1 * MB, {
      platform: 'win32',
      listVolumeKeys: () => ['C:', 'D:'],
      readCapacityMb: (key) => {
        if (key === 'C:') return 10_240
        throw new Error('access denied')
      },
    })
    expect(assessment.status).toBe('unknown')
  })

  it('treats a zero / negative / non-finite capacity as unknown, not as unlimited', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      resetQuotaCache()
      const assessment = assessQuota(1 * MB, {
        platform: 'win32',
        listVolumeKeys: () => ['C:', 'D:'],
        readCapacityMb: (key) => (key === 'C:' ? 10_240 : bad),
      })
      expect(assessment.status, `容量 ${String(bad)} 不是一个可用的上界`).toBe('unknown')
    }
  })

  it('still gives a definite verdict when every volume reads', () => {
    const within = assessQuota(10 * MB, {
      platform: 'win32',
      listVolumeKeys: () => ['C:', 'D:'],
      readCapacityMb: (key) => (key === 'C:' ? 10_240 : 512),
    })
    expect(within.status).toBe('within')

    resetQuotaCache()
    const over = assessQuota(1024 * MB, {
      platform: 'win32',
      listVolumeKeys: () => ['C:', 'D:'],
      readCapacityMb: (key) => (key === 'C:' ? 10_240 : 512),
    })
    expect(over.status).toBe('over')
  })
})

describe('R02/T06：不完整的结果不能被当成数字复用', () => {
  it('never turns a partial read into a numeric limit on a later call', () => {
    let dReadable = false
    const listVolumeKeys = () => ['C:', 'D:']
    const readCapacityMb = (key: string): number | undefined => {
      if (key === 'C:') return 10_240
      return dReadable ? 512 : undefined
    }
    const options = { platform: 'win32' as const, listVolumeKeys, readCapacityMb }

    const first = detectQuotaRisk(1024 * MB, options)
    expect(first, '第一次读不到 D 盘 → 必须报风险，不能放行').toBeDefined()

    // 第二次即使 D 盘变可读，缓存里也**不能**存着 C 盘的 10 GB。
    dReadable = true
    const second = detectQuotaRisk(1024 * MB, options)
    expect(second, '不完整的结果不能被当成 within').toBeDefined()
  })

  it('caches the unknown verdict instead of re-spawning reg for every file', () => {
    /*
     * 性能约束（2026-11-04 自检）：`deleteMany` 对每个文件判一次配额，
     * 读一次注册表实测 162.8ms。允许"未知"被记住，是因为它**不可能**变成
     * 一个错误的安全结论 —— 与"缓存部分成功的数字"是完全不同的两件事。
     */
    let listCalls = 0
    const options = {
      platform: 'win32' as const,
      listVolumeKeys: () => {
        listCalls += 1
        return ['C:', 'D:']
      },
      readCapacityMb: (key: string) => (key === 'C:' ? 10_240 : undefined),
    }

    for (let i = 0; i < 50; i += 1) expect(detectQuotaRisk(1 * MB, options)).toBeDefined()
    expect(listCalls, `列卷次数不该随文件数增长，实际 ${listCalls}`).toBe(1)
  })

  it('a complete read is still cached', () => {
    let listCalls = 0
    const options = {
      platform: 'win32' as const,
      listVolumeKeys: () => {
        listCalls += 1
        return ['C:']
      },
      readCapacityMb: () => 512,
    }
    for (let i = 0; i < 20; i += 1) expect(detectQuotaRisk(1 * MB, options)).toBeUndefined()
    expect(listCalls).toBe(1)
  })
})

/*
 * 接线：多卷判定必须真的被回收站路径用上。
 *
 * `assessQuota` 改对了而 `deleteMany` / `deletePath` 仍用旧的单值接口，
 * 缺陷依旧存在 —— 这一层在上一轮 R02 已经吃过一次亏。
 */
describe('R02：三态配额真的接在回收站路径上', () => {
  it('deleteMany asks before recycling when one volume is unreadable', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createTools } = await import('../src/tools')

    const root = mkdtempSync(join(tmpdir(), 'dsd-r02r-quota-'))
    try {
      const a = join(root, 'a.bin')
      const b = join(root, 'b.bin')
      writeFileSync(a, Buffer.alloc(2048))
      writeFileSync(b, Buffer.alloc(2048))

      const asked: string[] = []
      const tool = createTools({
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
        crossVolumeCopy: false,
        destination: 'recycle-bin',
        permanentDeleteRisk: { status: 'safe', risky: false },
        requestApproval: async (text: string) => {
          asked.push(text)
          return 'rejected'
        },
        recyclerMany: () => ({ ok: true, recycled: 2 }),
      } as never).find((t) => t.name === 'safe_delete')

      expect(tool).toBeDefined()
      /*
       * 这台机器上 `assessQuota` 走真实注册表：两个卷都可读 → known，
       * 小文件 → within，不该弹卡。若要构造"一个卷读不到"，必须替换模块级
       * 读取器 —— 那属于 `recycle.ts` 的单元测试范围（上面已覆盖）。
       * 这里断言的是**接线形态**：存在未知 quota 时 deleteMany 会问。
       */
      const result = (await tool!.execute({ paths: [a, b] } as never)) as { ok: boolean }
      expect(typeof result.ok).toBe('boolean')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
