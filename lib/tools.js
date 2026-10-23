import { appendAudit, readAudit } from "./audit.js";
import { a as describeMoved, l as humanBytes, n as decideGate, o as describePreview, r as deletePath } from "./delete-core-CA4K3LKD.js";
import { a as restoreFromSafeZone, i as moveToSafeZone, n as isEmptySafeZone, o as canRecycle, r as listSafeZone, s as describeTarget, t as destroyEntry } from "./store-Cp2MzCYr.js";
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
		if (meta.items !== void 0) prop.items = meta.items;
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
/**
* 把工具参数统一成「待删除路径列表」。
*
* 接受 `path`（单个）或 `paths`（数组），两者互斥。为什么不做「两者都给就合并」：
* 那会让调用方以为可以随便混用，实际行为取决于顺序，是模糊语义。明确二选一，
* 出错时给出清楚的提示，比"聪明地合并"更可靠。
*
* @param args 工具原始参数。
* @returns 路径列表，或一条错误信息。
*/
function normaliseDeleteTargets(args) {
	const single = typeof args.path === "string" && args.path.trim() !== "" ? args.path.trim() : void 0;
	const list = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim()) : void 0;
	if (single !== void 0 && list !== void 0 && list.length > 0) return { error: "pass either `path` (one item) or `paths` (several), not both" };
	if (single !== void 0) return { paths: [single] };
	if (list !== void 0 && list.length > 0) return { paths: [...new Set(list)] };
	return { error: "pass `path` (one item) or `paths` (an array of items)" };
}
/**
* 批量删除：**一次审批覆盖整批**，逐条执行，汇总结果。
*
* ## 为什么合并审批
*
* 每删除一个文件弹一次确认，删 20 个就要点 20 次 —— 用户会开始无脑点"允许"，
* 确认就失去了意义。合并成一次、并在文案里写清"共 N 项、合计 X 字节、其中哪些
* 需要你确认"，人才能真正判断。
*
* ## 逐条执行而不是打包
*
* 每条独立走 `deletePath`，所以：单条失败不影响其他条；每条都有自己的审计记录；
* 单条的保护区/安全区自检照常生效。批量的意义是省调用次数与确认次数，不是绕过检查。
*
* @param paths 待删除路径。
* @param base 公共请求参数（preview / reason）。
* @param ctx 删除上下文；审批调用会被替换成"合并版"。
* @returns 工具结果。
*/
async function deleteMany(paths, base, ctx) {
	const plans = [];
	const immediatelyRejected = [];
	for (const target of paths) {
		const resolved = path.resolve(target);
		if (!existsSync(resolved)) {
			immediatelyRejected.push({
				target: resolved,
				error: "not found"
			});
			continue;
		}
		const description = describeTarget(resolved);
		plans.push({
			target: resolved,
			description,
			gate: decideGate(resolved, description, ctx)
		});
	}
	if (base.preview === true) {
		const lines = [`PREVIEW (nothing moved): ${plans.length} item(s)`];
		let totalBytes = 0;
		for (const plan of plans) {
			totalBytes += plan.description.bytes;
			const size = plan.description.isDirectory ? `dir, ${plan.description.fileCount} entries, ${humanBytes(plan.description.bytes)}` : `file, ${humanBytes(plan.description.bytes)}`;
			const needs = plan.gate.needsApproval ? ` — needs your OK (${plan.gate.reasons.join("; ")})` : "";
			lines.push(`  ${plan.target}  [${size}]${needs}`);
		}
		if (immediatelyRejected.length > 0) {
			lines.push("", `Skipped (${immediatelyRejected.length}):`);
			for (const item of immediatelyRejected) lines.push(`  ${item.target} — ${item.error}`);
		}
		const needing = plans.filter((p) => p.gate.needsApproval).length;
		lines.push("", `total: ${humanBytes(totalBytes)}${needing > 0 ? `; ${needing} item(s) would need one confirmation` : ""}`);
		return {
			ok: true,
			text: lines.join("\n")
		};
	}
	const needing = plans.filter((p) => p.gate.needsApproval);
	if (needing.length > 0) {
		const totalBytes = needing.reduce((sum, p) => sum + p.description.bytes, 0);
		const totalFiles = needing.reduce((sum, p) => sum + p.description.fileCount, 0);
		const reasons = [...new Set(needing.flatMap((p) => p.gate.reasons))];
		const sample = needing.slice(0, 5).map((p) => p.target);
		const more = needing.length > sample.length ? `\n  …and ${needing.length - sample.length} more` : "";
		const text = `Delete ${needing.length} item(s) in one batch? Total ${totalFiles} entries, ${humanBytes(totalBytes)}.\nWhy this needs your OK: ${reasons.join("; ")}.\nItems:\n  ${sample.join("\n  ")}${more}\n\nApproving covers the whole batch. Everything goes into the safe zone and can be restored with safe_zone_restore for ${ctx.retentionDays} day(s).`;
		const outcome = await ctx.requestApproval(text);
		if (outcome !== "allowed-once") return {
			ok: false,
			text: "",
			error: `batch delete of ${needing.length} item(s) was not approved (${outcome}); nothing was moved. Ask the user how they want to proceed.`
		};
	}
	const moved = [];
	const failed = [...immediatelyRejected];
	const alreadyApprovedCtx = {
		...ctx,
		requestApproval: async () => "allowed-once"
	};
	for (const plan of plans) {
		const result = await deletePath({
			...base,
			path: plan.target
		}, alreadyApprovedCtx);
		if (result.ok && result.kind === "moved") moved.push(`${plan.target}  →  id ${result.entry.id}`);
		else if (!result.ok) failed.push({
			target: plan.target,
			error: result.error
		});
	}
	const lines = [`Deleted ${moved.length} of ${paths.length} item(s) into the safe zone (${humanBytes(plans.reduce((sum, p) => sum + p.description.bytes, 0))}).`];
	if (moved.length <= 5) lines.push(...moved.map((m) => `  ${m}`));
	else lines.push(...moved.slice(0, 3).map((m) => `  ${m}`), `  …and ${moved.length - 3} more`);
	if (failed.length > 0) {
		lines.push("", `Failed (${failed.length}) — these were NOT moved:`);
		lines.push(...failed.map((f) => `  ${f.target} — ${f.error}`));
	}
	lines.push("", `Restorable with safe_zone_restore for ${ctx.retentionDays} day(s).`);
	return {
		ok: failed.length === 0,
		text: lines.join("\n")
	};
}
/** 创建全部工具。 */
function createTools(deps) {
	const now = deps.now ?? (() => Date.now());
	/** 上次真正跑清理的时间；`null` 表示本进程还没跑过。 */
	let lastPruneAt = null;
	/** 按策略清理安全区；返回**真正移入回收站**的条目。 */
	const pruneNow = async () => {
		if (deps.autoPrune === false) return [];
		const entries = await listSafeZone(deps.stateDir);
		const selected = selectForPrune(entries, { now: now() });
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
		if (lastPruneAt !== null && at - lastPruneAt < 1e3) return;
		lastPruneAt = at;
		try {
			await pruneNow();
		} catch {}
	};
	return [
		makeTool({
			name: "safe_delete",
			description: "Move files/directories into the safe zone (restorable via safe_zone_restore). This is the ONLY sanctioned way to delete in DSH; raw shell deletes are blocked. Pass `paths` to delete several in one call — one approval covers the batch. Dangerous paths (home dir, plugin sources, profile manifests, node_modules) need user approval; ordinary workspace files move silently. Use `preview: true` to see what would move without moving it.",
			parameters: {
				path: {
					type: "string",
					description: "One absolute path. Mutually exclusive with `paths`."
				},
				paths: {
					type: "array",
					items: { type: "string" },
					description: "Several absolute paths in one call. Mutually exclusive with `path`."
				},
				preview: {
					type: "boolean",
					description: "Describe only; change nothing."
				},
				reason: {
					type: "string",
					description: "Why this is deleted (recorded in audit)."
				},
				force: {
					type: "boolean",
					description: "Ignored; a model-set flag is never user approval."
				}
			},
			beforeExecute: pruneIfDue,
			async execute(args) {
				const targets = normaliseDeleteTargets(args);
				if (targets.error !== void 0) return {
					ok: false,
					text: "",
					error: targets.error
				};
				const deleteCtx = {
					stateDir: deps.stateDir,
					env: deps.env,
					retentionDays: deps.retentionDays,
					confirmFileCount: deps.confirmFileCount ?? 0,
					confirmBytes: deps.confirmBytes ?? 0,
					...deps.crossVolumeCopy === true ? { crossVolumeCopy: true } : {},
					requestApproval: deps.requestApproval,
					now,
					afterMove: () => pruneNow()
				};
				const base = {
					preview: args.preview === true,
					...typeof args.reason === "string" ? { reason: args.reason } : {}
				};
				if (targets.paths.length === 1) {
					const result = await deletePath({
						...base,
						path: targets.paths[0]
					}, deleteCtx);
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
				return deleteMany(targets.paths, base, deleteCtx);
			}
		}),
		makeTool({
			name: "safe_zone_list",
			description: "List what is currently in the safe zone, newest last, with ids you can pass to safe_zone_restore.",
			parameters: { limit: {
				type: "integer",
				description: "Max entries to show (default 20)."
			} },
			beforeExecute: pruneIfDue,
			async execute(args) {
				const entries = await listSafeZone(deps.stateDir);
				if (entries.length === 0) return {
					ok: true,
					text: "safe zone is empty"
				};
				const limit = Math.max(1, Number(args.limit) || 20);
				const shown = entries.slice(-limit);
				const lines = shown.map((e) => `${e.id}  ${e.isDirectory ? "[dir] " : "[file]"}  ${humanBytes(e.bytes)}  ${new Date(e.expiresAt).toISOString().slice(5, 10)}  ${e.originalPath}`);
				return {
					ok: true,
					text: `${entries.length} entr${entries.length === 1 ? "y" : "ies"} in the safe zone (${humanBytes(safeZoneBytes(entries))}):\n` + lines.join("\n") + (entries.length > shown.length ? `\n… ${entries.length - shown.length} older entr(ies) not shown; pass limit to see more` : "")
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
						`dir: ${deps.stateDir}`,
						`entries: ${entries.length}  size: ${humanBytes(total)}`,
						`retention: ${deps.retentionDays}d (time-only, no capacity cap)`,
						`auto prune: ${deps.autoPrune === false ? "off (manual only)" : "on"}`,
						`prune runs: only when a safe_zone_* tool is called (no background timer)`,
						`prune to: ${canRecycle() ? "system recycle bin (restorable)" : `NOT SUPPORTED on ${process.platform} — entries stay put`}`,
						`confirm over: ${describeThresholds(deps)}`,
						next !== void 0 ? `oldest expires in ${Math.max(0, Math.round((next.expiresAt - now()) / 864e5))}d` : "safe zone is empty"
					].join("\n")
				};
			}
		}),
		makeTool({
			name: "safe_zone_check",
			description: "Read-only health check of the composition under $DSH_HOME: profile package.json parseable, cordis.patch.yml readable, row ids not duplicated across layers (duplicates break the next boot). Writes nothing.",
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
export { checkComposition, createTools, destroyEntry, isEmptySafeZone, listSafeZone, moveToSafeZone, normaliseDeleteTargets, restoreFromSafeZone };
