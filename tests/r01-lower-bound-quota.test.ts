/*
 * 2026-11-05 第二轮复审 R01：目录配额只是下界，不能当成"确认没风险"。
 *
 * ## 问题
 *
 * 回收站模式跳过目录的递归统计（那是与文件数成正比的成本），只量顶层
 * （`shallowBytes`）。于是：
 *
 * ```text
 * target/
 *   nested/
 *     huge-file.bin   # 20 GB，而顶层一个文件都没有
 * ```
 *
 * `bytes` 得到 0，`detectQuotaRisk(0)` 在旧实现里直接 `return undefined`
 * —— 也就是"没风险"，静默放行。而 Windows 对超过回收站上限的条目会
 * **永久删除并返回成功**。
 *
 * ## 修法
 *
 * 把"大小只是下界"这个事实传进判定：下界已超 → 确定 over；下界没超但真实
 * 大小未知 → **unknown**，按风险处理（ask / never 下拒绝）。单文件和完整
 * 递归统计仍然能给出确定结论。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MB = 1024 * 1024
/** 假装上限是 1 MB，这样小文件也能触发 over。 */
const LIMIT_MB = 1

vi.mock('../src/recycle', async () => {
  const actual = await vi.importActual<typeof import('../src/recycle')>('../src/recycle')
  /*
   * 只换掉「读注册表」这一段：判定逻辑本身走真实实现，避免把被测逻辑
   * 换成影子逻辑。上限固定 1 MB，便于用小文件构造 over / unknown。
   */
  return {
    ...actual,
    assessQuota: (size: number, options: { sizeIsLowerBound?: boolean } = {}) =>
      actual.assessQuota(size, {
        ...options,
        platform: 'win32',
        listVolumeKeys: () => ['test-volume'],
        readCapacityMb: () => LIMIT_MB,
      }),
    detectQuotaRisk: (size: number, options: { sizeIsLowerBound?: boolean } = {}) =>
      actual.detectQuotaRisk(size, {
        ...options,
        platform: 'win32',
        listVolumeKeys: () => ['test-volume'],
        readCapacityMb: () => LIMIT_MB,
      }),
  }
})

const { assessQuota } = await import('../src/recycle')

describe('R01: 下界大小必须按 unknown 处理，不能当成 within', () => {
  it('a top-level size below the limit is not proof when it is only a lower bound', () => {
    const measured = assessQuota(0, { sizeIsLowerBound: true })
    expect(measured.status, '顶层 0 字节不能证明目录没超上限').toBe('unknown')
    expect(measured.status === 'unknown' && measured.reason).toMatch(/nested|top level|recursive/i)
  })

  it('a lower bound that already exceeds the limit is a definite breach', () => {
    const measured = assessQuota(2 * MB, { sizeIsLowerBound: true })
    expect(measured.status).toBe('over')
  })

  it('a complete size below the limit is within', () => {
    const measured = assessQuota(1 * MB, {})
    expect(measured.status).toBe('within')
  })

  it('a complete size above the limit is over', () => {
    const measured = assessQuota(2 * MB, {})
    expect(measured.status).toBe('over')
  })

  it('an unreadable limit stays unknown even for a complete size', async () => {
    const actual = await vi.importActual<typeof import('../src/recycle')>('../src/recycle')
    const measured = actual.assessQuota(1 * MB, {
      platform: 'win32',
      listVolumeKeys: () => {
        throw new Error('registry blocked')
      },
      readCapacityMb: () => undefined,
    })
    expect(measured.status).toBe('unknown')
  })
})

/*
 * 接线层：目录形态在回收站模式下必须真的走到这条判定。
 * 静态断言足够 —— 造一个 20 GB 的嵌套目录不现实，而缺陷形态正是"没接线"。
 */
describe('R01: 目录目标把 sizeIsLowerBound 传给判定', () => {
  it('delete-core passes the lower-bound flag for directories', () => {
    const src = readFileSync('src/delete-core.ts', 'utf8')
    expect(src).toMatch(/sizeIsLowerBound/)
  })

  it('the hook passes the lower-bound flag for pattern targets', () => {
    const src = readFileSync('src/index.ts', 'utf8')
    expect(src).toMatch(/sizeIsLowerBound/)
  })
})

/*
 * 真实的目录 + 阈值接线测试（不用静态断言兜底）。
 */
describe('R01: 批量删除对目录目标按 unknown 处理', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsd-r01-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /*
   * 2026-11-08 起，「下界没超」不再等于「一律问人」：能枚举出确定大小时就
   * 按实际值判，证明放得下就放行。但**证明不出来时**仍然必须问 —— 这条保护
   * 没变，只是触发条件从「目录」收紧成「目录 + 测不出来」。
   */
  it('asks before sending a directory whose size cannot be established', async () => {
    const { createTools } = await import('../src/tools')
    const dir = join(root, 'nested-big')
    mkdirSync(join(dir, 'deep'), { recursive: true })
    writeFileSync(join(dir, 'deep', 'huge.bin'), Buffer.alloc(2048))

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
      // 枚举失败：这一条必须仍然走审批。
      makeMeasureBounded: () => () => ({ kind: 'incomplete', reason: 'access denied' }),
      requestApproval: async (text: string) => {
        asked.push(text)
        return 'rejected'
      },
      recyclerMany: () => ({ ok: true, recycled: 1 }),
    } as never).find((t) => t.name === 'safe_delete')

    expect(tool).toBeDefined()
    const result = (await tool!.execute({ path: dir } as never)) as { ok: boolean; error?: string }

    expect(asked.length, '大小证明不出来时必须先问').toBeGreaterThan(0)
    // 用户拒绝 → 什么都不动。
    expect(result.ok).toBe(false)
  })

  /*
   * 反面：目录真的很小、而枚举证明了这一点时，不该再弹卡。
   *
   * 这正是「两个选项」里那个 `recycle-bin` 的意义 —— 选了它就必须真的进
   * 回收站，不能因为目标恰好是个目录就永远删不掉。
   */
  it('does not ask when the enumeration proves the directory fits', async () => {
    const { createTools } = await import('../src/tools')
    const dir = join(root, 'small')
    mkdirSync(join(dir, 'deep'), { recursive: true })
    writeFileSync(join(dir, 'deep', 'tiny.bin'), Buffer.alloc(64))

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
      requestApproval: async (text: string) => {
        asked.push(text)
        return 'rejected'
      },
      recyclerMany: () => ({ ok: true, recycled: 1 }),
    } as never).find((t) => t.name === 'safe_delete')

    const result = (await tool!.execute({ path: dir } as never)) as { ok: boolean; error?: string }

    expect(asked.length, '实测远低于上限，不该再问').toBe(0)
    expect(result.ok, '证明放得下就该真的删掉').toBe(true)
  })
})
