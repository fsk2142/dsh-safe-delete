import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
//#region src/recycle.ts
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
/**
* 判断当前平台是否支持「移入回收站」。
*
* @returns 支持的平台返回 `true`。
*/
function canRecycle() {
	return process.platform === "win32" || process.platform === "darwin" || process.platform === "linux";
}
/** 调用外部命令的统一超时（毫秒）。 */
const COMMAND_TIMEOUT_MS = 2e4;
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
const FAILURE_BREAKER_THRESHOLD = 3;
/** 当前连续失败次数（进程内）。成功一次就归零。 */
let consecutiveFailures = 0;
/**
* 回收站是否已被熔断。
*
* @returns 连续失败达到阈值时返回 `true`。
*/
function recycleIsTripped() {
	return consecutiveFailures >= FAILURE_BREAKER_THRESHOLD;
}
/**
* 重置熔断状态（测试用，或用户在状态命令里主动重试时）。
*/
function resetRecycleBreaker() {
	consecutiveFailures = 0;
}
/**
* 当前连续失败次数（测试与状态展示用）。
*
* @returns 连续失败计数。
*/
function recycleFailureCount() {
	return consecutiveFailures;
}
/**
* 熔断阈值（测试用，避免在测试里硬编码 3）。
*
* @returns 连续失败达到多少会跳闸。
*/
function recycleBreakerThreshold() {
	return FAILURE_BREAKER_THRESHOLD;
}
/**
* 记录一次失败的回收尝试。
*
* 抽成函数是为了让**跳闸路径本身**可以被测试直接驱动：真实失败需要 shell 出问题，
* 测试无法可靠制造那种环境。生产代码也走这里，所以测的不是影子逻辑。
*
* @returns 记录之后的连续失败次数。
*/
function recordRecycleFailure() {
	consecutiveFailures += 1;
	return consecutiveFailures;
}
/**
* 把一个路径移入系统回收站。
*
* @param absPath 要移入的绝对路径（文件或目录）。
* @returns 结果；失败时带原因，调用方**不可**据此永久删除。
*/
function moveToSystemRecycleBin(absPath) {
	if (recycleIsTripped()) return {
		ok: false,
		reason: `recycle bin unavailable after ${consecutiveFailures} consecutive failures; entries stay in the safe zone. Restart DSH to retry.`
	};
	if (!existsSync(absPath)) return {
		ok: false,
		reason: `path does not exist: ${absPath}`
	};
	const outcome = attemptRecycle(absPath);
	if (outcome.ok) consecutiveFailures = 0;
	else recordRecycleFailure();
	return outcome;
}
/**
* 真正尝试一次回收（不含熔断判定）。
*
* @param absPath 绝对路径。
* @returns 结果。
*/
function attemptRecycle(absPath) {
	try {
		if (process.platform === "win32") return recycleOnWindows(absPath);
		if (process.platform === "darwin") return recycleOnMac(absPath);
		if (process.platform === "linux") return recycleOnLinux(absPath);
		return {
			ok: false,
			reason: `unsupported platform: ${process.platform}`,
			unsupported: true
		};
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error)
		};
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
function recycleOnWindows(absPath) {
	/**
	* 关键：`Namespace(0).ParseName(完整路径)` 对深层路径**不可靠** —— 实测它会返回
	* 一个 item，但 `InvokeVerb('delete')` 变成永久删除而不是进回收站。
	*
	* 更稳的做法是像资源管理器一样：先 `Namespace('父目录')`，再 `ParseName('文件名')`。
	* 这样拿到的是真实的 shell 项目，delete 动词才会走回收站。
	*/
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$shell = New-Object -ComObject Shell.Application",
		`$folder = $shell.Namespace('${absPath.replace(/'/g, "''").replace(/\\[^\\]+$/, "")}')`,
		"if ($null -eq $folder) { Write-Error 'NO_PARENT_FOLDER'; exit 1 }",
		`$item = $folder.ParseName('${absPath.replace(/^.*[\\/]/, "").replace(/'/g, "''")}')`,
		"if ($null -eq $item) { Write-Error 'NO_ITEM'; exit 1 }",
		"$item.InvokeVerb('delete')",
		"exit 0"
	].join("; ");
	try {
		execFileSync("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], {
			timeout: COMMAND_TIMEOUT_MS,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
	} catch (error) {
		return {
			ok: false,
			reason: `Shell.Application delete failed: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	waitForGone(absPath, 3e3);
	if (existsSync(absPath)) return {
		ok: false,
		reason: "Shell.Application returned but the path still exists (may need confirmation)"
	};
	return { ok: true };
}
/**
* macOS：用 Finder 的 delete，等价于「移到废纸篓」。
*
* @param absPath 绝对路径。
* @returns 结果。
*/
function recycleOnMac(absPath) {
	const escaped = absPath.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
	try {
		execFileSync("osascript", ["-e", `tell application "Finder" to delete POSIX file "${escaped}"`], {
			timeout: COMMAND_TIMEOUT_MS,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
	} catch (error) {
		return {
			ok: false,
			reason: `Finder delete failed: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	waitForGone(absPath, 3e3);
	return existsSync(absPath) ? {
		ok: false,
		reason: "Finder returned but the path still exists"
	} : { ok: true };
}
/**
* Linux：优先 `gio trash`（GNOME/现代发行版都有），退回 `trash-put`。
*
* @param absPath 绝对路径。
* @returns 结果。
*/
function recycleOnLinux(absPath) {
	const attempts = [["gio", ["trash", absPath]], ["trash-put", [absPath]]];
	let lastReason = "no trash command available (tried gio, trash-put)";
	for (const [command, args] of attempts) try {
		execFileSync(command, args, {
			timeout: COMMAND_TIMEOUT_MS,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		waitForGone(absPath, 3e3);
		if (!existsSync(absPath)) return { ok: true };
		lastReason = `${command} returned but the path still exists`;
	} catch (error) {
		lastReason = `${command} failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	return {
		ok: false,
		reason: lastReason
	};
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
function waitForGone(absPath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!existsSync(absPath)) return;
		const buffer = new SharedArrayBuffer(4);
		Atomics.wait(new Int32Array(buffer), 0, 0, 100);
	}
}
//#endregion
export { canRecycle, moveToSystemRecycleBin, recordRecycleFailure, recycleBreakerThreshold, recycleFailureCount, recycleIsTripped, resetRecycleBreaker };
