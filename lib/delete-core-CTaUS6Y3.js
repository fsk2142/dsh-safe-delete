import { appendAudit } from "./audit.js";
import { i as moveToSafeZone, o as describeTarget } from "./store-ryg4Cwhw.js";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
	if (isUnder(target, normalize(env.safeZoneDir ?? path.join(env.dshHome ?? path.join(env.home, ".dsh"), ".dsh-safe-delete")))) return "protected";
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
//#region src/delete-core.ts
/**
* 删除的核心流程。
*
* 抽出来的理由：同一个删除动作有三个入口 —— 模型工具 `safe_delete`、DSH 里的
* 斜杠命令、终端里的 `dsh-safe-delete delete`。如果各写一份，它们迟早会在
* 「谁需要审批」「阈值怎么算」「禁区怎么判」上分叉，而这类分叉的代价是一次
* 本该被拦的删除被放过去。
*
* 所以这里只放**一个**实现，三个入口都调它。入口之间的差别只有两处：
*   - 谁来做审批（工具走宿主审批线，命令与 CLI 走交互式确认）；
*   - 返回值怎么呈现（模型看文本，人看终端输出）。
*
* @module dsh-safe-delete/delete-core
*/
/** 驱动盘根判定。 */
function isDriveRoot(p) {
	const resolved = path.resolve(p);
	return path.parse(resolved).root === resolved;
}
/** 判断目标是否落在安全区自己的状态目录里。 */
function isInsideStateDir(target, stateDir) {
	const state = path.resolve(stateDir);
	return target === state || target.startsWith(state + path.sep);
}
/**
* 判定这一步要不要人确认，以及为什么。
*
* 两个**相互独立**的理由，任一命中就问一次（不叠加问两次，那只是骚扰）：
*   a) 路径危险（家目录、profile 清单、node_modules…）；
*   b) 这一单太大量（条目数或字节数超阈值）。
*/
function decideGate(target, description, ctx) {
	const classification = classifyPath(target, ctx.env);
	const reasons = [];
	if (requiresApproval(classification)) reasons.push(`it is a ${classification} path`);
	const countLimit = ctx.confirmFileCount;
	if (countLimit > 0 && description.fileCount > countLimit) reasons.push(`${description.fileCount} entries exceeds the limit of ${countLimit}`);
	const bytesLimit = ctx.confirmBytes;
	if (bytesLimit > 0 && description.bytes > bytesLimit) reasons.push(`${description.bytes} bytes exceeds the limit of ${bytesLimit}`);
	return {
		classification,
		needsApproval: reasons.length > 0,
		reasons
	};
}
/**
* 执行一次删除。
*
* 顺序即正确性：先证明目标存在且不是禁区，再描述，再（必要时）问人，最后才移动。
*/
async function deletePath(request, ctx) {
	const raw = request.path ?? "";
	if (raw.trim() === "") return {
		ok: false,
		error: "path is required"
	};
	const target = path.resolve(raw);
	if (isDriveRoot(target)) return {
		ok: false,
		error: `refusing to trash a filesystem root "${target}"`
	};
	if (isInsideStateDir(target, ctx.stateDir)) return {
		ok: false,
		error: `refusing to delete "${target}": it is the safe zone's own state directory`
	};
	if (!existsSync(target)) return {
		ok: false,
		target,
		error: `not found: ${target}`
	};
	const description = describeTarget(target);
	const gate = decideGate(target, description, ctx);
	if (request.preview === true) return {
		ok: true,
		kind: "preview",
		target,
		description,
		gate
	};
	if (gate.needsApproval) {
		const outcome = await ctx.requestApproval(describeApprovalRequest(target, description, gate, ctx.retentionDays));
		if (outcome !== "allowed-once") return {
			ok: false,
			target,
			error: approvalFailureText(outcome, target)
		};
	}
	const entry = await moveToSafeZone(ctx.stateDir, target, {
		retentionDays: ctx.retentionDays,
		now: ctx.now(),
		...ctx.crossVolumeCopy === true ? { crossVolumeCopy: true } : {},
		...request.reason !== void 0 && request.reason !== "" ? { reason: request.reason } : {}
	});
	appendAudit(ctx.stateDir, {
		event: "delete",
		target,
		tool: "safe_delete",
		detail: `id=${entry.id} cls=${gate.classification}${request.reason === void 0 || request.reason === "" ? "" : ` reason=${request.reason}`}`
	});
	return {
		ok: true,
		kind: "moved",
		target,
		entry,
		description,
		gate,
		pruned: ctx.afterMove === void 0 ? [] : await ctx.afterMove()
	};
}
/**
* 组装给人看的确认文案。
*
* 必须是**提问式**的：说清删什么、多大、为什么要你确认、以及之后能不能取回。
* 只说「拒绝」而不解释，用户只会换个姿势重试。
*/
function describeApprovalRequest(target, description, gate, retentionDays) {
	return `Delete "${target}"? ${description.isDirectory ? `Directory, ${description.fileCount} entries, ${description.bytes} bytes` : `File, ${description.bytes} bytes`}. Why this needs your OK: ${gate.reasons.join("; ")}. It will be moved into the safe zone and can be restored for ${retentionDays} days.`;
}
/** 把审批结果翻译成可区分的错误文本。 */
function approvalFailureText(outcome, target) {
	switch (outcome) {
		case "rejected": return `the user rejected deleting "${target}". Do not retry; ask the user what they actually want.`;
		case "cancelled": return `the approval request for "${target}" was cancelled.`;
		case "unavailable": return `"${target}" needs approval, but no approval channel is available (the session approval policy is likely "never"). Ask the user to switch the permission preset to one that uses "ask".`;
		case "allowed-once": return "";
	}
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
/** 把预览结论拼成人看的文本。 */
function describePreview(result, retentionDays) {
	const d = result.description;
	const top = d.topEntries.length > 0 ? `\n  ${d.topEntries.slice(0, 10).join("\n  ")}${d.truncated ? `\n  … and ${d.fileCount - 10} more` : ""}` : "";
	return `PREVIEW (nothing moved):\n${result.target}\n${d.isDirectory ? "directory" : "file"}: ${d.fileCount} entr${d.fileCount === 1 ? "y" : "ies"}, ${humanBytes(d.bytes)}${top}\n\nclassification: ${result.gate.classification}` + (result.gate.needsApproval ? ` — will need your approval (${result.gate.reasons.join("; ")})` : " — moves without asking") + `\nretention: ${retentionDays} days`;
}
/** 把移动结论拼成人看的文本。 */
function describeMoved(result, retentionDays) {
	const d = result.description;
	const top = d.topEntries.length > 0 ? `\n  ${d.topEntries.slice(0, 10).join("\n  ")}${d.truncated ? `\n  … and ${d.fileCount - 10} more` : ""}` : "";
	return `moved to the safe zone: ${result.target}\nid: ${result.entry.id}\n${d.isDirectory ? "directory" : "file"}: ${d.fileCount} entr${d.fileCount === 1 ? "y" : "ies"}, ${humanBytes(d.bytes)}${top}\nrestore with: safe_zone_restore id=${result.entry.id}\nexpires: ${new Date(result.entry.expiresAt).toISOString()} (${retentionDays} days)` + (result.pruned.length > 0 ? `\npruned ${result.pruned.length} expired/over-cap entr${result.pruned.length === 1 ? "y" : "ies"}` : "");
}
//#endregion
export { describeMoved as a, classifyPath as c, describeApprovalRequest as i, decideGate as n, describePreview as o, deletePath as r, humanBytes as s, approvalFailureText as t };
