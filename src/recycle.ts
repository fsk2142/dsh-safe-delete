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

import { execFile, execFileSync, spawnSync } from 'node:child_process'
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
      /**
       * 失败条目的**原始路径**。
       *
       * 与 `failed` 分开：后者是给人看的描述，这里是给调用方做**精确比对**的。
       * 曾经让调用方从 `failed` 里 `split(' : ')[0]` 反推路径 —— 那是在用
       * 字符串拼结构化数据，路径里一旦含分隔符就会截断。
       */
      failedPaths?: string[]
      /**
       * 确实已移入回收站的原始路径。
       *
       * ## 为什么必须单独给（2026-11-05 复审 A05）
       *
       * 只知道「哪些失败了」不够：`SHFileOperationW` 允许**部分完成**
       * （返回非零或 `fAnyOperationsAborted` 时，前面几条可能已经移走）。
       * 调用方拿到 `ok:false` 就整批回落到安全区，于是已经进回收站的路径
       * 会报 "not found"，用户看到「回落安全区」而实际一部分在回收站。
       *
       * 有了这份清单，调用方可以对**每条**路径说清去向。
       */
      succeededPaths?: string[]
    }
  | {
      ok: false
      reason: string
      recycled: number
      unsupported?: boolean
      /** 即使总体上失败，也可能有个别条目真的移走了 —— 逐条给出来。 */
      succeededPaths?: string[]
      failedPaths?: string[]
      /** 逐条失败原因（人类可读，只用于展示）。 */
      failed?: string[]
    }

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
 * Windows：把路径移入回收站，用 `SHFileOperationW`。
 *
 * ## 为什么不用 `Remove-Item`
 *
 * 那个是永久删除（或进回收站，取决于文件大小与配置），行为不确定。
 *
 * ## 为什么从 `Shell.Application` 的 `delete` 动词换过来（2026-11-04 实测）
 *
 * `InvokeVerb('delete')` 等于替用户点了右键删除，shell 照常绘制进度 UI，
 * 而且每次都新建 COM 对象 + `ParseName` 往返（单文件实测 1187 ms → 49 ms）。
 *
 * @param absPath 绝对路径。
 * @returns 结果。
 */
function recycleOnWindows(absPath: string): RecycleOutcome {
  /*
   * ## 为什么从 InvokeVerb 换成 SHFileOperation（2026-11-04 实测）
   *
   * 用户报告：清掉 34,480 个过期条目时，Windows 弹出了「正在准备回收」窗口。
   * 那**不是**批量路径（已改 SHFileOperation），而是这里的单路径 ——
   * cleanup 把整批聚合成一个目录，再对这个目录调本函数，而它用的是
   * \`Shell.Application\` 的 \`InvokeVerb('delete')\`：那等于替用户点了右键删除，
   * shell 于是照常显示进度 UI。
   *
   * 复现（本机，20,000 个文件的目录）：
   *
   * \`\`\`
   * ⚠ 弹窗: [pwsh] 已发现 16,221 个项目(15.8 KB)...
   * \`\`\`
   *
   * 与用户截图里的标题完全一致。
   *
   * \`SHFileOperationW\` + \`FOF_ALLOWUNDO | FOF_SILENT | FOF_NOERRORUI\` 不显示 UI，
   * 且**快得多**（实测单文件 1187ms → 49ms，约 24 倍）。那 1187ms 主要是
   * 每次新建 \`Shell.Application\` COM 对象 + \`ParseName\` 往返的开销。
   *
   * \`FOF_ALLOWUNDO\` 是**承重标志**：没有它 \`SHFileOperation\` 是永久删除。
   */
  const csType = 'using System; using System.Runtime.InteropServices; public static class DshShFileOpSingle { [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct SHFILEOPSTRUCTW { public IntPtr hwnd; public uint wFunc; [MarshalAs(UnmanagedType.LPWStr)] public string pFrom; [MarshalAs(UnmanagedType.LPWStr)] public string pTo; public ushort fFlags; [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted; public IntPtr hNameMappings; [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle; } [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHFileOperationW")] public static extern int SHFileOperationW(ref SHFILEOPSTRUCTW lp); }'

  const script = [
    "$ErrorActionPreference = 'Stop'",
    /* 路径经环境变量传入：避免空格、$、引号进脚本文本。 */
    '$target = $env:DSD_RECYCLE_TARGET',
    'if (-not (Test-Path -LiteralPath $target)) { Write-Error "not found"; exit 2 }',
    `Add-Type -TypeDefinition '${csType}'`,
    '$op = New-Object DshShFileOpSingle+SHFILEOPSTRUCTW',
    '$op.wFunc = 3',
    '$op.pFrom = $target + [char]0 + [char]0',
    '$op.pTo = $null',
    '$op.fFlags = 0x0040 -bor 0x0010 -bor 0x0004 -bor 0x0400',
    '$rc = [DshShFileOpSingle]::SHFileOperationW([ref]$op)',
    'if ($rc -ne 0) { Write-Error "SHFileOperation returned $rc"; exit 3 }',
    'if ($op.fAnyOperationsAborted) { Write-Error "aborted by the shell"; exit 4 }',
    'exit 0',
  ].join('; ')

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DSD_RECYCLE_TARGET: absPath },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `SHFileOperation delete failed: ${message}` }
  }

  /*
   * 与旧的 InvokeVerb 不同，SHFileOperation 是**同步**的：返回 0 时路径已挪走。
   * 仍给小段宽限，覆盖同卷/跨卷的收尾差异。
   */
  waitForGone(absPath, 3000)
  if (existsSync(absPath)) {
    return { ok: false, reason: 'SHFileOperation returned success but the path still exists' }
  }
  return { ok: true }
}

function recycleOnMac(absPath: string): RecycleOutcome {
  /*
   * ## 为什么路径走 argv 而不是插值进脚本（2026-11-04 自检）
   *
   * 旧实现把路径拼进 AppleScript 源码：
   *
   * ```applescript
   * tell application "Finder" to delete POSIX file "<path>"
   * ```
   *
   * 只转义了反斜杠和双引号。路径含**换行 / 回车 / U+2028** 时，
   * AppleScript 的字符串字面量直接变非法 —— osascript 报语法错，删除失败。
   * 不是"删错地方"，而是「一个文件永远删不掉，还看不懂为什么」。
   *
   * 这是典型的「把数据插值进代码」。改法是让数据走 argv：
   * `osascript -e 'on run argv' -e '...' -e 'end run' -- <path>`。
   * 路径完全不进脚本正文，任何字符都安全。
   *
   * 对照：Linux 分支一直是对的（`execFileSync(command, [args])`），
   * 只有这里用了字符串插值。
   */
  const script = [
    'on run argv',
    '  set targetPath to item 1 of argv',
    '  tell application "Finder" to delete POSIX file targetPath',
    'end run',
  ].join('\n')

  try {
    execFileSync('osascript', ['-e', script, '--', absPath], {
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
 * 路径走 argv —— 与 macOS 分支的旧实现相反，这里从来没有把路径
 * 拼进 shell 字符串。
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
    /*
     * 空清单是**正常情况**（没有可删的），必须输出合法 JSON 且 fail=0。
     * 这里曾经漏改，还留着旧的 `OK=0 FAIL=0` 文本 —— parser 改成只认 JSON 后，
     * 空清单会被判成「解析失败」，一次本来无事发生的清理被记成 1 个失败。
     */
    'if ($targets.Count -eq 0) { [pscustomobject]@{ ok = 0; fail = 0; errors = @() } | ConvertTo-Json -Compress -Depth 4; exit 0 }',
    /*
     * 一次遍历分拣「存在」与「不存在」：原实现跑了两遍 Where-Object，
     * 每遍都对同一路径做一次文件系统往返。
     *
     * 用 [IO.File]/[IO.Directory]::Exists 而不是 Test-Path —— 后者走 PowerShell
     * 的 provider 层，实测 500 次 70ms vs 21ms。
     */
    /*
     * 用 `List[string]` 而不是 `@()` 累积。
     *
     * `$p += $x` 每次都重建数组（O(n²)），`List.Add` 是 O(1)。
     *
     * 实测（含 PowerShell 启动，3 次中位数）：
     *
     * | 规模 | `@()` 累积 | `List[string]` |
     * |---|---|---|
     * | 1 | 289ms | 269ms |
     * | 500 | 312ms | 293ms |
     * | 2000 | 419ms | 354ms |
     */
    '$present = [System.Collections.Generic.List[string]]::new()',
    '$missing = [System.Collections.Generic.List[string]]::new()',
    'foreach ($t in $targets) {',
    '  if ([System.IO.File]::Exists($t) -or [System.IO.Directory]::Exists($t)) { $present.Add($t) }',
    '  else { $missing.Add($t) }',
    '}',
    /*
     * 错误**收集**到数组，最后一次输出 JSON —— 不再逐行拼 `ERR: ` 文本。
     *
     * 理由见 parseRecycleManyOutput：调用方曾经用 `split(' : ')[0]` 从文本行
     * 里取路径，路径含 ` : ` 时会截断，导致删除失败被记成成功。
     * 路径作为 JSON 字段值传递，就不存在这个解析问题。
     */
    '$errors = [System.Collections.Generic.List[object]]::new()',
    'foreach ($m in $missing) { $errors.Add([pscustomobject]@{ path = $m; message = "not found" }) }',
    'if ($present.Count -eq 0) {',
    '  [pscustomobject]@{ ok = 0; fail = $missing.Count; moved = @(); errors = $errors.ToArray() } | ConvertTo-Json -Compress -Depth 4',
    '  exit 0',
    '}',
    /* 类型定义用单引号 here-string 交给 Add-Type。 */
    "$cs = @'\n" + '$CS_BODY_PLACEHOLDER' + '\n' + "'@",
    'Add-Type -TypeDefinition $cs',
    /*
     * ## 每条路径的去向必须**逐条复核**（2026-11-05 复审 A05）
     *
     * `SHFileOperationW` 允许**部分完成**：返回非零或 `fAnyOperationsAborted`
     * 为真时，前面几条可能已经移走了。旧脚本在这种情况下把 `$present` 全体记成
     * 失败，于是调用方整批回落到安全区，已经进回收站的那些报 "not found" ——
     * 用户看到「回落安全区」，实际一部分在回收站。
     *
     * 现在：无论 rc / aborted 如何，都按**每条路径是否还在原处**分类。
     * 已经消失的记为 moved，仍在的记为失败并附上 rc。这样去处是可追溯的。
     */
    '$moved = [System.Collections.Generic.List[string]]::new()',
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
    '$aborted = $op.fAnyOperationsAborted',
    '$rcText = if ($rc -eq 0) { "operation aborted by the shell" } else { "SHFileOperation returned " + $rc }',
    /*
     * 逐条复核。给消失一点宽限：SHFileOperationW 是同步的，但同卷/跨卷的
     * 收尾可能有毫秒级延迟。
     *
     * ## `moved` 只说明「原路径不在了」，不是「回收站里有它」
     *
     * 这个区分必须写下来（2026-11-05 第二轮复审第 5.4 条）：插件从未读取
     * 回收站的 `$I`/`$R` 条目去确认可恢复性。原路径消失只证明**它离开了
     * 原位置**；是否真的进了回收站、能不能还原，取决于系统策略、配额与
     * 文件系统（见 README「第 2 层的边界」）。所以输出里说的是
     * "moved to the recycle bin"，而不是"已确认可恢复"。
     */
    'foreach ($p in $present) {',
    '  if ([System.IO.File]::Exists($p) -or [System.IO.Directory]::Exists($p)) {',
    '    $errors.Add([pscustomobject]@{ path = $p; message = $rcText })',
    '  } else { $moved.Add($p) }',
    '}',
    '[pscustomobject]@{ ok = $moved.Count; fail = $errors.Count; moved = $moved.ToArray(); errors = $errors.ToArray() } | ConvertTo-Json -Compress -Depth 4',
  ]
    .join('\n')
    .replace('$CS_BODY_PLACEHOLDER', csType)
}

/**
 * 解析批量脚本的输出。
 *
 * 找不到可解析的 JSON 对象时按**失败**处理：脚本崩溃不该被当成成功。
 *
 * @param stdout 脚本标准输出。
 * @returns 成功数、失败数与逐条路径（结构化，不需要再解析字符串）。
 */
export function parseRecycleManyOutput(stdout: string): {
  ok: number
  fail: number
  errors: string[]
  /** 失败条目的**原始路径**（供调用方精确比对，不需要再解析字符串）。 */
  failedPaths: string[]
  /** 确实已移走的**原始路径**（部分成功时用来区分去向）。 */
  succeededPaths: string[]
  /**
   * 汇总数字与逐条清单对不上时为 `true`。
   *
   * 典型形态：脚本声称 `ok=5`，却只给出 1 条 `moved`、0 条错误。那说明脚本
   * 或协议坏了，调用方不能假装成功 —— 一个"看起来成功"的错误计数会写进审计。
   */
  inconsistent: boolean
} {
  /*
   * ## 为什么用 JSON 而不是文本行（2026-11-04 自检）
   *
   * 旧实现输出 `ERR: <path> : <message>`，调用方用 `split(' : ')[0]` 取路径。
   * 路径里只要含 ` : `（合法字符，Windows 允许），解析就截断：
   *
   * ```
   * 错误行: "C:\temp\a : b\x.txt : not found"
   * 提取:   "C:\temp\a"          ← 截断
   * ```
   *
   * 后果：该路径不在失败集合里 → 被算成成功 → 写进审计。一个真实的删除
   * 失败被记录成"已删除"，而审计最不该骗人。
   *
   * 现在脚本直接输出 JSON：路径是字段值，不参与任何字符串切分。
   */
  const trimmed = stdout.trim()
  if (trimmed === '') {
    return {
      ok: 0,
      fail: 1,
      errors: ['the recycle script produced no output'],
      failedPaths: [],
      succeededPaths: [],
      inconsistent: false,
    }
  }

  /* 脚本可能先输出别的行，找第一段可解析的 JSON。 */
  let parsed: unknown
  for (const candidate of [trimmed, ...trimmed.split(/\r?\n/).reverse()]) {
    try {
      parsed = JSON.parse(candidate)
      break
    } catch {
      /* 继续尝试 */
    }
  }

  if (parsed === null || typeof parsed !== 'object') {
    return {
      ok: 0,
      fail: 1,
      errors: ['could not parse the recycle script output'],
      failedPaths: [],
      succeededPaths: [],
      inconsistent: false,
    }
  }

  const record = parsed as { ok?: unknown; fail?: unknown; errors?: unknown; moved?: unknown }
  const ok = typeof record.ok === 'number' && Number.isFinite(record.ok) ? record.ok : 0
  const rawErrors = Array.isArray(record.errors) ? record.errors : []

  const failedPaths: string[] = []
  const messages: string[] = []
  for (const entry of rawErrors) {
    if (entry === null || typeof entry !== 'object') continue
    const e = entry as { path?: unknown; message?: unknown }
    const p = typeof e.path === 'string' ? e.path : ''
    const m = typeof e.message === 'string' ? e.message : 'unknown error'
    if (p !== '') failedPaths.push(p)
    messages.push(p === '' ? m : `${p} : ${m}`)
  }

  /*
   * `moved` 是脚本**逐条复核**之后的结论（路径是否真的从原处消失了）。
   * 老版本的脚本没有这个字段 —— 那时退化为空清单，调用方按「全部失败」处理，
   * 也就是保守方向。
   */
  const succeededPaths = Array.isArray(record.moved)
    ? record.moved.filter((p): p is string => typeof p === 'string' && p !== '')
    : []

  const declaredFail = typeof record.fail === 'number' && Number.isFinite(record.fail) ? record.fail : 0
  /*
   * 取声明值与实际错误条目的较大者：脚本说 fail=0 却给了错误明细时，
   * 不能因为汇总行把失败当成成功。
   */
  const fail = Math.max(declaredFail, rawErrors.length)

  /*
   * 计数守恒：`ok` 必须等于逐条成功清单的长度（脚本给了清单时）。
   * 对不上说明协议坏了 —— 让调用方知道，而不是替它圆场。
   */
  const inconsistent = Array.isArray(record.moved) && succeededPaths.length !== ok

  return { ok, fail, errors: messages, failedPaths, succeededPaths, inconsistent }
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
     *
     * ## 计数对不上时不能报成功（2026-11-05 复审 A05）
     *
     * 脚本声称移走了 N 条、逐条清单却不是 N 条 —— 协议坏了。那种"看起来成功"
     * 的计数会写进审计，而审计最不该骗人。此时按失败处理（保守方向），
     * 并把**逐条清单**交给调用方，让它只对确定还在原处的条目回落安全区。
     */
    if (parsed.inconsistent) {
      recordRecycleFailure()
      return {
        ok: false,
        recycled: 0,
        reason:
          `the recycle script reported ${parsed.ok} moved item(s) but listed ${parsed.succeededPaths.length}; ` +
          'its report is inconsistent, so nothing is treated as recycled',
        succeededPaths: parsed.succeededPaths,
        failedPaths: parsed.failedPaths,
      }
    }

    if (parsed.ok > 0) {
      consecutiveFailures = 0
      if (parsed.fail === 0) {
        return { ok: true, recycled: parsed.ok, succeededPaths: parsed.succeededPaths }
      }
      return {
        ok: true,
        recycled: parsed.ok,
        failed: parsed.errors,
        failedPaths: parsed.failedPaths,
        succeededPaths: parsed.succeededPaths,
      }
    }

    recordRecycleFailure()
    const detail = parsed.errors.length > 0 ? `: ${parsed.errors.slice(0, 3).join('; ')}` : ''
    return {
      ok: false,
      recycled: 0,
      reason: `${parsed.fail} item(s) could not be recycled${detail}`,
      /*
       * 即使 `ok=false`，也可能有个别条目真的移走了（脚本的逐条复核会告诉我们）。
       * 不交出去的话，调用方会把它们再次交给安全区，然后对着 "not found" 报错。
       */
      ...(parsed.succeededPaths.length === 0 ? {} : { succeededPaths: parsed.succeededPaths }),
      ...(parsed.failedPaths.length === 0 ? {} : { failedPaths: parsed.failedPaths }),
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
 * 「删除会被系统永久执行」的三种状态。
 *
 * ## 为什么不是一个布尔（2026-11-05 第二轮复审 R02）
 *
 * 旧实现只有一个 `risky: boolean`，于是把三种不同的情况压成了两种：
 *
 * | 事实 | 旧值 | 正确语义 |
 * |---|---|---|
 * | 读到策略，值为 1 | risky | **risky** |
 * | 读到策略，值为 0 / 未设置 | safe | **safe** |
 * | 读注册表抛错 / 值解析不了 | safe | **unknown** ← 错的 |
 *
 * `risky: false` 的下游动作是「不问，直接进回收站」。把「无法确认」也报成
 * false，等于保护性检查**只是停止保护** —— 不抛错、不打日志，正是本插件
 * 反复被咬的那种静默失效。
 */
export type RiskStatus = 'risky' | 'safe' | 'unknown'

export type PermanentDeleteRisk = {
  /** 三态判定。`unknown` 必须按风险处理（ask / never 下拒绝）。 */
  status: RiskStatus
  /**
   * 兼容字段：`status === 'risky'`。
   *
   * 保留它是因为调用点很多，且**只有确定 risky 才该当成确定永久删除**；
   * `unknown` 在 `risky` 上仍是 false，别把它读成「安全」—— 判 `status`。
   */
  risky: boolean
  reason?: string
}

/**
 * 一次 `reg` 调用的结果。
 *
 * 用「退出码 + 输出」而不是异常，是因为**异常里没有可判定的语义**：
 * `execFileSync` 抛出的东西对不同失败原因长得一样，调用方只能猜。
 */
export type RegQueryOutcome = {
  status: number | null
  stdout?: string
  stderr?: string
  /** 进程根本没起来（ENOENT / EACCES / 被策略拦截）。 */
  spawnError?: string
}

/**
 * 执行一次 `reg query`。`name` 省略表示查询整个键。
 *
 * 抽成参数是为了让测试能在**不碰真实注册表**的前提下构造
 * 「访问被拒绝」「起不来」「输出异常」—— 这三种在这台机器上构造不出来。
 */
export type RegQueryRunner = (key: string, name?: string) => RegQueryOutcome

/**
 * 读注册表值的结果（三态）。
 *
 * ## 为什么不能是 `string | undefined`（2026-11-05 第三轮复审 R01）
 *
 * `undefined` 同时承担了两个相反的语义：
 *
 * | 事实 | 该字段的旧值 | 下游结论 |
 * |---|---|---|
 * | 值确实不存在 | `undefined` | safe（对） |
 * | 访问被拒绝 | `undefined` | safe（**错**） |
 * | `reg.exe` 起不来 | `undefined` | safe（**错**） |
 * | 查询失败 / 输出解析不了 | `undefined` | safe（**错**） |
 *
 * 而 `safe` 的下游动作是「不问、直接进回收站」，那一步可能是永久删除。
 * 所以结果类型必须**能把"不存在"和"读不到"分开**。
 */
export type RegistryReadResult =
  | { kind: 'value'; value: string }
  | { kind: 'missing' }
  | { kind: 'error'; reason: string }

/** 读取注册表值的替身（测试注入）。 */
export type RegistryRead = (key: string, name: string) => RegistryReadResult

/**
 * `detectPermanentDeleteRisk` 接受的读取函数。
 *
 * 允许直接返回字符串是给**测试**用的便利写法：`() => '1'` 明确表达
 * "读到了 1"。注意它**没有** `undefined` 这一档 —— 想表达"值不存在"必须写
 * `{ kind: 'missing' }`，这样"读不到"就没法被悄悄写成"不存在"。
 */
export type RegistryReader = (key: string, name: string) => RegistryReadResult | string

/**
 * 把任意返回值收敛成 `RegistryReadResult`。**这一层是运行时的兜底。**
 *
 * ## 为什么类型收窄还不够（2026-11-05 自检）
 *
 * 上一版直接 `raw.kind`。类型上 `RegistryReader` 已经不允许 `undefined`，但运行时
 * 仍然会有：JS 调用方、旧版本注入的适配器、`as any`、以及任何我没预料到的写法。
 * 一旦漏进来，`detectPermanentDeleteRisk()` 就抛 `TypeError`。
 *
 * 而它是在 `apply()` 里**同步**调用的，`apply()` 没有 try/catch：
 *
 * ```text
 * apply() 抛错 → pre-execute 钩子没注册 → 所有删除都没有拦截
 * ```
 *
 * 一个保护性检查的崩溃会让保护**完全消失**。所以这里宁可把不认识的返回值
 * 判成 `unknown`（= 问人），也绝不抛错。类型层防"写错"，运行时层防"加载崩"。
 *
 * @param result 读取函数的原始返回值。
 * @returns 规范化后的结果；无法识别时是 `error`（= unknown）。
 */
function coerceRegistryRead(result: unknown): RegistryReadResult {
  if (typeof result === 'string') return { kind: 'value', value: result }
  if (result !== null && typeof result === 'object') {
    const kind = (result as { kind?: unknown }).kind
    if (kind === 'missing') return { kind: 'missing' }
    if (kind === 'value') {
      const value = (result as { value?: unknown }).value
      if (typeof value === 'string') return { kind: 'value', value }
      return { kind: 'error', reason: 'the registry reader returned a "value" result without a string value' }
    }
    if (kind === 'error') {
      const reason = (result as { reason?: unknown }).reason
      return {
        kind: 'error',
        reason: typeof reason === 'string' ? reason : 'the registry read failed without a reason',
      }
    }
  }
  /*
   * `undefined` / `null` / 数字 / 布尔 / 数组 / 无 kind 的对象。
   *
   * 旧测试里的 `() => undefined` 曾经表示"值不存在"。那正是 R01 要消灭的歧义，
   * 所以这里**不能**把它当 missing —— 它是一个不该出现的返回值，按未知处理。
   */
  return {
    kind: 'error',
    reason: `the registry reader returned an unrecognised result (${result === null ? 'null' : typeof result})`,
  }
}

/**
 * 默认的 `reg` 执行器。
 *
 * 编码用 `utf8`：`reg.exe` 的错误消息来自 MUI 资源，中文系统上是 GBK。
 * 按 utf8 解会得到乱码 —— 但**同样的字节得到同样的乱码**，而下面判断的是
 * 「两条消息是否相同」，所以乱码不影响结论。刻意不做编码探测：那会让这个
 * 零依赖的插件去猜系统代码页。
 *
 * @param key 注册表键。
 * @param name 值名；省略表示查询整个键。
 * @returns 退出码与输出，不抛异常。
 */
function runRegQuery(key: string, name?: string): RegQueryOutcome {
  const args = name === undefined ? ['query', key] : ['query', key, '/v', name]
  const result = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true })
  const status = result.status ?? null
  if (result.error !== undefined && result.error !== null) {
    return { status, spawnError: result.error.message }
  }
  return { status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 控制探针用的键：任何 Windows 账户下都必然可读。 */
const PROBE_KEY = 'HKCU\\Software'
/** 必然不存在的值名 —— 用来取本机"找不到"这一条消息的原文。 */
const PROBE_VALUE = '__dsh_safe_delete_probe__'

/**
 * 把一条 `reg` 消息规范成可比较的形态。
 *
 * 只做与语言无关的规整（去首尾空白、压缩内部空白、小写）——
 * **不比对任何具体文本**，否则换一种系统语言就静默失效。
 *
 * @param text 原文。
 * @returns 规范后的文本。
 */
function normaliseMessage(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 从 `reg query` 的输出里取出某个值的最后一段。
 *
 * 输出形如：
 *
 * ```text
 * HKEY_CURRENT_USER\...\Explorer
 *     NoRecycleFiles    REG_DWORD    0x1
 * ```
 *
 * ## 必须按"值名整列相等"匹配（第三轮复审 R01）
 *
 * 旧实现用 `line.includes(name)` —— `NoRecycleFilesBackup` 也会命中，
 * 于是备份值的 `0x1` 会被当成主策略值。这里比较第一列是否**整串相等**。
 *
 * 值的类型列（`REG_DWORD` / `REG_SZ`）之后才是数据；`REG_SZ` 可能含空格，
 * 所以取类型列之后的**全部**内容，而不是最后一个 token。
 *
 * @param stdout 输出。
 * @param name 值名。
 * @returns 数据；没找到返回 `undefined`。
 */
function parseValueLine(stdout: string, name: string): string | undefined {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('HKEY_')) continue
    const parts = line.split(/\s+/)
    if (parts[0] !== name) continue
    const typeAt = parts.findIndex((p) => p.startsWith('REG_'))
    if (typeAt < 0 || typeAt + 1 >= parts.length) continue
    return parts.slice(typeAt + 1).join(' ')
  }
  return undefined
}

/**
 * 造一个三态注册表读取器。
 *
 * ## 判据：同语言的控制探针（第三轮复审 R01）
 *
 * "值不存在"与"访问被拒绝"的**消息不同**，而两台机器只是语言不同。
 * 所以这里不比对绝对文本，而是比对**相对差异**：
 *
 * 1. 正值控制 `reg query HKCU\Software` 必须成功 —— 否则这台机器上
 *    `reg` 本身就不可信，一切结论都得是 `unknown`；
 * 2. 负值控制 `reg query HKCU\Software /v <不存在的值>` 取得本机
 *    "找不到"这条消息；
 * 3. 目标查询的消息与负值控制**逐字相同** → 确认不存在；否则 → 读失败。
 *
 * 控制探针只在失败路径跑，正常路径没有额外成本；负值控制的结果会被记住。
 *
 * @param run `reg` 执行器（测试注入）。
 * @returns 读取器。
 */
export function createRegReader(run: RegQueryRunner = runRegQuery): RegistryRead {
  /** `undefined` = 还没探过；`null` = 探针本身不可信。 */
  let notFoundMessage: string | null | undefined

  const probeNotFound = (): string | null => {
    if (notFoundMessage !== undefined) return notFoundMessage
    notFoundMessage = null
    const positive = run(PROBE_KEY)
    if (positive.spawnError !== undefined || positive.status !== 0) return notFoundMessage
    const negative = run(PROBE_KEY, PROBE_VALUE)
    if (negative.spawnError !== undefined || negative.status === 0) return notFoundMessage
    const text = normaliseMessage(negative.stderr)
    // 没有消息的失败无法与"访问被拒绝"区分 —— 不能据此说"不存在"。
    if (text === '') return notFoundMessage
    notFoundMessage = text
    return notFoundMessage
  }

  return (key, name) => {
    const outcome = run(key, name)
    if (outcome.spawnError !== undefined) {
      return { kind: 'error', reason: `could not run reg.exe (${outcome.spawnError})` }
    }
    if (outcome.status === 0) {
      const value = parseValueLine(outcome.stdout ?? '', name)
      return value === undefined
        ? { kind: 'error', reason: `reg query ${key} succeeded but its output had no "${name}" value` }
        : { kind: 'value', value }
    }
    const notFound = probeNotFound()
    const message = normaliseMessage(outcome.stderr)
    if (notFound !== null && message !== '' && message === notFound) return { kind: 'missing' }
    return {
      kind: 'error',
      reason:
        `could not read ${key} /v ${name}: whether Windows will delete permanently is unknown` +
        (message === '' ? ' (reg printed no error message)' : ` — ${notFound === null ? 'the reference probe could not run' : message.slice(0, 120)}`),
    }
  }
}

/**
 * 检测「删除会被系统永久执行」的策略。
 *
 * ## 读失败 ≠ 确认安全（2026-11-05 第二轮复审 R02）
 *
 * 旧实现 catch 之后返回 `{ risky: false }` 并在注释里写「不能因为一次读注册表
 * 失败就拦住所有删除」。那条件本身没错，错在**结论**：读失败说明的是「不知道」，
 * 不是「没有这条策略」。把未知当安全，等于在受限账户 / 策略被拦 / 非标准卷上
 * 静默关掉这层保护。
 *
 * 现在分三态。`unknown` 的处置交给调用方：
 * 回收站模式下 ask，`never` 下拒绝（见 `decideHookRisk` 与 `deletePath`）。
 *
 * @param options.platform 平台（测试注入，默认 `process.platform`）。
 * @param options.readRegistry 注册表读取替身。
 * @returns 三态判定。`status === 'risky'` 时调用方必须先问人。
 */
export function detectPermanentDeleteRisk(
  options: {
    platform?: NodeJS.Platform
    readRegistry?: RegistryReader
  } = {},
): PermanentDeleteRisk {
  const platform = options.platform ?? process.platform
  // 非 Windows 没有回收站策略；那是**确认不适用**，不是未知。
  if (platform !== 'win32') return { status: 'safe', risky: false }

  const read = options.readRegistry ?? createRegReader()
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer'
  let raw: RegistryReadResult
  try {
    raw = coerceRegistryRead(read(key, 'NoRecycleFiles'))
  } catch (error) {
    return {
      status: 'unknown',
      risky: false,
      reason:
        `could not read the NoRecycleFiles policy (${error instanceof Error ? error.message : String(error)}); ` +
        'whether Windows will delete permanently is unknown',
    }
  }

  /*
   * ## 只有"确认查询成功且值确实不存在"才是 safe（第三轮复审 R01）
   *
   * 旧实现在这里只判 `raw === undefined`，而生产适配器把**所有**异常也折成
   * `undefined` —— 于是访问被拒绝、`reg.exe` 起不来、输出解析不了，全都走到
   * `safe`，也就是"不问、直接进回收站"。
   */
  if (raw.kind === 'error') {
    return { status: 'unknown', risky: false, reason: raw.reason }
  }
  if (raw.kind === 'missing') return { status: 'safe', risky: false }

  const value = raw.value.trim().toLowerCase()
  // 注册表里既可能是 DWORD（0x1 / 1），也可能被手工写成字符串。
  const enabled = value === '1' || value === '0x1' || value === 'true'
  const disabled = value === '0' || value === '0x0' || value === 'false'
  if (enabled) {
    return {
      status: 'risky',
      risky: true,
      reason:
        'the NoRecycleFiles policy is enabled: Windows will permanently delete instead of using the recycle bin',
    }
  }
  if (disabled) return { status: 'safe', risky: false }

  /*
   * 读到了值，但解析不出含义（`maybe`、被截断的输出、非预期类型）。
   * 那同样是「不知道」—— 不能因为读到了字符串就当安全。
   */
  return {
    status: 'unknown',
    risky: false,
    reason: `the NoRecycleFiles policy has an unrecognised value ("${value.slice(0, 40)}"); whether Windows will delete permanently is unknown`,
  }
}

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
 *
 * ## 缓存的是**三态结论**，不是一个数值（2026-11-05 第三轮复审 R02）
 *
 * 旧实现把"成功读到的那些卷的最小值"当成数字缓存下来；某个卷读失败时它只是
 * 被跳过，于是**不完整的结果被永久当成上界**。现在缓存的是 `QuotaLimit`：
 * 记住 `unknown` 是安全的（它不可能变成一个错误的安全结论），记住一个
 * 缺了某个卷的数字则不是。
 */
let quotaLimitCache: QuotaLimit | undefined
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
 * 「本机最小的回收站每卷上限」的读取结果。
 *
 * ## 为什么不是一个 `number | null`（2026-11-05 第三轮复审 R02）
 *
 * `null` 表示"读不到"，但它和"只读到了一部分卷"共用了同一个位置 ——
 * 后者在旧实现里被当成**数字**返回：取成功卷中的最小值，然后当成所有卷的上界。
 *
 * | 卷 | 真实上限 | 查询 |
 * |---|---|---|
 * | C | 10 GB | 成功 |
 * | D | 500 MB | 失败 |
 *
 * 结论变成"上界 10 GB"，而 D 盘上的 1 GB 文件其实会被 Windows 永久删除。
 * "成功卷中的最小值"只有在**所有卷都读取成功**时才是全局保守下界。
 */
export type QuotaLimit =
  | { kind: 'known'; bytes: number }
  | { kind: 'unknown'; reason: string }

/**
 * 读一次「本机最小的回收站每卷上限」。
 *
 * 任意一卷读失败 → 整体 `unknown`。少一个卷的数据，就没有全局上界。
 *
 * @param readCapacity 单个卷的读取函数。
 * @param listKeys 列卷函数。
 * @returns 三态结论（已缓存，函数标识不同即视为不同来源）。
 */
function quotaLimitBytes(
  readCapacity: (volumeKey: string) => number | undefined,
  listKeys: () => string[],
): QuotaLimit {
  if (quotaCacheReader === readCapacity && quotaCacheLister === listKeys && quotaLimitCache !== undefined) {
    return quotaLimitCache
  }
  const remember = (limit: QuotaLimit): QuotaLimit => {
    quotaCacheReader = readCapacity
    quotaCacheLister = listKeys
    quotaLimitCache = limit
    return limit
  }

  let keys: string[]
  try {
    keys = listKeys()
  } catch {
    return remember({
      kind: 'unknown',
      reason: 'the list of recycle-bin volumes could not be read from the registry',
    })
  }
  if (keys.length === 0) {
    return remember({
      kind: 'unknown',
      reason: 'the registry lists no recycle-bin volume, so no per-volume limit can be established',
    })
  }

  let smallestMb: number | undefined
  for (const key of keys) {
    let mb: number | undefined
    try {
      mb = readCapacity(key)
    } catch {
      mb = undefined
    }
    /*
     * 值缺失 / 0 / 负数 / NaN / Infinity 都不是可用上界。
     * 旧实现 `continue` 掉它们，等于把该卷当成"没有限制"。
     */
    if (mb === undefined || !Number.isFinite(mb) || mb <= 0) {
      return remember({
        kind: 'unknown',
        reason: `the recycle-bin limit of volume ${key} could not be read, so no safe bound covers every volume`,
      })
    }
    if (smallestMb === undefined || mb < smallestMb) smallestMb = mb
  }

  // 上面已经排除了 keys 为空与任何一卷失败，这里 smallestMb 必然有值。
  return remember({ kind: 'known', bytes: (smallestMb ?? 0) * 1024 * 1024 })
}

/**
 * 单个文件的配额判定结果（三态）。
 *
 * ## 为什么要三态（2026-11-05 第二轮复审 R01/R02）
 *
 * 旧实现返回 `string | undefined`，`undefined` 同时表示「文件没超」和
 * 「上限读不到」——两者的安全含义完全相反：
 *
 *   - 没超 → 可以静默进回收站；
 *   - 上限读不到 → **不知道**会不会被永久删除。
 *
 * 同一份语义压缩让上层无法正确措辞，也无法正确决策。现在分开。
 */
export type QuotaAssessment =
  | { status: 'over'; reason: string }
  | { status: 'within' }
  | { status: 'unknown'; reason: string }

/**
 * 评估一个目标相对回收站上限的风险。
 *
 * ## `sizeIsLowerBound`（R01）
 *
 * 回收站模式跳过目录的递归统计，只量顶层（`shallowBytes`）。那是一个**下界**：
 * 嵌套深处的 20 GB 文件不会体现在里面。所以：
 *
 * - 下界已经超过上限 → 确定 over（实际只会更大）；
 * - 下界没超、但真实大小未知 → **unknown**，按风险处理；
 * - 只有能确认完整大小（单文件、或安全区模式的递归统计）才给 within。
 *
 * 这条把「目录只量顶层」从**静默漏检**变成**显式不确定**：前者不会有人发现，
 * 后者会走审批。
 *
 * @param sizeBytes 已知大小（字节）。
 * @param options.sizeIsLowerBound 该大小只是下界（目录内容未完整统计）。
 * @param options.platform 平台（测试注入）。
 * @param options.readCapacityMb 卷容量读取替身。
 * @param options.listVolumeKeys 列卷替身。
 * @returns 三态判定。
 */
export function assessQuota(
  sizeBytes: number,
  options: {
    platform?: NodeJS.Platform
    readCapacityMb?: (volumeKey: string) => number | undefined
    listVolumeKeys?: () => string[]
    sizeIsLowerBound?: boolean
  } = {},
): QuotaAssessment {
  const platform = options.platform ?? process.platform
  // 非 Windows 没有回收站配额；那是确认不适用。
  if (platform !== 'win32') return { status: 'within' }
  if (sizeBytes < 0) return { status: 'within' }

  const readCapacity = options.readCapacityMb ?? readCapacityViaReg
  const listKeys = options.listVolumeKeys ?? listBitBucketVolumeKeys
  // Function identity matters: equal source text can capture different capacities.
  const limit = quotaLimitBytes(readCapacity, listKeys)

  if (limit.kind === 'unknown') {
    return {
      status: 'unknown',
      reason: `${limit.reason}: whether this item exceeds it cannot be verified`,
    }
  }

  const limitBytes = limit.bytes
  if (sizeBytes > limitBytes) {
    return {
      status: 'over',
      reason:
        `the file is larger than the recycle bin's per-volume limit ` +
        `(${Math.round(limitBytes / (1024 * 1024))} MB): Windows will delete it permanently instead of recycling it`,
    }
  }

  if (options.sizeIsLowerBound === true) {
    return {
      status: 'unknown',
      reason:
        `only ${Math.round(sizeBytes / (1024 * 1024))} MB could be measured at the top level (recursive stats are ` +
        `skipped in recycle-bin mode), while the limit is ${Math.round(limitBytes / (1024 * 1024))} MB: ` +
        'a file nested deeper may exceed it and be deleted permanently',
    }
  }

  return { status: 'within' }
}

/**
 * 兼容包装：超过上限**或无法判定**时返回一句说明，确定没超时返回 `undefined`。
 *
 * 调用方若需要区分「超了」与「不知道」（措辞、审计），用 `assessQuota`。
 *
 * @param sizeBytes 目标大小。
 * @param options 注入点（测试用）。
 * @returns 风险说明；确定没风险时 `undefined`。
 */
export function detectQuotaRisk(
  sizeBytes: number,
  options: {
    platform?: NodeJS.Platform
    readCapacityMb?: (volumeKey: string) => number | undefined
    listVolumeKeys?: () => string[]
    sizeIsLowerBound?: boolean
  } = {},
): string | undefined {
  const assessment = assessQuota(sizeBytes, options)
  return assessment.status === 'within' ? undefined : assessment.reason
}

/** 列出 BitBucket 下的卷键（形如 `{GUID}` 或卷名）。 */
function listBitBucketVolumeKeys(): string[] {
  /*
   * root 用**完整**前缀，与 `reg query` 输出一致。
   *
   * 传 `HKCU\...` 给 reg 是可以的（它会展开），但**输出**里写的是
   * `HKEY_CURRENT_USER\...`。用缩写去做 startsWith 永远匹配不上 ——
   * 那会让配额完全读不到，超配额文件静默永久删除。
   */
  const root = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume'
  try {
    const out = execFileSync('reg', ['query', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      /*
       * 只接受 root 的**子键**：`reg query <root>` 列出的子键都以 root 开头。
       *
       * 旧写法是 `line.startsWith('HKEY_')` —— 过宽。虽然当前输出里只有键行
       * 以 HKEY_ 开头（值行有缩进，被 trim 后以值名开头），但如果某个卷的键里
       * 恰好有一个**值**名叫 `HKEY_whatever`，它就会被当成卷键，然后拿去读
       * MaxCapacity，得到一个空结果。
       *
       * 加 root + 反斜杠前缀后，只有真正的子键能通过。
       */
      .filter((line) => line.startsWith(`${root}\\`))
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
