import { a as restoreFromSafeZone, i as moveToSafeZone, r as listSafeZone, s as describeTarget, t as destroyEntry } from "./store-B4qDFAaC.js";
import { safeZoneBytes, selectForPrune } from "./prune.js";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
//#region src/classify.ts
/**
* 把绝对路径分成三级：`free` / `confirm` / `protected`。
*
* 纯函数，不碰文件系统。分级决定两件事：要不要弹审批卡，以及是否允许走安全删除。
*
* 两条必须守住的正确性约束（都在测试里钉死）：
*   1. 判定前先规范化 —— `C:\Work\..\Users\alice\...` 必须被认成家目录下的路径，
*      否则保护规则可以被写法绕开。
*   2. 包含关系必须按分隔符边界判断 —— `C:\Users\alice2` 不在 `C:\Users\alice` 内。
*/
/** profile 目录下受保护的清单文件名。 */
const PROTECTED_PROFILE_FILES = [
	"package.json",
	"cordis.patch.yml",
	"cordis.yml",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml"
];
/** 受保护的 home 级文件名。 */
const PROTECTED_HOME_FILES = ["cordis.patch.yml", "settings.yaml"];
/**
* 路径规范化 + Windows 风格的大小写归一。
*
* @param p 任意路径。
* @returns 规范化后的绝对路径（Windows 上统一小写）。
*/
function normalize(p) {
	const resolved = path.resolve(p);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
/**
* `child` 是否在 `parent` 之内（含相等）。
*
* 按分隔符边界判断，避免 `C:\Users\alice2` 被误认为在 `C:\Users\alice` 下。
*/
function isUnder(child, parent) {
	const c = normalize(child);
	const p = normalize(parent);
	if (c === p) return true;
	return c.startsWith(p + path.sep);
}
/**
* 路径中是否含名为 `node_modules` 的目录段。
*/
function hasNodeModulesSegment(p) {
	return normalize(p).split(path.sep).includes("node_modules");
}
/**
* 判断一个路径的分级。
*
* @param absPath 待判定路径（会被规范化）。
* @param env 分类事实。
*/
function classifyPath(absPath, env) {
	const target = normalize(absPath);
	const home = normalize(env.home);
	const dshHome = normalize(env.dshHome ?? path.join(env.home, ".dsh"));
	if (isUnder(target, normalize(path.join(env.dshHome ?? path.join(env.home, ".dsh"), ".dsh-safe-delete")))) return "protected";
	if (isUnder(target, normalize(env.tmpdir ?? os.tmpdir()))) return "free";
	if (env.installDir !== void 0 && env.installDir !== "" && isUnder(target, env.installDir)) return "protected";
	if (hasNodeModulesSegment(target)) return "protected";
	if (isUnder(target, path.join(dshHome, "profiles"))) {
		const base = path.basename(target);
		const parent = path.basename(path.dirname(target));
		if (PROTECTED_PROFILE_FILES.includes(base)) return "protected";
		if (parent === "profiles") return "confirm";
	}
	if (isUnder(target, dshHome)) {
		const base = path.basename(target);
		if (PROTECTED_HOME_FILES.includes(base)) return "protected";
		return "confirm";
	}
	if (isUnder(target, home)) return "confirm";
	return "free";
}
/**
* 该分级是否需要在界面里获得用户授权。
*
* 用户已明确：只有危险路径弹卡，普通工作区文件直接进安全区不打扰。
*/
function requiresApproval(classification) {
	return classification === "confirm" || classification === "protected";
}
//#endregion
//#region src/tools.ts
/**
* 五个工具的定义：`safe_delete` 与四个安全区管理工具。
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
/** 人类可读的体积。 */
function humanBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	const units = [
		"KB",
		"MB",
		"GB",
		"TB"
	];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}
/** 驱动盘根判定（`C:\`、`C:/`、`/`）。 */
function isDriveRoot(p) {
	const resolved = path.resolve(p);
	return path.parse(resolved).root === resolved;
}
/**
* 把审批结果翻译成给模型看的、可区分的错误文本。
*
* 「人说不」和「没有审批通道」必须是两句不同的话 —— 模型据此决定是停手还是报告。
*/
function approvalFailureText(outcome, target) {
	switch (outcome) {
		case "rejected": return `the user rejected deleting "${target}". Do not retry; ask the user what they actually want.`;
		case "cancelled": return `the approval request for "${target}" was cancelled.`;
		case "unavailable": return `"${target}" needs approval, but no approval channel is available (the session approval policy is likely "never"). Ask the user to switch the permission preset to one that uses "ask".`;
		case "allowed-once": return "";
	}
}
/** 创建全部工具。 */
function createTools(deps) {
	const now = deps.now ?? (() => Date.now());
	/** 按策略清理安全区；返回被销毁的条目。 */
	const pruneNow = async () => {
		if (deps.autoPrune === false) return [];
		const entries = await listSafeZone(deps.stateDir);
		const selected = selectForPrune(entries, {
			now: now(),
			maxBytes: deps.maxBytes
		});
		for (const entry of selected) await destroyEntry(deps.stateDir, entry.id);
		return selected;
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
			async execute(args) {
				const raw = String(args.path ?? "");
				if (raw === "") return {
					ok: false,
					text: "",
					error: "path is required"
				};
				const target = path.resolve(raw);
				if (isDriveRoot(target)) return {
					ok: false,
					text: "",
					error: `refusing to trash a filesystem root "${target}"`
				};
				const stateResolved = path.resolve(deps.stateDir);
				if (target === stateResolved || target.startsWith(stateResolved + path.sep)) return {
					ok: false,
					text: "",
					error: `refusing to delete "${target}": it is the safe zone's own state directory`
				};
				if (!existsSync(target)) return {
					ok: false,
					text: "",
					error: `not found: ${target}`
				};
				const description = describeTarget(target);
				const summary = `${target}\n${description.isDirectory ? "directory" : "file"}: ${description.fileCount} entr${description.fileCount === 1 ? "y" : "ies"}, ${humanBytes(description.bytes)}` + (description.topEntries.length > 0 ? `\n  ${description.topEntries.slice(0, 10).join("\n  ")}${description.truncated ? `\n  … and ${description.fileCount - 10} more` : ""}` : "");
				if (args.preview === true) {
					const classification = classifyPath(target, deps.env);
					return {
						ok: true,
						text: `PREVIEW (nothing moved):\n${summary}\n\nclassification: ${classification}` + (requiresApproval(classification) ? " — will require your approval in the UI" : " — moves without asking") + `\nretention: ${deps.retentionDays} days\nRun safe_delete again without preview to move it into the safe zone.`
					};
				}
				if (requiresApproval(classifyPath(target, deps.env))) {
					const outcome = await deps.requestApproval(`Delete "${target}"? ${description.isDirectory ? `Directory, ${description.fileCount} entries, ` : "File, "}${humanBytes(description.bytes)}. It will be moved into the safe zone and can be restored for ${deps.retentionDays} days.`);
					if (outcome !== "allowed-once") return {
						ok: false,
						text: "",
						error: approvalFailureText(outcome, target)
					};
				}
				const reason = typeof args.reason === "string" ? args.reason : void 0;
				const entry = await moveToSafeZone(deps.stateDir, target, {
					retentionDays: deps.retentionDays,
					now: now(),
					...reason !== void 0 && reason !== "" ? { reason } : {}
				});
				const pruned = await pruneNow();
				return {
					ok: true,
					text: `moved to the safe zone: ${target}\nid: ${entry.id}\n${summary}\nrestore with: safe_zone_restore id=${entry.id}\nexpires: ${new Date(entry.expiresAt).toISOString()} (${deps.retentionDays} days)` + (pruned.length > 0 ? `\npruned ${pruned.length} expired/over-cap entr${pruned.length === 1 ? "y" : "ies"}` : "")
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
			async execute(args) {
				const id = String(args.id ?? "");
				if (id === "") return {
					ok: false,
					text: "",
					error: "id is required"
				};
				const { restoredTo } = await restoreFromSafeZone(deps.stateDir, id);
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
						`auto prune: ${deps.autoPrune === false ? "off (manual only)" : "on"}`,
						next !== void 0 ? `oldest entry expires: ${new Date(next.expiresAt).toISOString()}` : "safe zone is empty"
					].join("\n")
				};
			}
		}),
		makeTool({
			name: "safe_zone_check",
			description: "Read-only health check of the composition under $DSH_HOME: can each profile package.json be parsed, is each cordis.patch.yml readable, and are any row ids duplicated across layers (duplicates make the next boot fail). Writes nothing.",
			parameters: {},
			async execute() {
				return {
					ok: true,
					text: checkComposition(deps.env)
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
export { requiresApproval as i, createTools as n, classifyPath as r, checkComposition as t };
