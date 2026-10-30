import { a as writeCleanupJob, n as readCleanupJob, r as releaseLock, t as bindWorkerPid } from "./cleanup-DFabZ3H5.js";
import { t as pruneNowForWorker } from "./cleanup-run-DwoEFmNt.js";
//#region src/cleanup-worker.ts
/**
* 清理 worker —— 在**独立进程**里执行过期条目回收。
*
* ## 为什么必须是独立进程
*
* 2026-10-30 事故：清理在宿主主进程里同步执行，把事件循环占住 8 小时，
* 会话历史加载不出来。改成 `setImmediate` 或 `void promise` 都没用 ——
* 那些仍在同一个事件循环里跑同步 fs 与 `execFileSync`。
*
* 只有换进程，主进程的事件循环才真正不被影响。即使这个 worker 卡住或崩溃，
* 宿主仍能响应、仍能查询异常批次。
*
* ## 用法（由 cleanup.ts 派生，不接受外部任意参数）
*
* ```
* node cleanup-worker.js <stateDir> <limit> <requestId> <ownerToken> <mode>
* ```
*
* | 参数 | 含义 |
* |---|---|
* | `stateDir` | 安全区目录。来自插件配置，不是任意 IPC 输入 —— 避免被用来删除别处的文件 |
* | `limit` | 本轮最多处理多少条 |
* | `requestId` | 任务 id，写进 `cleanup-job.json` 供查询 |
* | `ownerToken` | 锁的所有权凭据。**手工调试时忘了传，worker 就释放不掉锁** |
* | `mode` | `expired` 或 `all`；缺省 `expired` |
*
* 手工跑一次排查时至少要给全 5 个，否则锁会留在原地（等 10 分钟过期才可接管）。
*
* ## 状态写在哪
*
* 进度写在 `<stateDir>/cleanup-job.json`，主进程只读。锁 `<stateDir>/cleanup.lock`
* 由本进程在结束时释放；崩溃时残留的锁会被下次调度按「过期 + pid 已死」接管。
*
* @module dsh-safe-delete/cleanup-worker
*/
/**
* 主函数。
*
* @returns 退出码。
*/
async function main() {
	const [stateDir, limitArg, requestId, ownerToken, modeArg] = process.argv.slice(2);
	if (stateDir === void 0 || stateDir === "") {
		console.error("cleanup-worker: missing stateDir");
		return 2;
	}
	const limit = Number(limitArg ?? "500");
	const id = requestId ?? `${Date.now()}`;
	const mode = modeArg === "all" ? "all" : "expired";
	const token = ownerToken ?? "";
	if (token !== "") bindWorkerPid(stateDir, token);
	const prev = readCleanupJob(stateDir);
	const requestedAt = prev?.requestedAt ?? Date.now();
	try {
		const result = await pruneNowForWorker(stateDir, Number.isFinite(limit) ? limit : 500, void 0, void 0, mode);
		writeCleanupJob(stateDir, {
			requestId: id,
			pid: process.pid,
			requestedAt,
			startedAt: prev?.startedAt ?? Date.now(),
			finishedAt: Date.now(),
			outcome: "completed",
			recycled: result.recycled,
			skipped: result.skipped
		});
		return 0;
	} catch (error) {
		writeCleanupJob(stateDir, {
			requestId: id,
			pid: process.pid,
			requestedAt,
			startedAt: prev?.startedAt ?? Date.now(),
			finishedAt: Date.now(),
			outcome: "failed",
			recycled: 0,
			skipped: 0,
			lastError: error instanceof Error ? error.message : String(error)
		});
		return 1;
	} finally {
		releaseLock(stateDir, token);
	}
}
main().then((code) => {
	process.exit(code);
});
//#endregion
export {};
