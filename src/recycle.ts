/**
 * 把安全区里过期的条目移入**系统回收站**，而不是永久删除。
 *
 * ## 为什么需要这一层
 *
 * 安全区和系统回收站是**两道**防线，不该合并：
 *
 * | 层 | 谁触发 | 谁能挽回 |
 * |---|---|---|
 * | 安全区 | 删除那一刻（自动） | 保留期内用 `safe_zone_restore` |
 * | 系统回收站 | 保留期结束（自动） | 用户手动清空之前都能还原 |
 * | 永久删除 | 用户清空回收站（手动） | 没有了 |
 *
 * 如果安全区过期时直接 `rmSync`，就等于把「自动」这一步升级成了最终删除 ——
 * 用户对这两步的心理预期完全不同：清理回收站是他主动做的决定，而安全区的
 * 定时清理是无人值守的。
 *
 * ## 失败时的行为
 *
 * **绝不静默降级成永久删除。** 移入回收站失败时：
 *   - 返回失败原因；
 *   - 调用方应把该条目留在安全区（而不是删掉）；
 *   - 由 `safe_zone_status` 报告「清理被跳过」，让人自己决定。
 *
 * 宁可占着磁盘，也不能在用户不知情的情况下永久抹掉数据。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 移入回收站的结果。 */
export type RecycleOutcome =
  | { ok: true }
  | { ok: false; reason: string; unsupported?: boolean }

/**
 * 批量移入回收站的结果。
 *
 * 与单条版本的区别是带 `recycled` 计数：一批里可能部分成功，调用方要能
 * 说清「几个进去了、几个没进去」，而不是笼统报失败。
 */
export type RecycleManyOutcome =
  | { ok: true; recycled: number }
  | { ok: false; reason: string; recycled: number; unsupported?: boolean }

/**
 * 可替换的回收站实现。
 *
 * 为什么允许注入：真实实现要起 PowerShell / osascript 子进程，一次几百毫秒到几秒。
 * 测试里跑真实回收站既慢又会污染系统回收站，所以 `store` 接受一个替身。
 * 生产路径永远用 `moveToSystemRecycleBin`。
 */
export type Recycler = (absPath: string) => RecycleOutcome

/**
 * 判断当前平台是否支持「移入回收站」。
 *
 * @returns 支持的平台返回 `true`。
 */
export function canRecycle(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
}

/** 调用外部命令的统一超时（毫秒）。 */
const COMMAND_TIMEOUT_MS = 20_000

/**
 * 连续失败多少次后熔断。
 *
 * 为什么需要：`moveToSystemRecycleBin` 是**同步阻塞**调用（`execFileSync`），
 * 而且跑在索引串行队列里。如果系统 shell 出了毛病（COM 损坏、超大文件触发
 * 系统确认对话框），每个条目都可能耗掉 20 秒，一次清理 N 个条目就会卡 N×20 秒，
 * 期间所有并发的安全区操作都在排队。
 *
 * 连续 3 次失败基本可以断定是环境问题而不是偶发，此时熔断：剩下的条目直接
 * 判定为「跳过」，让调用方带着「回收站不可用」的结果立刻返回，而不是逐个等超时。
 */
const FAILURE_BREAKER_THRESHOLD = 3

/** 当前连续失败次数（进程内）。成功一次就归零。 */
let consecutiveFailures = 0

/**
 * 回收站是否已被熔断。
 *
 * @returns 连续失败达到阈值时返回 `true`。
 */
export function recycleIsTripped(): boolean {
  return consecutiveFailures >= FAILURE_BREAKER_THRESHOLD
}

/**
 * 重置熔断状态（测试用，或用户在状态命令里主动重试时）。
 */
export function resetRecycleBreaker(): void {
  consecutiveFailures = 0
}

/**
 * 当前连续失败次数（测试与状态展示用）。
 *
 * @returns 连续失败计数。
 */
export function recycleFailureCount(): number {
  return consecutiveFailures
}

/**
 * 熔断阈值（测试用，避免在测试里硬编码 3）。
 *
 * @returns 连续失败达到多少会跳闸。
 */
export function recycleBreakerThreshold(): number {
  return FAILURE_BREAKER_THRESHOLD
}

/**
 * 记录一次失败的回收尝试。
 *
 * 抽成函数是为了让**跳闸路径本身**可以被测试直接驱动：真实失败需要 shell 出问题，
 * 测试无法可靠制造那种环境。生产代码也走这里，所以测的不是影子逻辑。
 *
 * @returns 记录之后的连续失败次数。
 */
export function recordRecycleFailure(): number {
  consecutiveFailures += 1
  return consecutiveFailures
}

/**
 * 把一个路径移入系统回收站。
 *
 * @param absPath 要移入的绝对路径（文件或目录）。
 * @returns 结果；失败时带原因，调用方**不可**据此永久删除。
 */
export function moveToSystemRecycleBin(absPath: string): RecycleOutcome {
  // 熔断：连续失败已达阈值时立刻返回，不再逐个等超时。
  if (recycleIsTripped()) {
    return {
      ok: false,
      reason:
        `recycle bin unavailable after ${consecutiveFailures} consecutive failures; ` +
        'entries stay in the safe zone. Restart DSH to retry.',
    }
  }

  if (!existsSync(absPath)) {
    // 路径本来就不在不算「失败」，不该触发熔断。
    return { ok: false, reason: `path does not exist: ${absPath}` }
  }

  const outcome = attemptRecycle(absPath)
  if (outcome.ok) {
    consecutiveFailures = 0
  } else {
    // 走同一个计数入口，保证测试驱动的路径与生产路径是同一份逻辑。
    recordRecycleFailure()
  }
  return outcome
}

/**
 * 真正尝试一次回收（不含熔断判定）。
 *
 * @param absPath 绝对路径。
 * @returns 结果。
 */
function attemptRecycle(absPath: string): RecycleOutcome {
  try {
    if (process.platform === 'win32') return recycleOnWindows(absPath)
    if (process.platform === 'darwin') return recycleOnMac(absPath)
    if (process.platform === 'linux') return recycleOnLinux(absPath)
    return { ok: false, reason: `unsupported platform: ${process.platform}`, unsupported: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Windows：用 Shell.Application 的 `delete` 动词。
 *
 * 为什么不用 `Remove-Item`：那个是永久删除（或进回收站，取决于文件大小与配置），
 * 行为不确定。Shell 的 delete 动词明确走回收站。
 *
 * @param absPath 绝对路径。
 * @returns 结果。
 */
function recycleOnWindows(absPath: string): RecycleOutcome {
  // PowerShell 单引号字符串里，单引号自身要写成两个。
  const escaped = absPath.replace(/'/g, "''")
  /**
   * 关键：`Namespace(0).ParseName(完整路径)` 对深层路径**不可靠** —— 实测它会返回
   * 一个 item，但 `InvokeVerb('delete')` 变成永久删除而不是进回收站。
   *
   * 更稳的做法是像资源管理器一样：先 `Namespace('父目录')`，再 `ParseName('文件名')`。
   * 这样拿到的是真实的 shell 项目，delete 动词才会走回收站。
   */
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$shell = New-Object -ComObject Shell.Application',
    `$folder = $shell.Namespace('${escaped.replace(/\\[^\\]+$/, '')}')`,
    "if ($null -eq $folder) { Write-Error 'NO_PARENT_FOLDER'; exit 1 }",
    `$item = $folder.ParseName('${absPath.replace(/^.*[\\/]/, '').replace(/'/g, "''")}')`,
    "if ($null -eq $item) { Write-Error 'NO_ITEM'; exit 1 }",
    "$item.InvokeVerb('delete')",
    'exit 0',
  ].join('; ')

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `Shell.Application delete failed: ${message}` }
  }

  // Shell 的动词调用是**异步**的：命令返回时文件可能还没挪走。
  // 给一小段宽限，避免调用方立刻 stat 到「文件还在」而误判失败。
  waitForGone(absPath, 3000)
  if (existsSync(absPath)) {
    return { ok: false, reason: 'Shell.Application returned but the path still exists (may need confirmation)' }
  }
  return { ok: true }
}

/**
 * macOS：用 Finder 的 delete，等价于「移到废纸篓」。
 *
 * @param absPath 绝对路径。
 * @returns 结果。
 */
function recycleOnMac(absPath: string): RecycleOutcome {
  const escaped = absPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  try {
    execFileSync('osascript', ['-e', `tell application "Finder" to delete POSIX file "${escaped}"`], {
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return { ok: false, reason: `Finder delete failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  waitForGone(absPath, 3000)
  return existsSync(absPath) ? { ok: false, reason: 'Finder returned but the path still exists' } : { ok: true }
}

/**
 * Linux：优先 `gio trash`（GNOME/现代发行版都有），退回 `trash-put`。
 *
 * @param absPath 绝对路径。
 * @returns 结果。
 */
function recycleOnLinux(absPath: string): RecycleOutcome {
  const attempts: Array<[string, string[]]> = [
    ['gio', ['trash', absPath]],
    ['trash-put', [absPath]],
  ]

  let lastReason = 'no trash command available (tried gio, trash-put)'
  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, { timeout: COMMAND_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
      waitForGone(absPath, 3000)
      if (!existsSync(absPath)) return { ok: true }
      lastReason = `${command} returned but the path still exists`
    } catch (error) {
      lastReason = `${command} failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return { ok: false, reason: lastReason }
}

/**
 * 等待路径消失，最多等 `timeoutMs`。
 *
 * 为什么需要：系统回收站调用是异步的（Shell 把请求投递给资源管理器），
 * 命令返回时文件往往还在原处。立刻判定会得到假失败。
 *
 * @param absPath 路径。
 * @param timeoutMs 最长等待。
 */
function waitForGone(absPath: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(absPath)) return
    // 同步短睡：这个函数在 async 上下文里被调用，但等待本身很短（最多 3 秒）。
    const buffer = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(buffer), 0, 0, 100)
  }
}

/**
 * 生成「一次处理多个路径」的 PowerShell 脚本。
 *
 * ## 为什么不聚合进一个暂存目录（2026-11-04 实测否决）
 *
 * 把 N 个目标 rename 进 `recycle-batch/<id>/items/` 再交给回收站，回收站里
 * 只会出现**一个叫 `items` 的文件夹**，原位置记录为那个内部路径 —— 用户点还原，
 * 文件回到他从没选过的地方，而那里还可能被清理任务删掉。
 *
 * 直接对**真实路径**逐条调用，回收站就按原样记录原位置，还原回到删除的地方。
 *
 * ## 为什么一个进程
 *
 * 每条一次 `powershell.exe` 是 200–500ms 的进程启动开销；实测一个进程内循环
 * 处理 21 个条目共 3.4 秒（约 162ms/项）。1000 个文件因此是分钟级而不是小时级。
 *
 * @param absPaths 真实绝对路径。
 * @returns PowerShell 脚本正文。
 */
export function buildRecycleManyScript(absPaths: readonly string[]): string {
  const quote = (p: string): string => `'${p.replace(/'/g, "''")}'`
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$targets = @(${absPaths.map(quote).join(',')})`,
    '$ok = 0; $fail = 0',
    'foreach ($t in $targets) {',
    '  try {',
    '    if (Test-Path -LiteralPath $t -PathType Container) {',
    '      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($t, "OnlyErrorDialogs", "SendToRecycleBin")',
    '    } else {',
    '      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($t, "OnlyErrorDialogs", "SendToRecycleBin")',
    '    }',
    '    $ok++',
    '  } catch { $fail++; Write-Output "ERR: $t : $($_.Exception.Message)" }',
    '}',
    'Write-Output "OK=$ok FAIL=$fail"',
  ].join('\n')
}

/**
 * 解析批量脚本的输出。
 *
 * 找不到 `OK=` 汇总行时按**失败**处理：脚本崩溃不该被当成成功。
 *
 * @param stdout 脚本标准输出。
 * @returns 成功数、失败数与逐条错误。
 */
export function parseRecycleManyOutput(stdout: string): { ok: number; fail: number; errors: string[] } {
  const lines = stdout.split(/\r?\n/)
  const errors = lines
    .filter((line) => line.startsWith('ERR: '))
    .map((line) => line.slice('ERR: '.length).trim())
  const summary = lines.find((line) => /OK=\d+\s+FAIL=\d+/.test(line))
  if (summary === undefined) {
    return { ok: 0, fail: Math.max(1, errors.length), errors }
  }
  const ok = Number(/OK=(\d+)/.exec(summary)?.[1] ?? '0')
  const fail = Number(/FAIL=(\d+)/.exec(summary)?.[1] ?? '0')
  return { ok, fail, errors }
}

/**
 * 把多个真实路径一次性交给系统回收站。
 *
 * @param absPaths 真实绝对路径（不聚合、不改名）。
 * @returns 结果；`recycled` 为真正送进回收站的条数。
 */
export function recycleManyToSystemBin(absPaths: readonly string[]): RecycleManyOutcome {
  if (absPaths.length === 0) return { ok: true, recycled: 0 }

  if (process.platform !== 'win32') {
    return {
      ok: false,
      recycled: 0,
      reason: `recycle-bin destination is only implemented on win32 (current: ${process.platform})`,
      unsupported: true,
    }
  }

  if (recycleIsTripped()) {
    return {
      ok: false,
      recycled: 0,
      reason: `recycle bin unavailable after ${consecutiveFailures} consecutive failures. Restart DSH to retry.`,
    }
  }

  const script = buildRecycleManyScript(absPaths)
  /*
   * 超时按条目数放大：一个进程处理 N 条，每条约 160ms，留一倍余量。
   */
  const timeout = Math.max(COMMAND_TIMEOUT_MS, 5_000 + 400 * absPaths.length)
  let stdout = ''
  try {
    stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    recordRecycleFailure()
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, recycled: 0, reason: `SendToRecycleBin failed: ${message}` }
  }

  const parsed = parseRecycleManyOutput(stdout)
  if (parsed.fail > 0 || parsed.ok === 0) {
    recordRecycleFailure()
    const detail = parsed.errors.length > 0 ? `: ${parsed.errors.slice(0, 3).join('; ')}` : ''
    return {
      ok: false,
      recycled: parsed.ok,
      reason: `${parsed.fail} of ${absPaths.length} item(s) could not be recycled${detail}`,
    }
  }

  consecutiveFailures = 0
  return { ok: true, recycled: parsed.ok }
}

/**
 * 系统是否被配置成「删除即永久删除」。
 *
 * ## 为什么必须检测（2026-11-04）
 *
 * Windows 的回收站可以被策略关掉：`NoRecycleFiles` 为 1 时，Shell 的删除
 * 动词**直接永久删除并返回成功**。对一个承诺「删除可反悔」的插件，这是最坏的
 * 情形 —— 用户以为进了回收站，其实没有了。
 *
 * 命中时调用方必须**先问人**，用户不同意就放弃这次删除。
 */
export type PermanentDeleteRisk = { risky: boolean; reason?: string }

/** 读取注册表值的替身（测试注入）。 */
export type RegistryReader = (key: string, name: string) => string | undefined

/** 用 `reg query` 读一个值；读不到返回 undefined。 */
function readRegistryViaReg(key: string, name: string): string | undefined {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    // 输出形如 `    NoRecycleFiles    REG_DWORD    0x1`
    const line = out.split(/\r?\n/).find((l) => l.includes(name))
    if (line === undefined) return undefined
    const parts = line.trim().split(/\s+/)
    return parts[parts.length - 1]
  } catch {
    return undefined
  }
}

/**
 * 检测「删除会被系统永久执行」的策略。
 *
 * @param options.platform 平台（测试注入，默认 `process.platform`）。
 * @param options.readRegistry 注册表读取替身。
 * @returns `risky` 为真时调用方必须先问人。
 */
export function detectPermanentDeleteRisk(
  options: {
    platform?: NodeJS.Platform
    readRegistry?: RegistryReader
  } = {},
): PermanentDeleteRisk {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { risky: false }

  const read = options.readRegistry ?? readRegistryViaReg
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer'
  let raw: string | undefined
  try {
    raw = read(key, 'NoRecycleFiles')
  } catch {
    // 读不到就当作没有该策略：不能因为一次读注册表失败就拦住所有删除。
    return { risky: false }
  }
  if (raw === undefined) return { risky: false }

  const value = raw.trim().toLowerCase()
  // 注册表里既可能是 DWORD（0x1 / 1），也可能被手工写成字符串。
  const enabled = value === '1' || value === '0x1' || value === 'true'
  if (!enabled) return { risky: false }

  return {
    risky: true,
    reason:
      'the NoRecycleFiles policy is enabled: Windows will permanently delete instead of using the recycle bin',
  }
}
