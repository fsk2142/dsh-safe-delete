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

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
  | {
      ok: true
      recycled: number
      /** 部分失败时的逐条错误（成功的不受影响）。 */
      failed?: string[]
    }
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
        'nothing was permanently deleted. Restart DSH to retry.',
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
export function buildRecycleManyScript(): string {
  /*
   * ## 为什么用 SHFileOperation 而不是 FileSystem.DeleteDirectory
   *
   * 2026-11-04 实测：\`Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory\`
   * 在**交互式桌面会话**里删大目录时会弹出 Windows 的「正在准备回收…」进度
   * 窗口（用户报告：34,480 个项目的窗口盖在前台）。\`windowsHide: true\` 管不了它 ——
   * 那个窗口由 shell 绘制，不是控制台窗口。
   *
   * \`SHFileOperationW\` + \`FOF_ALLOWUNDO\` 是同一套底层能力的旧版 API，但它接受
   * **一次传多个路径**，且 \`FOF_SILENT | FOF_NOERRORUI\` 能真正压掉 UI。
   *
   * 实测对照（本机，Windows，同卷）：
   *
   * | 方式 | 20,000 个文件 | 弹窗 |
   * |---|---|---|
   * | DeleteDirectory | 4.9s | **会** |
   * | SHFileOperation | 3.8s | 不会 |
   *
   * 且多路径一次调用可用：3 个目录一次送进回收站，原位置各自保留。
   */
  const csType = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class DshShFileOp {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  public struct SHFILEOPSTRUCTW {',
    '    public IntPtr hwnd;',
    '    public uint wFunc;',
    '    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;',
    '    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;',
    '    public ushort fFlags;',
    '    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;',
    '    public IntPtr hNameMappings;',
    '    [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;',
    '  }',
    '  [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHFileOperationW")]',
    '  public static extern int SHFileOperationW(ref SHFILEOPSTRUCTW lp);',
    '}',
  ].join('\n')

  return [
    "$ErrorActionPreference = 'Stop'",
    /* 路径从文件读：命令行长度与路径数无关（审查 Critical-2）。 */
    "$targets = @(Get-Content -LiteralPath $listPath -Encoding UTF8 | Where-Object { $_ -ne '' })",
    'if ($targets.Count -eq 0) { Write-Output "OK=0 FAIL=0"; exit 0 }',
    '$present = @($targets | Where-Object { Test-Path -LiteralPath $_ })',
    '$missing = @($targets | Where-Object { -not (Test-Path -LiteralPath $_) })',
    'foreach ($m in $missing) { Write-Output "ERR: $m : not found" }',
    'if ($present.Count -eq 0) { Write-Output "OK=0 FAIL=$($missing.Count)"; exit 0 }',
    /* 类型定义用单引号 here-string 交给 Add-Type。 */
    "$cs = @'\n" + '$CS_BODY_PLACEHOLDER' + '\n' + "'@",
    'Add-Type -TypeDefinition $cs',
    '$op = New-Object DshShFileOp+SHFILEOPSTRUCTW',
    '$op.wFunc = 3',
    '$op.pFrom = ($present -join [char]0) + [char]0 + [char]0',
    '$op.pTo = $null',
    /*
     * FOF_ALLOWUNDO(0x40) 让删除走回收站；没有它 SHFileOperation 是**永久删除**。
     * FOF_NOCONFIRMATION(0x10) 不问；FOF_SILENT(0x04) 与 FOF_NOERRORUI(0x400) 压掉 UI。
     */
    '$op.fFlags = 0x0040 -bor 0x0010 -bor 0x0004 -bor 0x0400',
    '$rc = [DshShFileOp]::SHFileOperationW([ref]$op)',
    'if ($rc -ne 0) {',
    '  foreach ($p in $present) { Write-Output "ERR: $p : SHFileOperation returned $rc" }',
    '  Write-Output "OK=0 FAIL=$($present.Count + $missing.Count)"',
    '  exit 0',
    '}',
    'if ($op.fAnyOperationsAborted) {',
    '  foreach ($p in $present) { Write-Output "ERR: $p : operation aborted by the shell" }',
    '  Write-Output "OK=0 FAIL=$($present.Count + $missing.Count)"',
    '  exit 0',
    '}',
    /* 逐条复核：成功时路径应当已从原处消失。 */
    '$gone = @($present | Where-Object { -not (Test-Path -LiteralPath $_) })',
    '$left = @($present | Where-Object { Test-Path -LiteralPath $_ })',
    'foreach ($p in $left) { Write-Output "ERR: $p : still present after the shell operation" }',
    'Write-Output "OK=$($gone.Count) FAIL=$($left.Count + $missing.Count)"',
  ]
    .join('\n')
    .replace('$CS_BODY_PLACEHOLDER', csType)
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
  const summary = lines.find((line) => /^OK=\d+\s+FAIL=\d+\s*$/.test(line.trim()))
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
export async function recycleManyToSystemBin(absPaths: readonly string[]): Promise<RecycleManyOutcome> {
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

  /*
   * 路径写进临时文件，脚本从文件读 —— 命令行长度与路径数无关。
   *
   * 用 `mkdtempSync` 拿一个独占目录，避免并发两次删除时互相覆盖路径清单。
   */
  let listDir: string
  try {
    listDir = mkdtempSync(path.join(tmpdir(), 'dsd-recycle-'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, recycled: 0, reason: `could not create the path list: ${message}` }
  }
  const listPath = path.join(listDir, 'paths.txt')

  try {
    writeFileSync(listPath, absPaths.join('\n'), 'utf8')
    const script = buildRecycleManyScript()
    /*
     * 超时按条目数放大：一个进程处理 N 条，每条约 160ms，留一倍余量。
     */
    const timeout = Math.max(COMMAND_TIMEOUT_MS, 5_000 + 400 * absPaths.length)

    /*
     * ## 异步执行，不阻塞宿主（2026-11-04 审查 Critical-3）
     *
     * `execFileSync` 会把 DSH 宿主进程整个卡住：1 万条按 162ms/项 ≈ 27 分钟，
     * 期间模型和界面都动不了。这正是 2026-10-30 那起事故的形态。
     *
     * 用回调版包成 Promise：宿主事件循环照常转，只让这次删除自己等。
     */
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // 用 `& { }` 把 listPath 作为变量注入，脚本正文本身不含任何路径。
          // 先切 UTF-8 输出，否则 5.1 在中文系统上用 GBK 写 stdout（见上）。
          `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $listPath = '${listPath.replace(/'/g, "''")}'; ${script}`,
        ],
        { timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, out) => {
          if (error !== null) reject(error)
          else resolve(String(out))
        },
      )
    })

    const parsed = parseRecycleManyOutput(stdout)
    /*
     * ## 部分成功也照实报告（2026-11-04 审查 Important-7）
     *
     * 上一版把 `fail > 0` 当整体失败，调用方于是回落到安全区并把**全部**路径
     * 再处理一遍 —— 已经进回收站的那些会报 "not found"，用户看到的是
     * 「删除 1 条」而实际 99 条已在回收站里。
     *
     * 现在：只要有成功的就按成功返回，末位附上失败明细，让调用方只处理
     * 真正没做成的那些。
     */
    if (parsed.ok > 0) {
      consecutiveFailures = 0
      if (parsed.fail === 0) return { ok: true, recycled: parsed.ok }
      return {
        ok: true,
        recycled: parsed.ok,
        failed: parsed.errors,
      }
    }

    recordRecycleFailure()
    const detail = parsed.errors.length > 0 ? `: ${parsed.errors.slice(0, 3).join('; ')}` : ''
    return {
      ok: false,
      recycled: 0,
      reason: `${parsed.fail} item(s) could not be recycled${detail}`,
    }
  } catch (error) {
    recordRecycleFailure()
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, recycled: 0, reason: `SendToRecycleBin failed: ${message}` }
  } finally {
    try {
      rmSync(listDir, { recursive: true, force: true })
    } catch {
      /* 清理临时目录失败不影响结果 */
    }
  }
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
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer'
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

/**
 * 单个文件是否超过该卷回收站容量上限。
 *
 * ## 为什么要查这个（2026-11-04 审查 Important-9）
 *
 * Windows 在条目**超过回收站上限**时会**永久删除并返回成功**。插件无法阻止，
 * 也无法事后感知 —— 只能事前问。
 *
 * 上限读 `BitBucket\Volume\*\MaxCapacity`（MB）。读不到时不判风险：
 * 不能因为一次读注册表失败就拦住所有删除。
 *
 * 只对**单个文件**判断：目录的递归大小在回收站模式下刻意不统计。
 *
 * @param sizeBytes 目标大小（调用方已 statSync）。
 * @param options 注入点（测试用）。
 * @returns 超限时的说明；未超限或无法判定时返回 `undefined`。
 */
/*
 * 回收站每卷上限的缓存。
 *
 * ## 为什么必须缓存（2026-11-04 自检）
 *
 * 每次读注册表要 spawn 两次 `reg.exe`，实测 **162.8ms**。而 `deleteMany`
 * 对**每个文件**判一次配额 —— 删 1000 个文件就是 163 秒，删 5000 个是
 * 13.6 分钟。这正是「大量删除卡顿」，而且是我自己加配额检测时引入的。
 *
 * 上限在运行期不会变（改回收站大小要动系统设置），所以读一次就够了。
 * 用 `undefined` 表示「还没读过」，`null` 表示「读过了但读不到」——
 * 两者必须分开，否则每次都会重试一次失败的读取。
 */
let quotaLimitCache: number | null | undefined
let quotaCacheReader: ((key: string) => number | undefined) | undefined
let quotaCacheLister: (() => string[]) | undefined

/**
 * 清空配额缓存（测试用；生产路径不需要）。
 */
export function resetQuotaCache(): void {
  quotaLimitCache = undefined
  quotaCacheReader = undefined
  quotaCacheLister = undefined
}

/**
 * 读一次「本机最小的回收站每卷上限」（字节）。
 *
 * @param readCapacity 单个卷的读取函数。
 * @param listKeys 列卷函数。
 * @returns 上限字节数；读不到返回 `null`。
 */
function quotaLimitBytes(
  readCapacity: (volumeKey: string) => number | undefined,
  listKeys: () => string[],
): number | null {
  if (quotaCacheReader === readCapacity && quotaCacheLister === listKeys && quotaLimitCache !== undefined) return quotaLimitCache

  let keys: string[]
  try {
    keys = listKeys()
  } catch {
    quotaCacheReader = readCapacity
    quotaCacheLister = listKeys
    quotaLimitCache = null
    return null
  }

  let smallestMb: number | undefined
  for (const key of keys) {
    let mb: number | undefined
    try {
      mb = readCapacity(key)
    } catch {
      mb = undefined
    }
    if (mb === undefined || mb <= 0) continue
    if (smallestMb === undefined || mb < smallestMb) smallestMb = mb
  }

  quotaCacheReader = readCapacity
  quotaCacheLister = listKeys
  quotaLimitCache = smallestMb === undefined ? null : smallestMb * 1024 * 1024
  return quotaLimitCache
}

/**
 * 单个文件是否超过该卷回收站容量上限。
 *
 * ## 为什么要查这个（2026-11-04 审查 Important-9）
 *
 * Windows 在条目**超过回收站上限**时会**永久删除并返回成功**。插件无法阻止，
 * 也无法事后感知 —— 只能事前问。
 *
 * 只对**单个文件**判断：目录的递归大小在回收站模式下刻意不统计。
 *
 * 上限读取有进程内缓存（见 `quotaLimitCache`），所以对 N 个文件判断只读一次
 * 注册表。
 *
 * @param sizeBytes 目标大小（调用方已 statSync）。
 * @param options 注入点（测试用）。
 * @returns 超限时的说明；未超限或无法判定时返回 `undefined`。
 */
export function detectQuotaRisk(
  sizeBytes: number,
  options: {
    platform?: NodeJS.Platform
    readCapacityMb?: (volumeKey: string) => number | undefined
    listVolumeKeys?: () => string[]
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return undefined
  if (sizeBytes <= 0) return undefined

  const readCapacity = options.readCapacityMb ?? readCapacityViaReg
  const listKeys = options.listVolumeKeys ?? listBitBucketVolumeKeys
  // Function identity matters: equal source text can capture different capacities.
  const limitBytes = quotaLimitBytes(readCapacity, listKeys)
  if (limitBytes === null) return undefined
  if (sizeBytes <= limitBytes) return undefined

  return (
    `the file is larger than the recycle bin's per-volume limit ` +
    `(${Math.round(limitBytes / (1024 * 1024))} MB): Windows will delete it permanently instead of recycling it`
  )
}

/** 列出 BitBucket 下的卷键（形如 `{GUID}` 或卷名）。 */
function listBitBucketVolumeKeys(): string[] {
  const root = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume'
  try {
    const out = execFileSync('reg', ['query', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('HKEY_CURRENT_USER\\') || line.startsWith('HKEY_'))
  } catch {
    return []
  }
}

/** 读一个卷键的 `MaxCapacity`（MB）。 */
function readCapacityViaReg(volumeKey: string): number | undefined {
  try {
    const out = execFileSync('reg', ['query', volumeKey, '/v', 'MaxCapacity'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const line = out.split(/\r?\n/).find((l) => l.includes('MaxCapacity'))
    if (line === undefined) return undefined
    const parts = line.trim().split(/\s+/)
    const raw = parts[parts.length - 1] ?? ''
    const value = raw.startsWith('0x') ? Number.parseInt(raw, 16) : Number(raw)
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}
