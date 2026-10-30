import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
//#region src/cleanup.ts
/**
* 清理任务的调度：**搭车触发，不搭车执行**。
*
* ## 这个模块解决的事故
*
* 2026-10-30 的事故：`pruneIfDue` 挂在 6 个工具的 `beforeExecute` 上，节流只有
* 1 秒，而一次完整清理要为 28,724 条逐条调系统回收站（1049 ms/次），合计约
* 8.4 小时。于是每次工具调用都重新进入这条路径，同步阻塞事件循环，宿主连
* 会话历史都加载不出来。
*
* ## 现在的规则
*
* 1. **主进程只写一个请求文件**（几毫秒），然后立即返回；
* 2. 真正的清理交给独立的**操作系统子进程**（`spawn`，不是 `execFileSync`）；
* 3. 子进程独占一个锁文件，保证同时只有一个；
* 4. 子进程的进度写在 `cleanup-job.json` 里，`safe_zone_status` 可以读；
* 5. 子进程崩溃后，残留的锁会被下次调度按"过期"接管 —— 但接管前会核对
*    PID 是否还活着，避免误杀正在跑的清理。
*
* ## 为什么不用 `setImmediate` / `void prune()`
*
* 那些仍在**同一个事件循环**里执行同步 fs 和 `execFileSync`。看起来是"后台"，
* 实际照样卡住宿主。必须换进程。
*
* @module dsh-safe-delete/cleanup
*/
/** 请求文件名。 */
const JOB_FILE = "cleanup-job.json";
/** 锁文件名。 */
const LOCK_FILE = "cleanup.lock";
/** 子进程入口（相对本模块编译后的位置解析）。 */
const WORKER_ENTRY = "cleanup-worker.js";
/**
* 读当前清理任务状态。
*
* @param stateDir 安全区目录。
* @returns 状态；从未请求过时为 null。
*/
function readCleanupJob(stateDir) {
	const file = join(stateDir, JOB_FILE);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}
/**
* 原子写任务状态。
*
* @param stateDir 安全区目录。
* @param state 要写的状态。
*/
function writeCleanupJob(stateDir, state) {
	mkdirSync(stateDir, { recursive: true });
	const file = join(stateDir, JOB_FILE);
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}
/**
* 进程是否还活着。
*
* 用于判断锁的持有者是否真的在跑 —— 仅凭 `mtime` 过期就接管会误杀长任务。
*
* @param pid 进程 id。
* @returns 活着返回 true。
*/
function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
/**
* 尝试获取清理锁。
*
* ## 为什么锁里要写 pid
*
* 只按文件存在与否判断，会在子进程崩溃后永久卡住；只按 `mtime` 过期判断，
* 又会误杀一个正在慢慢跑的长任务。两者结合：过期 **且** pid 已死才接管。
*
* @param stateDir 安全区目录。
* @param staleMs 多久算过期。
* @returns 拿到锁返回 true。
*/
function tryAcquireLock(stateDir, staleMs) {
	const lockPath = join(stateDir, LOCK_FILE);
	try {
		writeFileSync(lockPath, JSON.stringify({
			pid: process.pid,
			at: Date.now()
		}), { flag: "wx" });
		return true;
	} catch {
		try {
			const holder = JSON.parse(readFileSync(lockPath, "utf8"));
			const age = Date.now() - (holder.at ?? 0);
			const holderAlive = typeof holder.pid === "number" && isAlive(holder.pid);
			if (age > staleMs && !holderAlive) {
				rmSync(lockPath, { force: true });
				writeFileSync(lockPath, JSON.stringify({
					pid: process.pid,
					at: Date.now()
				}), { flag: "wx" });
				return true;
			}
		} catch {}
		return false;
	}
}
/**
* 释放清理锁（**只释放自己的**）。
*
* @param stateDir 安全区目录。
*/
function releaseLock(stateDir) {
	const lockPath = join(stateDir, LOCK_FILE);
	try {
		if (JSON.parse(readFileSync(lockPath, "utf8")).pid !== process.pid) return;
	} catch {
		return;
	}
	rmSync(lockPath, { force: true });
}
/**
* 请求一次后台清理 —— **立即返回，不等结果**。
*
* @param opts 选项。
* @returns 是否真的派生了子进程；已有一个在跑、或未到间隔时返回 false。
*/
async function requestCleanup(opts) {
	const { stateDir, limit = 500, minIntervalMs = 0 } = opts;
	const prev = readCleanupJob(stateDir);
	if (prev !== null && minIntervalMs > 0) {
		const since = prev.finishedAt ?? prev.requestedAt;
		if (Date.now() - since < minIntervalMs) return {
			started: false,
			reason: "not due yet"
		};
	}
	if (prev !== null && prev.outcome === "running" && prev.pid !== null && isAlive(prev.pid)) return {
		started: false,
		reason: "already running"
	};
	if (!tryAcquireLock(stateDir, 6e5)) return {
		started: false,
		reason: "another cleanup holds the lock"
	};
	const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	writeCleanupJob(stateDir, {
		requestId,
		pid: null,
		requestedAt: Date.now(),
		startedAt: null,
		finishedAt: null,
		outcome: "pending",
		recycled: 0,
		skipped: 0
	});
	const workerPath = join(dirname(fileURLToPath(import.meta.url)), WORKER_ENTRY);
	const child = spawn(process.execPath, [
		workerPath,
		stateDir,
		String(limit),
		requestId
	], {
		detached: true,
		stdio: "ignore",
		windowsHide: true
	});
	child.unref();
	if (typeof child.pid === "number") writeCleanupJob(stateDir, {
		requestId,
		pid: child.pid,
		requestedAt: Date.now(),
		startedAt: Date.now(),
		finishedAt: null,
		outcome: "running",
		recycled: 0,
		skipped: 0
	});
	else {
		releaseLock(stateDir);
		return {
			started: false,
			reason: "failed to spawn the cleanup worker"
		};
	}
	return { started: true };
}
//#endregion
export { writeCleanupJob as i, releaseLock as n, requestCleanup as r, readCleanupJob as t };
