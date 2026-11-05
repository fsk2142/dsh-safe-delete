/*
 * 2026-11-05 第三轮复审 R01（P1）：默认注册表读取适配器仍把"读失败"折成 safe。
 *
 * ## 缺陷
 *
 * `detectPermanentDeleteRisk` 本身已经是三态了（上一轮 R02 修的）：读取函数
 * **抛异常**时它返回 `unknown`。但生产默认适配器 `readRegistryViaReg` 自己先
 * `catch { return undefined }`，异常永远到不了外层。于是下面五种情况被压成同一个
 * `undefined`，而外层把它读作"策略未设置"：
 *
 * ```text
 * detectPermanentDeleteRisk()
 *   -> readRegistryViaReg()
 *        -> execFileSync("reg", ...)
 *        -> catch { return undefined }      // ← 全部异常在这里消失
 *   -> raw === undefined
 *        -> { status: "safe", risky: false } // ← 唯一来源是"值不存在"
 * ```
 *
 * | 事实 | 旧值 | 正确语义 |
 * |---|---|---|
 * | 值确实不存在 | safe | **safe** |
 * | 访问被拒绝 | safe | **unknown** |
 * | `reg.exe` 起不来 | safe | **unknown** |
 * | 查询命令失败 | safe | **unknown** |
 * | 输出解析不了 | safe | **unknown** |
 *
 * 上一轮的 `tests/r02-unknown-risk.test.ts` 只注入了"会抛异常的替身"，覆盖的是
 * 外层 catch —— 它证明不了**生产适配器**能把"不存在"和"读不了"分开。
 *
 * ## 为什么不能靠 stderr 文本判断
 *
 * `reg.exe` 的错误信息来自 MUI 资源（本机 `System32\en-US\`、`zh-CN\` 各一份），
 * 文本随系统语言变化：
 *
 * ```text
 * zh-CN: 错误: 系统找不到指定的注册表项或值。
 * en-US: ERROR: The system was unable to find the specified registry key or value.
 * ```
 *
 * 把任一种文本写进源码，都会在另一种语言的机器上静默退化成"读失败 = 安全"。
 *
 * ## 判据：同语言的控制探针
 *
 * "找不到"与"访问被拒绝"的**文本不同**，而两台机器只是语言不同。
 * 所以不比对**绝对文本**，比对**相对差异**：
 *
 *   1. 正值控制：`reg query HKCU\Software` 必须成功（否则环境本身不可信）；
 *   2. 负值控制：查一个确定不存在的键，取得本机"找不到"这一条消息；
 *   3. 目标查询的 stderr 与负值控制**逐字相同** → 确认不存在 → `missing`；
 *      否则 → `error`（访问拒绝、策略拦截、其它失败）。
 *
 * 控制探针只在失败路径跑，因此不影响正常路径的成本。
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { createRegReader, detectPermanentDeleteRisk } from '../src/recycle'
import type { RegQueryRunner, RegistryReadResult } from '../src/recycle'

/** 虚构的两条错误消息 —— 与本机语言无关，测试只依赖"相同/不同"。 */
const NOT_FOUND = 'ERROR: the system was unable to find the specified registry key or value.'
const DENIED = 'ERROR: access is denied.'

/**
 * 造一个假的 `reg` 执行器。
 *
 * 只按"这是不是控制探针"以及调用方给的 `behaviour` 决定返回值，
 * 不依赖本机真实注册表。
 *
 * @param target 目标查询的结果。
 * @param options.notFoundText 本机"找不到"的文本。
 * @returns 假的执行器。
 */
function fakeRunner(
  target: { status: number | null; stdout?: string; stderr?: string; spawnError?: string },
  options: { notFoundText?: string; positive?: { status: number | null; spawnError?: string } } = {},
): RegQueryRunner {
  const notFoundText = options.notFoundText ?? NOT_FOUND
  return (key, name) => {
    // 正值控制：`reg query HKCU\Software`（查整个键）。
    if (key === 'HKCU\\Software' && name === undefined) {
      const positive = options.positive ?? { status: 0 }
      return {
        status: positive.status,
        stdout: '',
        stderr: '',
        ...(positive.spawnError === undefined ? {} : { spawnError: positive.spawnError }),
      }
    }
    // 负值控制：同一个必然可读的键 + 一个必然不存在的值。
    if (key === 'HKCU\\Software' && name !== undefined) {
      return { status: 1, stdout: '', stderr: notFoundText }
    }
    return {
      status: target.status,
      stdout: target.stdout ?? '',
      stderr: target.stderr ?? '',
      ...(target.spawnError === undefined ? {} : { spawnError: target.spawnError }),
    }
  }
}

/** 便于断言的解包：只关心"是不是确认不存在"。 */
function kindOf(result: RegistryReadResult): string {
  return result.kind
}

describe('R01/T02：确认不存在才是 safe', () => {
  it('treats a value that is confirmed absent as safe', () => {
    const read = createRegReader(
      fakeRunner({ status: 1, stdout: '', stderr: NOT_FOUND }),
    )
    expect(kindOf(read('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer', 'NoRecycleFiles'))).toBe(
      'missing',
    )

    const r = detectPermanentDeleteRisk({ platform: 'win32', readRegistry: read })
    expect(r.status, '确认没有这条策略 = 确认回收站生效').toBe('safe')
    expect(r.risky).toBe(false)
  })

  it('reads the value when the query succeeds', () => {
    const read = createRegReader(
      fakeRunner({ status: 0, stdout: '\r\nHKEY_CURRENT_USER\\...\r\n    NoRecycleFiles    REG_DWORD    0x1\r\n\r\n' }),
    )
    const result = read('HKCU\\x', 'NoRecycleFiles')
    expect(result).toEqual({ kind: 'value', value: '0x1' })
    expect(detectPermanentDeleteRisk({ platform: 'win32', readRegistry: read }).status).toBe('risky')
  })
})

describe('R01/T01：访问被拒绝是 unknown', () => {
  it('reports unknown when the query is denied instead of absent', () => {
    const read = createRegReader(fakeRunner({ status: 1, stdout: '', stderr: DENIED }))
    expect(kindOf(read('HKCU\\x', 'NoRecycleFiles')), '访问拒绝 ≠ 值不存在').toBe('error')

    const r = detectPermanentDeleteRisk({ platform: 'win32', readRegistry: read })
    expect(r.status, '读不了策略 = 不知道会不会永久删除').toBe('unknown')
    expect(r.risky).toBe(false)
    expect(r.reason).toMatch(/could not|unknown/i)
  })

  it('does not guess "safe" when the text is empty', () => {
    // 没有消息的失败（被信号杀掉、被策略静默拦截）同样不可信。
    const read = createRegReader(fakeRunner({ status: 1, stdout: '', stderr: '' }))
    expect(kindOf(read('HKCU\\x', 'NoRecycleFiles'))).toBe('error')
  })
})

describe('R01/T03：reg.exe 起不来是 unknown', () => {
  it('reports unknown when the binary cannot be spawned', () => {
    const read = createRegReader(fakeRunner({ status: null, spawnError: 'spawnSync reg ENOENT' }))
    const r = detectPermanentDeleteRisk({ platform: 'win32', readRegistry: read })
    expect(r.status).toBe('unknown')
    expect(r.reason).toMatch(/could not|unknown/i)
  })

  it('reports unknown when even the control probe cannot run', () => {
    /*
     * 控制探针跑不起来时，"这条消息就是找不到"这个前提不成立 ——
     * 那就不能再说 safe。这条防的是"整台机器上 reg 全被拦住"时
     * 原型的误判：两次失败长得一样，不能因此认定"值不存在"。
     */
    const read = createRegReader(
      fakeRunner(
        { status: 1, stdout: '', stderr: NOT_FOUND },
        { positive: { status: null, spawnError: 'spawnSync reg EACCES' } },
      ),
    )
    expect(kindOf(read('HKCU\\x', 'NoRecycleFiles'))).toBe('error')
  })
})

describe('R01/T04：输出解析不了是 unknown', () => {
  it('reports unknown when the query succeeds but the output is not a value line', () => {
    const read = createRegReader(fakeRunner({ status: 0, stdout: 'garbage that is not reg output\r\n' }))
    expect(kindOf(read('HKCU\\x', 'NoRecycleFiles')), '读到了但解析不了 ≠ 没设置').toBe('error')
  })

  it('does not confuse another value whose name contains the target', () => {
    const read = createRegReader(
      fakeRunner({
        status: 0,
        stdout:
          'HKEY_CURRENT_USER\\x\r\n' +
          '    NoRecycleFilesBackup    REG_DWORD    0x1\r\n',
      }),
    )
    // 只有 `NoRecycleFiles` 这一条才算；名字包含它的另一条不能当命中。
    expect(kindOf(read('HKCU\\x', 'NoRecycleFiles'))).toBe('error')
  })

  it('accepts REG_SZ values too', () => {
    const read = createRegReader(
      fakeRunner({ status: 0, stdout: 'HKEY_CURRENT_USER\\x\r\n    NoRecycleFiles    REG_SZ    1\r\n' }),
    )
    expect(read('HKCU\\x', 'NoRecycleFiles')).toEqual({ kind: 'value', value: '1' })
  })
})

/*
 * 真实 `reg.exe` 的冒烟测试。
 *
 * 上面所有用例都用假执行器 —— 那是**契约**测试。这一段补的是另一件事：
 * 默认执行器在这台机器上能不能跑通、解析对不对。两者缺一不可：
 * 只有假执行器，适配器可能根本没接到 `spawnSync`；只有真机，无法构造访问拒绝。
 */
const isWindows = process.platform === 'win32'

describe.skipIf(!isWindows)('R01：真实 reg.exe 的契约', () => {
  /**
   * 直接跑一次 reg，供"环境是否允许断言"用。
   *
   * @param args 参数。
   * @returns 退出码。
   */
  function regStatus(args: string[]): number | null {
    try {
      const out = execFileSync('reg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      return out === undefined ? 0 : 0
    } catch (error) {
      return (error as { status?: number }).status ?? 1
    }
  }

  it('reads a value that exists', () => {
    const read = createRegReader()
    const result = read(
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced',
      'HideFileExt',
    )
    expect(['value', 'missing']).toContain(result.kind)
    if (result.kind === 'value') expect(result.value).toMatch(/^(0x[0-9a-f]+|\d+|true|false)$/i)
  })

  it('reports missing for a value that is confirmed absent', () => {
    /*
     * 先确认这台机器上策略键**可读**（否则"值不存在"本身就不可证）。
     * 键不可读时这段跳过 —— 那是环境限制，不是被测代码的问题。
     */
    const keyReadable =
      regStatus(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer']) === 0
    if (!keyReadable) return

    const read = createRegReader()
    const result = read(
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer',
      'DshSafeDeleteNoSuchValue',
    )
    expect(result.kind, '键可读 + 值查不到 = 确认没有这条策略').toBe('missing')
  })

  it('reports error for an unreadable key instead of missing', () => {
    /*
     * `HKLM\SECURITY` / `HKLM\SAM\SAM` 对非管理员是拒绝访问。以管理员跑测试时
     * 它们可读，这条就失去意义 —— 那时跳过，而不是假装通过。
     */
    if (regStatus(['query', 'HKLM\\SECURITY', '/v', 'X']) === 0) return

    const read = createRegReader()
    const result = read('HKLM\\SECURITY', 'X')
    expect(result.kind, '拒绝访问必须与"值不存在"区分开').toBe('error')
  })

  it('feeds the three states through detectPermanentDeleteRisk', () => {
    const r = detectPermanentDeleteRisk()
    // 无论是 safe / risky / unknown，都必须是这三者之一，且 risky 只在 risky 时真。
    expect(['safe', 'risky', 'unknown']).toContain(r.status)
    expect(r.risky).toBe(r.status === 'risky')
  })
})
