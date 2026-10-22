import { moveToSystemRecycleBin } from "./recycle.js";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
//#region src/describe.ts
/**
* 描述一个待删除目标：它是什么、多大、里面有什么。
*
* 这是「删之前让你看清」的依据，也是审批卡片上那行文字的来源。
*
* 实现约束：
*   - 不抛错：权限被拒、链接损坏都只跳过，不能让描述失败挡住一次删除判定。
*   - 不跟随符号链接：避免链接环导致无限递归。
*   - 顶层条目排序：输出稳定，测试才能断言。
*/
/** 顶层条目最多列多少个。 */
const MAX_TOP_ENTRIES = 20;
/** 递归遍历时最多访问多少个条目，防止超大目录拖死事件循环。 */
const MAX_WALK_ENTRIES = 2e5;
/**
* 递归累加目录的大小与文件数。
*/
function walk(dir, acc) {
	if (acc.fileCount > MAX_WALK_ENTRIES) return;
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const full = path.join(dir, name);
		let st;
		try {
			st = lstatSync(full);
		} catch {
			continue;
		}
		if (st.isSymbolicLink()) {
			acc.fileCount += 1;
			continue;
		}
		if (st.isDirectory()) {
			walk(full, acc);
			continue;
		}
		acc.bytes += st.size;
		acc.fileCount += 1;
	}
}
/**
* 描述一个路径。
*
* @param absPath 目标绝对路径。
*/
function describeTarget(absPath) {
	let st;
	try {
		st = statSync(absPath);
	} catch {
		return {
			exists: false,
			isDirectory: false,
			bytes: 0,
			fileCount: 0,
			topEntries: [],
			truncated: false
		};
	}
	if (!st.isDirectory()) return {
		exists: true,
		isDirectory: false,
		bytes: st.size,
		fileCount: 1,
		topEntries: [],
		truncated: false
	};
	const acc = {
		bytes: 0,
		fileCount: 0
	};
	walk(absPath, acc);
	let names = [];
	try {
		names = readdirSync(absPath).sort();
	} catch {
		names = [];
	}
	return {
		exists: true,
		isDirectory: true,
		bytes: acc.bytes,
		fileCount: acc.fileCount,
		topEntries: names.slice(0, MAX_TOP_ENTRIES),
		truncated: names.length > MAX_TOP_ENTRIES
	};
}
//#endregion
//#region src/store.ts
/**
* 安全区：被删除内容的暂存处，也是本插件唯一会移动用户数据的地方。
*
* 布局：
*   <stateDir>/items/<id>/   被移入的内容
*   <stateDir>/index.json    条目索引
*
* 两条硬约束：
*   1. **移入用 rename**（同卷 O(1)，不复制、不占额外空间）。跨卷时 `rename`
*      抛 `EXDEV`；在 `crossVolumeCopy` 为假（默认）时明确拒绝，绝不静默降级为
*      「复制后删源」那种看起来成功、实则多一份拷贝的行为。
*   2. **唯一允许递归删除的地方是 `destroyEntry`**，且只针对安全区内部路径。
*      除此之外本文件不删任何用户数据。
*/
const INDEX_FILE = "index.json";
const ITEMS_DIR = "items";
/** 索引路径。 */
function indexPath(stateDir) {
	return path.join(stateDir, INDEX_FILE);
}
/** 条目内容目录。 */
function entryDir(stateDir, id) {
	return path.join(stateDir, ITEMS_DIR, id);
}
/**
* 索引写操作的串行队列。
*
* ## 为什么需要
*
* `moveToSafeZone` / `destroyEntry` / `restoreFromSafeZone` 都是
* 「读索引 → 改 → 写回」。DSH 的并发工具调用可达 50，两个并发的删除会读到同一份
* 旧数组，后写者把它整个覆盖回去 —— 前一条从索引里消失，但内容还留在
* `items/<id>/` 盘上。后果是**列表看不见、清理永远轮不到**（prune 只扫索引），
* 属于静默的磁盘泄漏。
*
* ## 为什么用 Promise 链而不是文件锁
*
* 插件跑在单个宿主进程里，跨进程并发不存在。一条 Promise 链就够，而且
* 没有锁文件残留、崩溃自动释放的问题。
*/
let indexQueue = Promise.resolve();
/**
* 把一次索引操作排进队列，保证读-改-写不交错。
*
* @param job 要串行执行的操作。
* @returns 该操作的结果。
*/
function serialized(job) {
	const run = indexQueue.then(job, job);
	indexQueue = run.then(() => void 0, () => void 0);
	return run;
}
/** 读索引；不存在或损坏时返回空数组（安全区宁可"看起来空"也不能让删除流程崩掉）。 */
async function readIndex(stateDir) {
	const file = indexPath(stateDir);
	if (!existsSync(file)) return [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed;
	} catch {
		return [];
	}
}
/**
* 原子写索引：先写临时文件再 rename，避免中途崩溃留下半个 JSON。
*/
async function writeIndex(stateDir, entries) {
	mkdirSync(stateDir, { recursive: true });
	const file = indexPath(stateDir);
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}
/** 生成一个可读且不冲突的 id。 */
function makeId(now) {
	const d = new Date(now);
	const pad = (n, width = 2) => String(n).padStart(width, "0");
	return `${`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}
/** `child` 是否在 `parent` 之内（按分隔符边界）。 */
function isUnder(child, parent) {
	const c = path.resolve(child);
	const p = path.resolve(parent);
	if (c === p) return true;
	return c.startsWith(p + path.sep);
}
/**
* 把一个路径移入安全区。
*
* @param stateDir 安全区根目录。
* @param absPath 要移入的绝对路径。
* @param opts 保留期与跨卷策略。
* @returns 新条目。
*/
async function moveToSafeZone(stateDir, absPath, opts) {
	return serialized(async () => {
		const target = path.resolve(absPath);
		if (isUnder(stateDir, target) || isUnder(target, stateDir)) throw new Error(`refusing to move the safe zone itself (${target}) into the safe zone`);
		const now = opts.now ?? Date.now();
		const description = describeTarget(target);
		if (!description.exists) throw new Error(`not found: ${target}`);
		const id = makeId(now);
		const entryRoot = entryDir(stateDir, id);
		const dest = path.join(entryRoot, path.basename(target));
		mkdirSync(entryRoot, { recursive: true });
		let crossVolume = false;
		try {
			renameSync(target, dest);
		} catch (error) {
			if (error.code !== "EXDEV") throw error;
			if (opts.crossVolumeCopy !== true) throw new Error(`cannot move "${target}" into the safe zone: they are on different volumes. Move the safe zone to the same volume, or enable crossVolumeCopy to copy instead.`);
			crossVolume = true;
			cpSync(target, dest, {
				recursive: true,
				preserveTimestamps: true
			});
		}
		const entry = {
			id,
			originalPath: target,
			movedAt: now,
			expiresAt: now + opts.retentionDays * 24 * 60 * 60 * 1e3,
			bytes: description.bytes,
			fileCount: description.fileCount,
			isDirectory: description.isDirectory,
			crossVolume,
			...opts.reason !== void 0 && opts.reason !== "" ? { reason: opts.reason } : {}
		};
		const entries = await readIndex(stateDir);
		entries.push(entry);
		try {
			await writeIndex(stateDir, entries);
		} catch (error) {
			if (crossVolume) try {
				rmSync(dest, {
					recursive: true,
					force: true
				});
			} catch {}
			throw error;
		}
		if (crossVolume) rmSync(target, {
			recursive: true,
			force: true
		});
		return entry;
	});
}
/** 列出安全区条目（按移入时间升序）。 */
async function listSafeZone(stateDir) {
	return [...await readIndex(stateDir)].sort((a, b) => a.movedAt - b.movedAt);
}
/**
* 从安全区还原一条。
*
* 原路径已被占用时还原到同级 `.restored-<时间戳>` 兄弟 —— 绝不覆盖现在的文件。
*/
async function restoreFromSafeZone(stateDir, id) {
	return serialized(async () => {
		const entries = await readIndex(stateDir);
		const entry = entries.find((e) => e.id === id);
		if (entry === void 0) throw new Error(`unknown safe-zone id: ${id}`);
		const source = resolveStoredContent(stateDir, id);
		if (source === null) throw new Error(`safe-zone entry ${id} has no content on disk`);
		let destination = entry.originalPath;
		if (existsSync(destination)) {
			const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
			destination = `${entry.originalPath}.restored-${stamp}`;
		}
		mkdirSync(path.dirname(destination), { recursive: true });
		try {
			renameSync(source, destination);
		} catch (error) {
			if (error.code !== "EXDEV") throw error;
			cpSync(source, destination, {
				recursive: true,
				preserveTimestamps: true
			});
			rmSync(source, {
				recursive: true,
				force: true
			});
		}
		try {
			rmSync(entryDir(stateDir, id), {
				recursive: true,
				force: true
			});
		} catch {}
		await writeIndex(stateDir, entries.filter((e) => e.id !== id));
		return { restoredTo: destination };
	});
}
/**
* 找出某条目实际存放内容的位置。
*
* 兼容两种布局：`items/<id>/<basename>`（当前）与 `items/<id>` 本身（早期版本）。
*
* @returns 内容路径；条目为空或缺失时返回 `null`。
*/
function resolveStoredContent(stateDir, id) {
	const root = entryDir(stateDir, id);
	if (!existsSync(root)) return null;
	let names;
	try {
		names = readdirSync(root);
	} catch {
		return null;
	}
	if (names.length === 0) return null;
	if (names.length === 1) return path.join(root, names[0]);
	return root;
}
/**
* 销毁一条：**优先移入系统回收站**，只有明确要求时才永久抹掉。
*
* ## 为什么不是直接 rmSync
*
* 安全区和系统回收站是两道防线：
*
*   删除 → 安全区（保留期内 `safe_zone_restore` 可取回）
*        → 到期 → 系统回收站（用户清空之前都能还原）
*        → 用户手动清空回收站 → 才真正消失
*
* 如果这里直接 `rmSync`，就把「自动过期」升级成了最终删除 —— 而安全区的定时
* 清理是**无人值守**的，不该替用户做这个决定。
*
* ## 失败时不删除
*
* 移入回收站失败（权限、系统组件缺失、路径被占用）时，条目**留在安全区**并把
* 原因返回给调用方，由 `safe_zone_status` 报告。宁可占磁盘，也不能静默永久删除。
*
* @param stateDir 安全区根目录。
* @param id 条目 id。
* @param options `permanent: true` 时才真正 rmSync（用于「清空安全区」这类明示操作）；
*   `recycler` 可替换回收站实现（测试用替身，生产路径不传）。
* @returns 结果；失败时附带原因，条目未被删除。
*/
async function destroyEntry(stateDir, id, options = {}) {
	return serialized(async () => {
		const entries = await readIndex(stateDir);
		if (entries.find((e) => e.id === id) === void 0) throw new Error(`unknown safe-zone id: ${id}`);
		const dir = entryDir(stateDir, id);
		if (!isUnder(dir, path.join(stateDir, ITEMS_DIR))) throw new Error(`refusing to destroy a path outside the safe zone: ${dir}`);
		if (!existsSync(dir)) {
			await writeIndex(stateDir, entries.filter((e) => e.id !== id));
			return {
				ok: true,
				via: "permanent"
			};
		}
		let via = "permanent";
		if (options.permanent !== true) {
			const recycler = options.recycler ?? moveToSystemRecycleBin;
			let outcome;
			try {
				outcome = recycler(dir);
			} catch (error) {
				outcome = {
					ok: false,
					reason: error instanceof Error ? error.message : String(error)
				};
			}
			if (!outcome.ok) return {
				ok: false,
				reason: outcome.reason
			};
			via = "recycle";
		} else rmSync(dir, {
			recursive: true,
			force: true
		});
		await writeIndex(stateDir, entries.filter((e) => e.id !== id));
		return {
			ok: true,
			via
		};
	});
}
/** 安全区是否为空（含磁盘上无残留条目）。 */
async function isEmptySafeZone(stateDir) {
	if ((await readIndex(stateDir)).length > 0) return false;
	const items = path.join(stateDir, ITEMS_DIR);
	if (!existsSync(items)) return true;
	try {
		return readdirSync(items).length === 0;
	} catch {
		return true;
	}
}
//#endregion
export { restoreFromSafeZone as a, moveToSafeZone as i, isEmptySafeZone as n, describeTarget as o, listSafeZone as r, destroyEntry as t };
