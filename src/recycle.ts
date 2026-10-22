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
 * 把一个路径移入系统回收站。
 *
 * @param absPath 要移入的绝对路径（文件或目录）。
 * @returns 结果；失败时带原因，调用方**不可**据此永久删除。
 */
export function moveToSystemRecycleBin(absPath: string): RecycleOutcome {
  if (!existsSync(absPath)) return { ok: false, reason: `path does not exist: ${absPath}` }

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
