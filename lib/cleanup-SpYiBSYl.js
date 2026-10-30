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
* ## 为什么要 owner token
*
* 第一版用 `pid` 判断所有权，结果**锁永远释放不掉**：锁由主进程创建
* （`pid = 主进程`），而释放发生在 worker 里（`pid = worker`），两个 pid
* 永不相等，`releaseLock` 的所有权检查必然失败。表现是"第一次清理之后，
* 后续每次清理都被 `another cleanup holds the lock` 挡住"。
*
* 现在锁里带一个随机 `token`：谁创建锁谁拿到 token，创建者把它传给 worker；
* 释放时比对 token，而不是比对 pid。
*
* ## pid 必须是 **worker 的**，不是主进程的（2026-10-30 复审 SD-02）
*
* 第一版把 `pid: process.pid` 写进锁 —— 那是**主进程**的 pid。清理实际由
* spawn 出来的子进程执行，于是 worker 崩溃时出现了最糟的组合：
*
* ```
* worker 崩溃          ← 锁没释放
* 主进程还活着          ← holderAlive 永远为真
* → 即使锁过期 10 小时，接管判据 age > stale && !alive 也永不成立
* ```
*
* 结果是"清理永久停摆，直到重启 DSH"。隔离复现证实：写一个
* `{pid: 活着的调度方, at: 11 分钟前}` 的锁，`eligibleForTakeover` 为 false。
*
* 现在分两个阶段写锁：
*
* 1. 主进程派发时写 `{ pid: 主进程, token, requestId }` —— 这一小段窗口里
*    还没有 worker，用主进程 pid 是对的（主进程若死，锁自可接管）；
* 2. **worker 启动后立刻把 `workerPid` 写进锁**，此后存活判定以它为准。
*
* 判据因此变成：`workerPid` 存在 → 看它是否活着；否则看 `pid`。
*
* @param stateDir 安全区目录。
* @param staleMs 多久算过期。
* @param token 本次要写入锁的 owner token。
* @returns 拿到锁返回 true。
*/
function tryAcquireLock(stateDir, staleMs, token) {
	const lockPath = join(stateDir, LOCK_FILE);
	try {
		writeFileSync(lockPath, JSON.stringify({
			pid: process.pid,
			at: Date.now(),
			token
		}), { flag: "wx" });
		return true;
	} catch {
		try {
			const holder = JSON.parse(readFileSync(lockPath, "utf8"));
			const age = Date.now() - (holder.at ?? 0);
			const livenessPid = typeof holder.workerPid === "number" ? holder.workerPid : holder.pid;
			const holderAlive = typeof livenessPid === "number" && isAlive(livenessPid);
			if (age > staleMs && !holderAlive) {
				const tombstone = `${lockPath}.stale-${process.pid}-${Date.now().toString(36)}`;
				try {
					renameSync(lockPath, tombstone);
				} catch {
					return false;
				}
				try {
					writeFileSync(lockPath, JSON.stringify({
						pid: process.pid,
						at: Date.now(),
						token
					}), { flag: "wx" });
					rmSync(tombstone, { force: true });
					return true;
				} catch {
					try {
						rmSync(tombstone, { force: true });
					} catch {}
					return false;
				}
			}
		} catch {}
		return false;
	}
}
/**
* 把 **worker 自己的 pid** 绑定到锁上。
*
* ## 为什么必须绑定（2026-10-30 复审 SD-02）
*
* 锁由主进程创建，于是最初写进去的是主进程 pid。清理实际在子进程里跑，
* 一旦子进程崩溃而主进程还活着，存活判定 `isAlive(holder.pid)` 永远为真 ——
* 锁永不过期、永不接管，清理永久停摆到重启。
*
* worker 启动后第一件事就是调用这个函数，把 `workerPid` 写进锁。
* 此后存活判定以它为准（见 `tryAcquireLock`）。
*
* ## 为什么按 token 校验
*
* 只有锁的持有者才该改它。若 token 不匹配（说明锁已被别人接管），
* 这里安静地什么都不做 —— 让那个接管者继续。
*
* @param stateDir 安全区目录。
* @param token 派发方交给本 worker 的 owner token。
* @returns 是否成功绑定。
*/
function bindWorkerPid(stateDir, token) {
	const lockPath = join(stateDir, LOCK_FILE);
	try {
		const holder = JSON.parse(readFileSync(lockPath, "utf8"));
		if (holder.token !== token) return false;
		writeFileSync(lockPath, JSON.stringify({
			pid: holder.pid ?? process.pid,
			workerPid: process.pid,
			at: holder.at ?? Date.now(),
			token
		}));
		return true;
	} catch {
		return false;
	}
}
/**
* 释放清理锁（**只释放自己持有的那把**）。
*
* 所有权按 `token` 判断而不是 `pid` —— 锁由主进程创建、由 worker 释放，
* 两者的 pid 本来就不同。详见 `tryAcquireLock` 的注释。
*
* @param stateDir 安全区目录。
* @param token 创建锁时用的 owner token。
* @returns 是否真的删掉了锁。
*/
function releaseLock(stateDir, token) {
	const lockPath = join(stateDir, LOCK_FILE);
	try {
		if (JSON.parse(readFileSync(lockPath, "utf8")).token !== token) return false;
	} catch {
		return false;
	}
	try {
		rmSync(lockPath, { force: true });
		return true;
	} catch {
		return false;
	}
}
/**
* 请求一次后台清理 —— **立即返回，不等结果**。
*
* @param opts 选项。
* @returns 是否真的派生了子进程；已有一个在跑、或未到间隔时返回 false。
*/
async function requestCleanup(opts) {
	const { stateDir, limit = 500, minIntervalMs = 0, mode } = opts;
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
	const ownerToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	if (!tryAcquireLock(stateDir, 6e5, ownerToken)) return {
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
		requestId,
		ownerToken,
		mode
	], {
		detached: true,
		stdio: "ignore",
		windowsHide: true
	});
	let spawnFailed;
	child.on("error", (error) => {
		spawnFailed = error.message;
		releaseLock(stateDir, ownerToken);
		writeCleanupJob(stateDir, {
			requestId,
			pid: null,
			requestedAt: Date.now(),
			startedAt: Date.now(),
			finishedAt: Date.now(),
			outcome: "failed",
			recycled: 0,
			skipped: 0,
			lastError: `failed to spawn cleanup worker: ${error.message}`
		});
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
		releaseLock(stateDir, ownerToken);
		return {
			started: false,
			reason: spawnFailed ?? "failed to spawn the cleanup worker (no pid)"
		};
	}
	return { started: true };
}
//#endregion
export { writeCleanupJob as a, requestCleanup as i, readCleanupJob as n, releaseLock as r, bindWorkerPid as t };
