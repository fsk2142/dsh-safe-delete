import { appendAudit, readAudit } from "./audit.js";
import { a as describeMoved, o as describePreview, r as deletePath, s as humanBytes } from "./delete-core-DBGNB_Ke.js";
import { a as restoreFromSafeZone, i as moveToSafeZone, n as isEmptySafeZone, o as canRecycle, r as listSafeZone, t as destroyEntry } from "./store-Cp2MzCYr.js";
import { safeZoneBytes, selectForPrune } from "./prune.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
//#region src/tools.ts
/**
* 工具定义：`safe_delete`、四个安全区管理工具，以及审计流水。
*
* 这里刻意**手写 JSON Schema 子集**而不 import `defineTool` —— 以 `link:` 裸装的
* bundle 没有自带 node_modules，import `@deepseek-ai/*` 会在 DSH 启动时解析失败。
*
* `safe_delete` 是整个插件里唯一会移动用户数据的入口。它的执行顺序就是它的
* 正确性：先证明目标存在且不是禁区，再描述，再（必要时）问人，最后才移动。
*/
/** 参数 spec → JSON Schema 子集。 */
function toJsonSchema(spec) {
	const properties = {};
	const required = [];
	for (const [key, meta] of Object.entries(spec)) {
		const prop = { type: meta.type };
		if (meta.description !== void 0) prop.description = meta.description;
		if (meta.enum !== void 0) prop.enum = meta.enum;
		properties[key] = prop;
		if (meta.required === true) required.push(key);
	}
	return {
		type: "object",
		properties,
		required,
		additionalProperties: false
	};
}
/** 输出 schema：所有工具统一返回 ok/text/error。 */
const OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		ok: { type: "boolean" },
		text: { type: "string" },
		error: { type: "string" }
	},
	required: ["ok", "text"],
	additionalProperties: false
};
/** 构造一个工具，统一异常转换（绝不把异常抛进工具管线）。 */
function makeTool(spec) {
	return {
		name: spec.name,
		description: spec.description,
		parameters: toJsonSchema(spec.parameters),
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: value.text !== "" ? value.text : value.error ?? "(empty)"
			}]
		},
		async execute(args) {
			if (spec.beforeExecute !== void 0) try {
				await spec.beforeExecute();
			} catch {}
			try {
				return await spec.execute(args);
			} catch (error) {
				return {
					ok: false,
					text: "",
					error: `[dsh-safe-delete] ${error instanceof Error ? error.message : String(error)}`
				};
			}
		}
	};
}
/** 人类可读的时长。 */
function describeInterval(ms) {
	if (ms <= 0) return "every call";
	const minutes = ms / 6e4;
	if (minutes < 60) return `${Math.round(minutes)} min`;
	const hours = minutes / 60;
	if (hours < 24) return `${hours % 1 === 0 ? hours : hours.toFixed(1)} h`;
	return `${(hours / 24).toFixed(1)} days`;
}
/** 描述单次删除的确认阈值。 */
function describeThresholds(deps) {
	const count = deps.confirmFileCount ?? 0;
	const bytes = deps.confirmBytes ?? 0;
	if (count <= 0 && bytes <= 0) return "disabled";
	const parts = [];
	if (count > 0) parts.push(`${count} entries`);
	if (bytes > 0) parts.push(humanBytes(bytes));
	return parts.join(" or ");
}
/** 描述清理的触发点。 */
function describePruneTrigger(deps) {
	const percent = deps.pruneAtPercent ?? 0;
	if (percent <= 0 || percent >= 100) return `when it exceeds ${humanBytes(deps.maxBytes)}`;
	const trigger = Math.floor(deps.maxBytes * percent / 100);
	return `at ${percent}% (${humanBytes(trigger)}) of the ${humanBytes(deps.maxBytes)} cap`;
}
/** 创建全部工具。 */
function createTools(deps) {
	const now = deps.now ?? (() => Date.now());
	const pruneIntervalMs = deps.autoPruneIntervalMs !== void 0 && deps.autoPruneIntervalMs > 0 ? deps.autoPruneIntervalMs : 36e5;
	/** 上次真正跑清理的时间；`null` 表示本进程还没跑过。 */
	let lastPruneAt = null;
	/** 按策略清理安全区；返回**真正移入回收站**的条目。 */
	const pruneNow = async () => {
		if (deps.autoPrune === false) return [];
		const entries = await listSafeZone(deps.stateDir);
		const selected = selectForPrune(entries, {
			now: now(),
			maxBytes: deps.maxBytes,
			...deps.pruneAtPercent !== void 0 ? { pruneAtPercent: deps.pruneAtPercent } : {}
		});
		const removed = [];
		for (const entry of selected) {
			const result = await destroyEntry(deps.stateDir, entry.id, { ...deps.recycler === void 0 ? {} : { recycler: deps.recycler } });
			if (!result.ok) {
				appendAudit(deps.stateDir, {
					event: "prune",
					target: entry.originalPath,
					detail: `id=${entry.id} skipped: ${result.reason}`
				});
				continue;
			}
			removed.push(entry);
			appendAudit(deps.stateDir, {
				event: "prune",
				target: entry.originalPath,
				detail: `id=${entry.id} bytes=${entry.bytes} via=${result.via}`
			});
		}
		return removed;
	};
	/**
	* 按间隔调用 `pruneNow`。
	*
	* 为什么不是定时器：一个挂在事件循环上的 `setInterval` 会让插件在 DSH 空闲时
	* 也保有生命周期，而清理并不需要那种准时性。改为"每次工具调用顺路看一眼"，
	* 代价是插件彻底不用管定时器的清理与异常。
	*/
	const pruneIfDue = async () => {
		if (deps.autoPrune === false) return;
		const at = now();
		if (lastPruneAt !== null && at - lastPruneAt < pruneIntervalMs) return;
		lastPruneAt = at;
		try {
			await pruneNow();
		} catch {}
	};
	return [
		makeTool({
			name: "safe_delete",
			description: "Delete a file or directory the safe way: it is moved into the safe zone (restorable via safe_zone_restore) instead of being erased. Dangerous paths (the OS home directory, plugin sources, profile manifests, node_modules) require the user to approve in the UI; ordinary workspace files move without asking. Run with preview:true first to see exactly what would be moved. This is the ONLY sanctioned way to delete in DSH — raw shell deletes are blocked.",
			parameters: {
				path: {
					type: "string",
					required: true,
					description: "Absolute path of the file or directory to delete."
				},
				preview: {
					type: "boolean",
					description: "Only describe what would be moved; change nothing."
				},
				reason: {
					type: "string",
					description: "Why this is being deleted (recorded in the safe zone and the audit trail)."
				},
				force: {
					type: "boolean",
					description: "Ignored. Kept for compatibility: a model-set flag is never a user approval."
				}
			},
			beforeExecute: pruneIfDue,
			async execute(args) {
				const result = await deletePath({
					path: String(args.path ?? ""),
					preview: args.preview === true,
					...typeof args.reason === "string" ? { reason: args.reason } : {}
				}, {
					stateDir: deps.stateDir,
					env: deps.env,
					retentionDays: deps.retentionDays,
					confirmFileCount: deps.confirmFileCount ?? 0,
					confirmBytes: deps.confirmBytes ?? 0,
					...deps.crossVolumeCopy === true ? { crossVolumeCopy: true } : {},
					requestApproval: deps.requestApproval,
					now,
					afterMove: () => pruneNow()
				});
				if (!result.ok) return {
					ok: false,
					text: "",
					error: result.error
				};
				return result.kind === "preview" ? {
					ok: true,
					text: describePreview(result, deps.retentionDays)
				} : {
					ok: true,
					text: describeMoved(result, deps.retentionDays)
				};
			}
		}),
		makeTool({
			name: "safe_zone_list",
			description: "List what is currently in the safe zone, newest last, with ids you can pass to safe_zone_restore.",
			parameters: { limit: {
				type: "integer",
				description: "Max entries to show (default 50)."
			} },
			beforeExecute: pruneIfDue,
			async execute(args) {
				const entries = await listSafeZone(deps.stateDir);
				if (entries.length === 0) return {
					ok: true,
					text: "safe zone is empty"
				};
				const limit = Math.max(1, Number(args.limit) || 50);
				const shown = entries.slice(-limit);
				const lines = shown.map((e) => `${e.id}  ${e.isDirectory ? "[dir] " : "[file]"}  ${humanBytes(e.bytes)}  expires ${new Date(e.expiresAt).toISOString().slice(0, 10)}  ${e.originalPath}`);
				return {
					ok: true,
					text: `${entries.length} entr${entries.length === 1 ? "y" : "ies"} in the safe zone:\n` + lines.join("\n") + (entries.length > shown.length ? `\n… ${entries.length - shown.length} older entr(ies) not shown` : "")
				};
			}
		}),
		makeTool({
			name: "safe_zone_restore",
			description: "Restore an item from the safe zone back to where it was deleted from. If that path is occupied, it restores next to it with a .restored-<timestamp> suffix instead of overwriting.",
			parameters: { id: {
				type: "string",
				required: true,
				description: "Safe-zone id (from safe_delete or safe_zone_list)."
			} },
			beforeExecute: pruneIfDue,
			async execute(args) {
				const id = String(args.id ?? "");
				if (id === "") return {
					ok: false,
					text: "",
					error: "id is required"
				};
				const { restoredTo } = await restoreFromSafeZone(deps.stateDir, id);
				appendAudit(deps.stateDir, {
					event: "restore",
					target: restoredTo,
					tool: "safe_zone_restore",
					detail: `id=${id}`
				});
				return {
					ok: true,
					text: `restored to: ${restoredTo}`
				};
			}
		}),
		makeTool({
			name: "safe_zone_status",
			description: "Show the safe zone state: entry count, total size, retention window, capacity cap, and when the next entries expire.",
			parameters: {},
			beforeExecute: pruneIfDue,
			async execute() {
				const entries = await listSafeZone(deps.stateDir);
				const total = safeZoneBytes(entries);
				const next = entries[0];
				return {
					ok: true,
					text: [
						`state dir: ${deps.stateDir}`,
						`entries: ${entries.length}`,
						`total size: ${humanBytes(total)}`,
						`capacity cap: ${humanBytes(deps.maxBytes)}`,
						`retention: ${deps.retentionDays} days`,
						`auto prune: ${deps.autoPrune === false ? "off (manual only)" : `on, checked every ${describeInterval(pruneIntervalMs)}`}`,
						`prune trigger: ${deps.autoPrune === false ? "n/a" : describePruneTrigger(deps)}`,
						`prune destination: ${canRecycle() ? "system recycle bin (recoverable until you empty it)" : `NOT SUPPORTED on ${process.platform} — expired entries stay in the safe zone`}`,
						`confirm when a single delete exceeds: ${describeThresholds(deps)}`,
						next !== void 0 ? `oldest entry expires: ${new Date(next.expiresAt).toISOString()}` : "safe zone is empty"
					].join("\n")
				};
			}
		}),
		makeTool({
			name: "safe_zone_check",
			description: "Read-only health check of the composition under $DSH_HOME: can each profile package.json be parsed, is each cordis.patch.yml readable, and are any row ids duplicated across layers (duplicates make the next boot fail). Writes nothing.",
			parameters: {},
			beforeExecute: pruneIfDue,
			async execute() {
				return {
					ok: true,
					text: checkComposition(deps.env)
				};
			}
		}),
		makeTool({
			name: "safe_zone_journal",
			description: "Tail the audit trail: every blocked shell delete, blocked write to a boot-critical file, approval ask, deletion, restore and prune, newest first. Use it to answer \"what happened\" rather than \"what is in the safe zone now\".",
			parameters: { n: {
				type: "integer",
				description: "Number of records to show (default 20, max 200)."
			} },
			beforeExecute: pruneIfDue,
			async execute(args) {
				const limit = Math.min(200, Math.max(1, Number(args.n) || 20));
				const records = readAudit(deps.stateDir, limit);
				if (records.length === 0) return {
					ok: true,
					text: "journal is empty"
				};
				return {
					ok: true,
					text: records.map((r) => {
						const parts = [r.at.slice(0, 19).replace("T", " "), r.event];
						if (r.tool !== void 0) parts.push(`tool=${r.tool}`);
						if (r.target !== void 0) parts.push(r.target);
						if (r.detail !== void 0) parts.push(`(${r.detail})`);
						return parts.join("  ");
					}).join("\n")
				};
			}
		})
	];
}
/**
* 只读体检：不写任何文件、不建快照。
*
* 检查项：profile 的 `package.json` 可解析、`cordis.patch.yml` 可读且非空、
* 行 id 不跨层重复。
*/
function checkComposition(env) {
	const dshHome = env.dshHome ?? path.join(env.home, ".dsh");
	const profilesRoot = path.join(dshHome, "profiles");
	const lines = [];
	let failed = false;
	const profileDirs = [];
	try {
		for (const name of readdirSync(profilesRoot)) {
			const dir = path.join(profilesRoot, name);
			if (existsSync(path.join(dir, "package.json"))) profileDirs.push(dir);
		}
	} catch {}
	const rowIdsByFile = /* @__PURE__ */ new Map();
	for (const dir of profileDirs) {
		const manifest = path.join(dir, "package.json");
		try {
			JSON.parse(readFileSync(manifest, "utf8"));
			lines.push(`[ok] ${manifest}`);
		} catch (error) {
			failed = true;
			lines.push(`[FAIL] ${manifest} — ${error instanceof Error ? error.message : String(error)}`);
		}
		const patch = path.join(dir, "cordis.patch.yml");
		if (existsSync(patch)) try {
			const text = readFileSync(patch, "utf8");
			if (text.trim() === "") {
				failed = true;
				lines.push(`[FAIL] ${patch} — empty patch file`);
			} else {
				lines.push(`[ok] ${patch}`);
				const ids = /* @__PURE__ */ new Map();
				let line = 0;
				for (const raw of text.split(/\r?\n/)) {
					line += 1;
					const match = /^\s*-\s+id:\s*(\S+)/.exec(raw);
					if (match !== null) ids.set(match[1], `${patch}:${line}`);
				}
				rowIdsByFile.set(patch, ids);
			}
		} catch (error) {
			failed = true;
			lines.push(`[FAIL] ${patch} — ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const seen = /* @__PURE__ */ new Map();
	for (const [, ids] of rowIdsByFile) for (const [id, where] of ids) {
		const previous = seen.get(id);
		if (previous !== void 0) {
			failed = true;
			lines.push(`[FAIL] duplicate row id "${id}": ${previous} and ${where}`);
		} else seen.set(id, where);
	}
	if (profileDirs.length === 0) lines.push("no profiles found to check");
	lines.unshift(`safe_zone_check: ${failed ? "FAIL" : "PASS"}`);
	lines.push(failed ? "Fix the FAIL items before restarting dsh." : "Composition looks safe to restart.");
	return lines.join("\n");
}
//#endregion
export { checkComposition, createTools, destroyEntry, isEmptySafeZone, listSafeZone, moveToSafeZone, restoreFromSafeZone };
