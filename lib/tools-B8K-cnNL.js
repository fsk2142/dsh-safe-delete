import { appendAudit, appendAuditBatch, readAudit } from "./audit.js";
import { a as describeMoved, l as humanBytes, n as decideGate, o as describePreview, r as deletePath } from "./delete-core-Cr99B0J3.js";
import { c as describeTarget, i as moveManyToSafeZone, o as restoreFromSafeZone, r as listSafeZone, s as canRecycle, t as destroyEntry } from "./store-D8bO16X_.js";
import { safeZoneBytes, selectForPrune } from "./prune.js";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
//#region src/match.ts
/**
* 在目录树里按模式 / 时间 / 排除条件挑出待删项。
*
* ## 为什么单独成模块
*
* `safe_delete` 原本只接受字面路径。清生成物时用户真正要说的是「把 `.tmp` 里
* 7 天前的 `*.log` 删掉，但保留 `latest/`」—— 让模型枚举出几百条路径再传，
* 既慢（见 `moveManyToSafeZone` 的注释）又容易漏。
*
* 这个模块只做**挑选**，不碰删除。挑选结果是路径数组，之后仍走 `deletePath`
* 的完整判定 —— 保护区、安全区自检、阈值确认全都照常。
*
* ## 三条安全约束
*
* 1. **`root` 本身不进结果** —— 只挑它内部的项。误写 `root: C:\Work` 时，
*    后果是「挑出很多文件」而不是「整个 C:\Work 没了」。
* 2. **不跟随符号链接** —— 避免环，也避免删到链接指向的外部文件。
* 3. **枚举上限** —— 超过 `MAX_ENUMERATE` 就停，并在结果里标记 `truncated`，
*    防止在 `node_modules` 这种树里卡死。
*
* @module dsh-safe-delete/match
*/
/** 一次最多枚举多少个条目。与 `describe` 的上限一致。 */
const MAX_ENUMERATE = 2e5;
/**
* 把 glob 片段转成正则。
*
* 只支持必要的几个语法：`**`、`*`、`?`、`{a,b}`。刻意不支持 `[...]` 字符类 ——
* Windows 路径里 `[` `]` 是合法文件名字符，支持它反而会误伤。
*
* @param glob glob 模式。
* @returns 正则（未加锚点）。
*/
function globToRegExp(glob) {
	let out = "";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				const after = glob[i + 2];
				if (after === "/" || after === "\\") {
					out += "(?:.*[\\\\/])?";
					i += 3;
					continue;
				}
				out += ".*";
				i += 2;
				continue;
			}
			out += "[^\\\\/]*";
			i += 1;
			continue;
		}
		if (c === "?") {
			out += "[^\\\\/]";
			i += 1;
			continue;
		}
		if (c === "{") {
			const end = glob.indexOf("}", i);
			if (end > i) {
				const choices = glob.slice(i + 1, end).split(",");
				out += `(?:${choices.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
				i = end + 1;
				continue;
			}
		}
		out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		i += 1;
	}
	return new RegExp(`^${out}$`);
}
/**
* 在目录树里挑出符合条件的条目。
*
* @param opts 挑选条件。
* @returns 命中路径与统计。
*/
function matchInTree(opts) {
	const root = path.resolve(opts.root);
	const now = opts.now ?? Date.now();
	const cutoff = opts.olderThanMs === void 0 ? void 0 : now - opts.olderThanMs;
	const includeRe = opts.pattern === void 0 || opts.pattern === "" ? null : globToRegExp(opts.pattern);
	const excludeRes = (opts.exclude ?? []).map((p) => globToRegExp(p));
	const hits = [];
	let scanned = 0;
	let truncated = false;
	/**
	* 相对 root 的路径，统一用 `/` 分隔，便于与 glob 模式比较。
	*
	* @param abs 绝对路径。
	* @returns 相对路径。
	*/
	const relOf = (abs) => path.relative(root, abs).split(path.sep).join("/");
	/**
	* 递归遍历。
	*
	* @param dir 当前目录。
	* @returns 无需返回值；结果累加到闭包变量。
	*/
	const walk = (dir) => {
		if (truncated) return;
		let names;
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			scanned += 1;
			if (scanned > MAX_ENUMERATE) {
				truncated = true;
				return;
			}
			const full = path.join(dir, name);
			let st;
			try {
				st = lstatSync(full);
			} catch {
				continue;
			}
			const rel = relOf(full);
			if (excludeRes.some((re) => re.test(rel))) continue;
			if (st.isDirectory()) {
				walk(full);
				continue;
			}
			if (st.isSymbolicLink()) continue;
			if (includeRe !== null && !includeRe.test(rel)) continue;
			if (cutoff !== void 0 && st.mtimeMs >= cutoff) continue;
			hits.push(full);
		}
	};
	walk(root);
	return {
		paths: hits,
		truncated,
		scanned
	};
}
/**
* 把时长写法解析成毫秒。
*
* 支持 `30m` / `6h` / `7d`（也接受裸数字，按天解释 —— 与配置里的 `retentionDays`
* 一致，避免"写了 7 结果被当成 7 毫秒"）。
*
* @param text 时长文本。
* @returns 毫秒；无法解析时 undefined。
*/
function parseDuration(text) {
	const m = /^(\d+(?:\.\d+)?)\s*([mhd]?)$/i.exec(text.trim());
	if (m === null) return void 0;
	const amount = Number(m[1]);
	if (!Number.isFinite(amount) || amount < 0) return void 0;
	const unit = (m[2] ?? "").toLowerCase();
	return Math.round(amount * (unit === "m" ? 6e4 : unit === "h" ? 36e5 : 864e5));
}
//#endregion
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
* 三种输入形态，**互斥**：
*
* | 形态 | 参数 | 用途 |
* |---|---|---|
* | 单个 | `path` | 一个字面路径（可以是目录） |
* | 多个 | `paths` | 若干字面路径 |
* | 模式 | `root` (+ `match` / `olderThan` / `exclude`) | 在目录树里挑 |
*
* 为什么不做「两者都给就合并」：那会让调用方以为可以随便混用，实际行为取决于
* 顺序，是模糊语义。明确互斥，出错时给出清楚的提示，比"聪明地合并"更可靠。
*
* ## 模式形态**不做枚举**
*
* 这个函数被 `pre-execute` 钩子在**每次工具调用前**调用。如果在这里扫盘，
* 一次 `root: <node_modules>, match: **\/*.json` 要 529 ms —— 而钩子对所有
* 工具调用都跑，等于让整个 DSH 变慢。
*
* 所以模式形态只返回 `root` 本身，让钩子做**保守的路径分类判定**（纯字符串
* 运算，0 ms）。真正的枚举发生在工具执行体里（`resolveMatchedTargets`），
* 那时已经确定用户就是要执行这次删除。
*
* @param args 工具原始参数。
* @returns 路径列表，或一条错误信息。
*/
function normaliseDeleteTargets(args) {
	const single = typeof args.path === "string" && args.path.trim() !== "" ? args.path.trim() : void 0;
	const list = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim()) : void 0;
	const root = typeof args.root === "string" && args.root.trim() !== "" ? args.root.trim() : void 0;
	const pattern = typeof args.match === "string" && args.match.trim() !== "" ? args.match.trim() : void 0;
	const olderThanRaw = typeof args.olderThan === "string" && args.olderThan.trim() !== "" ? args.olderThan.trim() : void 0;
	const excludeRaw = Array.isArray(args.exclude) ? args.exclude.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim()) : [];
	const usesPatternForm = root !== void 0 || pattern !== void 0 || olderThanRaw !== void 0 || excludeRaw.length > 0;
	if (single !== void 0 && list !== void 0 && list.length > 0) return { error: "pass either `path` (one item) or `paths` (several), not both" };
	if ((single !== void 0 || list !== void 0 && list.length > 0) && usesPatternForm) return { error: "`root`/`match`/`olderThan`/`exclude` cannot be combined with `path` or `paths`" };
	if (usesPatternForm) {
		if (root === void 0) return { error: "`match`/`olderThan`/`exclude` need `root` (the directory to search in)" };
		if (olderThanRaw !== void 0 && parseDuration(olderThanRaw) === void 0) return { error: `cannot parse \`olderThan\` "${olderThanRaw}"; use forms like 30m, 6h, 7d` };
		return { paths: [root] };
	}
	if (single !== void 0) return { paths: [single] };
	if (list !== void 0 && list.length > 0) return { paths: [...new Set(list)] };
	return { error: "pass `path` (one item), `paths` (an array), or `root` with `match`" };
}
/**
* 把模式形态展开成真正要删的路径列表。
*
* **只在工具执行体里调用** —— 会真的扫盘（`node_modules` 量级约 500 ms）。
*
* @param args 工具原始参数。
* @returns 命中路径；空数组表示没有匹配。
*/
function resolveMatchedTargets(args) {
	const root = typeof args.root === "string" ? args.root.trim() : "";
	const pattern = typeof args.match === "string" && args.match.trim() !== "" ? args.match.trim() : void 0;
	const olderThanRaw = typeof args.olderThan === "string" && args.olderThan.trim() !== "" ? args.olderThan.trim() : void 0;
	const exclude = Array.isArray(args.exclude) ? args.exclude.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim()) : [];
	const olderThanMs = olderThanRaw === void 0 ? void 0 : parseDuration(olderThanRaw);
	const r = matchInTree({
		root,
		...pattern === void 0 ? {} : { pattern },
		...olderThanMs === void 0 ? {} : { olderThanMs },
		...exclude.length === 0 ? {} : { exclude }
	});
	return {
		paths: r.paths,
		scanned: r.scanned,
		truncated: r.truncated
	};
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
	const batch = await moveManyToSafeZone(ctx.stateDir, plans.map((p) => p.target), {
		retentionDays: ctx.retentionDays,
		now: ctx.now(),
		...ctx.crossVolumeCopy === true ? { crossVolumeCopy: true } : {},
		...base.reason !== void 0 && base.reason !== "" ? { reason: base.reason } : {}
	});
	const auditRecords = [];
	for (const item of batch) if (item.entry !== void 0) {
		moved.push(`${item.path}  →  id ${item.entry.id}`);
		auditRecords.push({
			event: "delete",
			target: item.path,
			tool: "safe_delete",
			detail: `id=${item.entry.id} batch`
		});
	} else failed.push({
		target: item.path,
		error: item.error ?? "unknown error"
	});
	appendAuditBatch(ctx.stateDir, auditRecords);
	if (ctx.afterMove !== void 0) await ctx.afterMove();
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
			description: "Move files/directories into the safe zone (restorable via safe_zone_restore). This is the ONLY sanctioned way to delete in DSH; raw shell deletes are blocked. Pass `paths` to delete several in one call — one approval covers the batch. To clear generated output, prefer `root` + `match` (e.g. root a `.tmp` dir, match `**/*.log`) over enumerating files yourself: one call, one approval, and it stays O(n). Dangerous paths (home dir, plugin sources, profile manifests, node_modules) need user approval; ordinary workspace files move silently. Use `preview: true` to see what would move without moving it.",
			parameters: {
				path: {
					type: "string",
					description: "One absolute path (file or directory). Mutually exclusive with `paths` and `root`."
				},
				paths: {
					type: "array",
					items: { type: "string" },
					description: "Several absolute paths in one call. Mutually exclusive with `path` and `root`."
				},
				root: {
					type: "string",
					description: "Directory to search in. Required by match/olderThan/exclude. The root itself is never deleted, only matched items inside it."
				},
				match: {
					type: "string",
					description: "Glob relative to `root`: `**` any depth, `*` one level, `?` one char, `{a,b}` alternatives. Omit to match every file."
				},
				olderThan: {
					type: "string",
					description: "Only items modified longer ago than this: 30m, 6h, 7d. A bare number means days."
				},
				exclude: {
					type: "array",
					items: { type: "string" },
					description: "Glob patterns relative to `root` to skip, e.g. `keep/**`. Exclude wins over match."
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
				const usesPatternForm = typeof args.root === "string" && args.root.trim() !== "";
				let resolvedPaths = targets.paths;
				if (usesPatternForm) {
					const matched = resolveMatchedTargets(args);
					if (matched.paths.length === 0) {
						const bits = [];
						if (typeof args.match === "string") bits.push(`pattern "${args.match}"`);
						if (typeof args.olderThan === "string") bits.push(`older than ${args.olderThan}`);
						const excl = Array.isArray(args.exclude) && args.exclude.length > 0 ? ` (excluded ${args.exclude.length})` : "";
						return {
							ok: false,
							text: "",
							error: `no files matched in ${args.root}` + (bits.length > 0 ? ` for ${bits.join(" and ")}` : "") + excl + `; scanned ${matched.scanned} entries`
						};
					}
					if (matched.truncated) return {
						ok: false,
						text: "",
						error: `matched too many entries (stopped after ${matched.scanned}); narrow the pattern or use a deeper root to keep the batch reviewable`
					};
					resolvedPaths = matched.paths;
				}
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
				if (resolvedPaths.length === 1) {
					const result = await deletePath({
						...base,
						path: resolvedPaths[0]
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
				return deleteMany(resolvedPaths, base, deleteCtx);
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
export { resolveMatchedTargets as i, createTools as n, normaliseDeleteTargets as r, checkComposition as t };
