import { appendAuditBatch } from "./audit.js";
import { a as listSafeZone, d as writeIndexFiltered, i as isValidEntryId, p as moveToSystemRecycleBin } from "./store-B80RUQgH.js";
import { selectForPrune } from "./prune.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
//#region src/batch-manifest.ts
/**
* 批次事务清单（manifest）—— 让"聚合到一半崩溃"可恢复。
*
* ## 崩溃窗口
*
* 清理一批条目的步骤是：
*
* ```
* 1. mkdir batches/<batchId>/items/
* 2. 逐条 rename items/<id> → batches/<batchId>/items/<id>
* 3. 对这整个批次目录调一次系统回收站
* 4. 从索引移除这些 id
* ```
*
* 若在步骤 2 中途进程被杀：
*
* - 已搬走的条目：内容在 `batches/` 里，索引却仍指向 `items/`；
* - 没有清单的话，下次启动**不知道** `batches/` 里装的是什么，
*   那些条目就成了"索引里有、items/ 里没有"的不一致状态。
*
* ## 做法
*
* 在**第一次 rename 之前**把整批的预期内容写成 manifest：
*
* ```
* batches/<batchId>/manifest.json
* {
*   batchId, createdAt, status,
*   entries: [{ id, originalPath, bytes }]
* }
* ```
*
* 恢复时读 manifest，按每个 id 在 `items/` 与 `batches/<id>/items/` 两处找：
*
*   - 在 `items/` → 没搬走，无需处理；
*   - 在 `batches/` → 搬回去（回到"完全没清理"的状态，最安全）；
*   - 两处都没有 → 内容真没了，从索引移除并记一笔。
*
* 恢复的策略刻意选**搬回去**而不是"继续回收"：崩溃说明环境可能有问题，
* 此时把用户内容原样还回去，比猜测"其实我想删掉它"更安全。
*
* @module dsh-safe-delete/batch-manifest
*/
/** 清单文件名。 */
const MANIFEST = "manifest.json";
/**
* 批次目录路径。
*
* @param stateDir 安全区目录。
* @param batchId 批次 id。
* @returns 批次根目录。
*/
function batchDirOf(stateDir, batchId) {
	return join(stateDir, "batches", batchId);
}
/**
* 写清单（原子）。
*
* 必须在**第一次 rename 之前**调用 —— 否则崩溃时不知道批次里预期有什么。
*
* @param stateDir 安全区目录。
* @param manifest 清单内容。
*/
function writeManifest(stateDir, manifest) {
	const dir = batchDirOf(stateDir, manifest.batchId);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, MANIFEST);
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}
/**
* 读清单。
*
* @param stateDir 安全区目录。
* @param batchId 批次 id。
* @returns 清单；不存在或损坏时 null。
*/
function readManifest(stateDir, batchId) {
	const file = join(batchDirOf(stateDir, batchId), MANIFEST);
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		if (typeof parsed.batchId !== "string" || parsed.batchId === "") return null;
		if (parsed.batchId !== batchId) return null;
		if (parsed.schemaVersion !== 1) return null;
		const statuses = /* @__PURE__ */ new Set([
			"staging",
			"staged",
			"recycling"
		]);
		if (typeof parsed.status !== "string" || !statuses.has(parsed.status)) return null;
		if (!Number.isFinite(parsed.createdAt)) return null;
		if (!Array.isArray(parsed.entries)) return null;
		const seen = /* @__PURE__ */ new Set();
		const entries = [];
		for (const raw of parsed.entries) {
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
			const e = raw;
			if (typeof e.id !== "string" || e.id === "") return null;
			if (!isValidEntryId(e.id)) return null;
			if (seen.has(e.id)) return null;
			seen.add(e.id);
			if (typeof e.originalPath !== "string") return null;
			if (!Number.isFinite(e.bytes) || e.bytes < 0) return null;
			entries.push({
				id: e.id,
				originalPath: e.originalPath,
				bytes: e.bytes
			});
		}
		return {
			schemaVersion: 1,
			batchId: parsed.batchId,
			createdAt: parsed.createdAt,
			status: parsed.status,
			entries
		};
	} catch {
		return null;
	}
}
/**
* 更新清单状态。
*
* @param stateDir 安全区目录。
* @param batchId 批次 id。
* @param status 新状态。
* @returns 更新后的清单；原本不存在时 null。
*/
function updateManifestStatus(stateDir, batchId, status) {
	const manifest = readManifest(stateDir, batchId);
	if (manifest === null) return null;
	const next = {
		...manifest,
		status
	};
	writeManifest(stateDir, next);
	return next;
}
/**
* 列出所有残留的批次 id。
*
* @param stateDir 安全区目录。
* @returns 批次 id 列表。
*/
function listBatchIds(stateDir) {
	const root = join(stateDir, "batches");
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}
/**
* 恢复一个残留批次：把搬走的内容**放回 items/**。
*
* ## 为什么不继续回收
*
* 崩溃说明当时的环境可能有问题（权限、磁盘、进程被杀）。此时"接着删"
* 是替用户决定继续一个失败的操作；"放回去"则回到 untouched 状态，
* 用户下次想清理时再重来。前者不可逆，后者可逆。
*
* ## 三种情况
*
* - 内容在 `items/<id>` → 没搬走，什么都不做；
* - 内容在 `batches/<id>/items/<id>` → 搬回 `items/<id>`；
* - 两处都无 → 内容真的没了，报告 missing（调用方据此清索引）。
*
* @param stateDir 安全区目录。
* @param batchId 批次 id。
* @returns 每条的结果。
*/
function recoverBatch(stateDir, batchId) {
	const manifest = readManifest(stateDir, batchId);
	const bDir = batchDirOf(stateDir, batchId);
	const staged = join(bDir, "items");
	const results = [];
	if (manifest === null) return {
		batchId,
		entries: [],
		batchRemoved: false
	};
	for (const entry of manifest.entries) {
		const inItems = join(stateDir, "items", entry.id);
		const inBatch = join(staged, entry.id);
		if (isDirectory(inItems)) {
			results.push({
				id: entry.id,
				outcome: "left-in-place"
			});
			continue;
		}
		if (existsSync(inBatch)) {
			try {
				mkdirSync(join(stateDir, "items"), { recursive: true });
				renameSync(inBatch, inItems);
				results.push({
					id: entry.id,
					outcome: "moved-back"
				});
			} catch {
				results.push({
					id: entry.id,
					outcome: "recovery-failed"
				});
			}
			continue;
		}
		results.push({
			id: entry.id,
			outcome: "missing"
		});
	}
	const leftovers = existsSync(staged) ? listDirSafe(staged) : [];
	let batchRemoved = false;
	if (leftovers.length === 0) try {
		rmSync(bDir, {
			recursive: true,
			force: true
		});
		batchRemoved = true;
	} catch {}
	return {
		batchId,
		entries: results,
		batchRemoved
	};
}
/**
* 安全地列目录。
*
* @param dir 目录。
* @returns 条目名；读不到时为空数组。
*/
function listDirSafe(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
/**
* 判断某个路径是否存在**且是目录**。
*
* `existsSync` 对同名文件也返回 true —— 而这里要判断的是"条目的内容目录
* 是否已经就位"。用文件冒充会让恢复流程误以为内容在原位，实际还躺在批次目录里。
*
* @param p 路径。
* @returns 是目录返回 true。
*/
function isDirectory(p) {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}
/**
* 恢复所有残留批次。
*
* @param stateDir 安全区目录。
* @returns 每个批次的结果。
*/
function recoverAllBatches(stateDir) {
	return listBatchIds(stateDir).map((id) => recoverBatch(stateDir, id));
}
//#endregion
//#region src/cleanup-run.ts
/**
* worker 侧的清理执行：先聚合、再批量回收。
*
* ## 两个优化叠在一起
*
* ### 1. 批量回收（实测 47 倍）
*
* 逐条调系统回收站：`28724 × 1049 ms ≈ 8.4 小时`。
*
* 回收站是**按目录树**工作的 —— 把一个装了 N 个条目的目录整体送进去，只需
* **一次** shell 调用。实测（Windows，同卷）：
*
* | 方式 | 50 条 | 外推 28,724 条 |
* |---|---|---|
* | 逐条 | 52 秒 | 8.4 小时 |
* | 聚合后一次 | **1.1 秒** | **约 17 秒** |
*
* 聚合本身是**同卷 rename**，实测 0.56 ms/个。
*
* ### 2. 分批 + 上限（保证可恢复）
*
* 不能一次性把几万条塞进一个目录：中途崩溃就没有中间状态。所以按批处理，
* 每批最多 `BATCH_SIZE` 条，每批结束更新一次索引。
*
* ## 失败保守
*
* 聚合阶段任何一条失败：**只回滚本批**，不动其他条目，也不动索引里的记录。
* 回收阶段失败：条目留在批次目录里，索引仍指向它们 —— 下次会重新尝试。
* 绝不因为"回收失败"就永久删除用户内容。
*
* @module dsh-safe-delete/cleanup-run
*/
/** 一批最多聚合成一个目录。 */
const BATCH_SIZE = 500;
/** 单批最多聚合多少字节（防止 1 GB 目录一次送回收站太慢）。 */
const BATCH_MAX_BYTES = 268435456;
/** 聚合暂存目录名。 */
const BATCH_DIR = "batches";
/**
* worker 启动时的恢复扫描。
*
* ## 为什么每轮都做
*
* 上一次 worker 可能在聚合中途被杀（用户关 DSH、机器重启、OOM）。
* 残留的 `batches/<id>/` 里躺着**已经搬出 items/ 的条目内容**，
* 而索引仍认为它们在 items/ —— 用户会看到条目却恢复不出来。
*
* 每轮先扫一遍：
*   - 内容在 batches/ 里 → **搬回 items/**（回到 untouched 状态）；
*   - 内容两处都没有 → 从索引移除（内容真的没了，留着只会一直报错）。
*
* 选"搬回去"而不是"接着回收"：崩溃说明环境当时有问题，此时把用户内容
* 原样还回去比替用户继续删除更安全。
*
* @param stateDir 安全区目录。
* @returns 恢复了多少个批次。
*/
async function recoverResidualBatches(stateDir) {
	if (listBatchIds(stateDir).length === 0) return 0;
	const results = recoverAllBatches(stateDir);
	const missing = [];
	for (const batch of results) for (const e of batch.entries) if (e.outcome === "missing") missing.push(e.id);
	if (missing.length > 0) {
		const gone = new Set(missing);
		await writeIndexFiltered(stateDir, (e) => !gone.has(e.id));
	}
	return results.length;
}
/**
* 在 worker 里执行一轮清理。
*
* @param stateDir 安全区目录。
* @param limit 本轮最多处理多少条。
* @param recycler 回收实现；省略时走真实系统回收站。**测试必须注入**，
*   否则会真的往回收站扔东西。
* @param now 当前时间；省略用 `Date.now()`。测试注入可控时钟。
* @param mode 选中哪些条目：`expired`（只清过期）或 `all`（清空安全区）。
*   见下方"为什么必须显式区分"。
* @returns 统计。
*/
async function pruneNowForWorker(stateDir, limit, recycler = moveToSystemRecycleBin, now = Date.now, mode = "expired") {
	await recoverResidualBatches(stateDir);
	const entries = await listSafeZone(stateDir);
	const expired = (mode === "all" ? [...entries].sort((a, b) => a.movedAt - b.movedAt) : selectForPrune(entries, { now: now() })).slice(0, Math.max(0, limit));
	if (expired.length === 0) return {
		recycled: 0,
		skipped: 0
	};
	let recycled = 0;
	let skipped = 0;
	let cursor = 0;
	while (cursor < expired.length) {
		const slice = expired.slice(cursor, cursor + BATCH_SIZE);
		const batch = [];
		let bytes = 0;
		for (const e of slice) {
			if (bytes + (e.bytes ?? 0) > BATCH_MAX_BYTES && batch.length > 0) break;
			batch.push(e);
			bytes += e.bytes ?? 0;
		}
		if (batch.length === 0) {
			cursor += 1;
			continue;
		}
		const outcome = await recycleBatch(stateDir, batch, recycler);
		recycled += outcome.recycled;
		skipped += outcome.skipped;
		if (outcome.removedIds.length > 0) appendAuditBatch(stateDir, outcome.removedIds.map((id) => {
			return {
				event: "prune",
				target: batch.find((b) => b.id === id)?.originalPath ?? id,
				tool: "cleanup-worker",
				detail: `id=${id} batch=${outcome.batchId}`
			};
		}));
		if (outcome.removedIds.length > 0) {
			const gone = new Set(outcome.removedIds);
			await writeIndexFiltered(stateDir, (e) => !gone.has(e.id));
		}
		cursor += batch.length;
	}
	return {
		recycled,
		skipped
	};
}
/**
* 把一批条目聚合成一个目录，整体送进系统回收站。
*
* ## 顺序
*
* 1. 建 `batches/<batchId>/`
* 2. 逐条**同卷 rename** 进去（失败则回滚已搬的部分）
* 3. 对整个批次目录调**一次**回收站
* 4. 成功则返回这批 id；失败则**把内容搬回原处**并记 skipped
*
* 第 4 步是保守性的关键：回收失败时用户的内容必须还在原位置，
* 不能留在批次目录里变成"看不见的孤儿"。
*
* @param stateDir 安全区目录。
* @param batch 本批条目。
* @returns 成功移除的 id 与跳过数。
*/
async function recycleBatch(stateDir, batch, recycler) {
	if (batch.length === 0) return {
		recycled: 0,
		skipped: 0,
		removedIds: [],
		batchId: ""
	};
	const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const batchRoot = join(stateDir, BATCH_DIR, batchId);
	const batchItems = join(batchRoot, "items");
	try {
		mkdirSync(batchItems, { recursive: true });
	} catch {
		return {
			recycled: 0,
			skipped: batch.length,
			removedIds: [],
			batchId: ""
		};
	}
	try {
		writeManifest(stateDir, {
			schemaVersion: 1,
			batchId,
			createdAt: Date.now(),
			status: "staging",
			entries: batch.map((e) => ({
				id: e.id,
				originalPath: e.originalPath ?? "",
				bytes: e.bytes ?? 0
			}))
		});
	} catch {
		cleanupBatchDir(batchRoot);
		return {
			recycled: 0,
			skipped: batch.length,
			removedIds: [],
			batchId: ""
		};
	}
	const moved = [];
	const failed = [];
	for (const entry of batch) {
		const from = join(stateDir, "items", entry.id);
		const to = join(batchItems, entry.id);
		try {
			if (!existsSync(from)) {
				moved.push({ id: entry.id });
				continue;
			}
			renameSync(from, to);
			moved.push({ id: entry.id });
		} catch {
			failed.push({ id: entry.id });
		}
	}
	if (moved.length === 0) {
		cleanupBatchDir(batchRoot);
		return {
			recycled: 0,
			skipped: failed.length,
			removedIds: [],
			batchId
		};
	}
	updateManifestStatus(stateDir, batchId, "staged");
	if (recycler(batchItems).ok) {
		if ((existsSync(batchItems) ? readdirSync(batchItems) : []).length === 0) {
			cleanupBatchDir(batchRoot);
			return {
				recycled: moved.length,
				skipped: failed.length,
				removedIds: moved.map((m) => m.id),
				batchId
			};
		}
	}
	const notRestored = [];
	for (const m of moved) {
		const from = join(batchItems, m.id);
		const to = join(stateDir, "items", m.id);
		try {
			if (!existsSync(from)) continue;
			if (existsSync(to)) {
				notRestored.push(m.id);
				continue;
			}
			renameSync(from, to);
		} catch {
			notRestored.push(m.id);
		}
	}
	if ((existsSync(batchItems) ? readdirSync(batchItems) : []).length === 0) cleanupBatchDir(batchRoot);
	else updateManifestStatus(stateDir, batchId, "staging");
	return {
		recycled: 0,
		skipped: batch.length,
		removedIds: [],
		batchId
	};
}
/**
* 删掉批次目录 —— **只在它确实是空的时候**。
*
* ## 为什么函数自己也要检查
*
* 调用方理论上已经确认过批次里没有内容，但这个函数原本用
* `rmSync(recursive)`，一旦某个调用点漏了那次检查，就会**静默删除用户数据**。
* 2026-10-30 复审 P0-01 正是这样发生的。
*
* 函数自己再守一道：还有内容就拒绝，返回 false，把目录留着。这样即使将来
* 新增调用点忘了判断，最坏结果也只是"残留一个批次目录"，而不是"数据没了"。
*
* @param batchRoot 批次根目录。
* @returns 是否真的删掉了。
*/
function cleanupBatchDir(batchRoot) {
	const items = join(batchRoot, "items");
	if (existsSync(items)) try {
		if (readdirSync(items).length > 0) return false;
	} catch {
		return false;
	}
	try {
		rmSync(batchRoot, {
			recursive: true,
			force: true
		});
		return true;
	} catch {
		return false;
	}
}
//#endregion
export { recoverResidualBatches as n, pruneNowForWorker as t };
