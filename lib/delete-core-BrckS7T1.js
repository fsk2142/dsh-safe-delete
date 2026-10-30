import { appendAudit } from "./audit.js";
import { f as describeTarget, s as moveToSafeZone } from "./store-JTOnajRR.js";
import { existsSync, statfsSync } from "node:fs";
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
	if (env.installDir !== void 0 && env.installDir !== "" && isUnder(target, env.installDir)) return "protected";
	if (hasNodeModulesSegment(target)) return "protected";
	if (isUnder(target, normalize(env.tmpdir ?? os.tmpdir()))) return "free";
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
* 估算这次删除的**跨卷**后果。
*
* 只关心一件事：跨盘复制会不会把安全区所在盘写满。容量上限已移除，
* 所以这里不再有"会不会撑爆安全区"的判定。
*
* 任何一项取不到（磁盘信息不可用）都**不阻断删除** —— 预估只是用来提示，
* 不是权限判定。宁可少提示一句，也不该因为读不到磁盘信息就拒绝删除。
*
* @param description 目标描述（大小）。
* @param ctx 删除上下文。
* @param target 源路径（用于判断卷）。
* @returns 预估结果。
*/
async function forecastSpace(description, ctx, target) {
	const crossesVolumes = path.parse(path.resolve(target)).root.toLowerCase() !== path.parse(path.resolve(ctx.stateDir)).root.toLowerCase();
	const copyBytes = crossesVolumes ? description.bytes : 0;
	let freeBytes;
	if (crossesVolumes) try {
		const stat = statfsSync(path.resolve(ctx.stateDir));
		freeBytes = stat.bavail * stat.bsize;
	} catch {}
	const copyWillNotFit = copyBytes > 0 && freeBytes !== void 0 && copyBytes > freeBytes;
	return {
		crossesVolumes,
		copyBytes,
		...freeBytes === void 0 ? {} : { freeBytes },
		copyWillNotFit,
		/** 跨盘但用户没开 crossVolumeCopy：这次删除会被直接拒绝。 */
		blockedByPolicy: crossesVolumes && ctx.crossVolumeCopy !== true
	};
}
/**
* 把跨卷风险写成给人看的说明。没有风险时返回空数组。
*
* 容量相关的提示已随容量层一起移除 —— 安全区不再有上限，
* 因此不存在"会不会撑爆"这回事。这里只剩跨盘复制这一项。
*
* @param forecast 预估结果。
* @returns 风险条目，可能为空。
*/
function describeSpaceRisks(forecast) {
	const risks = [];
	if (forecast.copyWillNotFit) {
		const free = forecast.freeBytes === void 0 ? "less than needed" : humanBytes(forecast.freeBytes);
		risks.push(`this crosses volumes, so ${humanBytes(forecast.copyBytes)} will be copied onto the safe zone's disk (only ${free} free). Move the safe zone to the source volume, or free space first.`);
	} else if (forecast.copyBytes > 0) risks.push(`this crosses volumes, so ${humanBytes(forecast.copyBytes)} will be copied onto the safe zone's disk and stays there until the entry expires. Pruning to the recycle bin does not free it (same-volume rename).`);
	if (forecast.blockedByPolicy) risks.push("this crosses volumes and crossVolumeCopy is off, so the move will be refused. Either move the safe zone onto the source volume, or enable crossVolumeCopy to accept a real copy.");
	return risks;
}
/**
* 执行一次删除。
*
* 顺序即正确性：先证明目标存在且不是禁区，再描述，再（必要时）问人，最后才移动。
*
* ## 什么时候才问人
*
* 只在**真的有风险**时问，普通删除绝不打扰（频繁弹确认会训练用户无脑点允许，
* 反而更危险）。三个独立理由，任一命中问**一次**（不叠加问多次）：
*
*   1. 路径危险（家目录、profile 清单、node_modules…）
*   2. 这一单太大（条目数或字节数超阈值）
*   3. 空间后果异常：会把安全区撑过上限，或跨卷复制写不下
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
	const forecast = await forecastSpace(description, {
		stateDir: ctx.stateDir,
		...ctx.crossVolumeCopy === true ? { crossVolumeCopy: true } : {}
	}, target);
	const risks = describeSpaceRisks(forecast);
	if (forecast.copyWillNotFit) {
		const free = forecast.freeBytes === void 0 ? "less than needed" : humanBytes(forecast.freeBytes);
		return {
			ok: false,
			target,
			error: `not enough free space on the safe zone's volume: need ${humanBytes(forecast.copyBytes)}, only ${free} free. Move the safe zone onto the source volume, or free space first`
		};
	}
	if (gate.needsApproval || risks.length > 0) {
		const base = describeApprovalRequest(target, description, gate, ctx.retentionDays);
		const text = risks.length === 0 ? base : `${base}\n\nSpace warning:\n- ${risks.join("\n- ")}`;
		const outcome = await ctx.requestApproval(text);
		if (outcome !== "allowed-once") return {
			ok: false,
			target,
			error: approvalFailureText(outcome, target)
		};
	}
	const reason = boundReason(request.reason);
	const entry = await moveToSafeZone(ctx.stateDir, target, {
		retentionDays: ctx.retentionDays,
		now: ctx.now(),
		...ctx.crossVolumeCopy === true ? { crossVolumeCopy: true } : {},
		...reason === void 0 ? {} : { reason }
	});
	appendAudit(ctx.stateDir, {
		event: "delete",
		target,
		tool: "safe_delete",
		detail: `id=${entry.id} cls=${gate.classification}${reason === void 0 ? "" : ` reason=${reason}`}`
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
/** `reason` 的最大长度。 */
const MAX_REASON_CHARS = 200;
/**
* 把删除理由收进安全长度。
*
* ## 为什么要截
*
* `reason` 是模型或用户给的**自由文本**，会被写进索引与审计日志**各一份**。
* 没有上限时：
*
*   - 模型把一段文件内容贴进来当理由 → 索引膨胀，而索引每次删除/清理都要全量
*     读写（1000 条时 268 KB、5000 条时 1.3 MB），等于把整个插件的 I/O 成本推高；
*   - 那段文本可能含敏感信息（密钥、私信），于是长期留在磁盘上。
*
* 实测：传 10000 字符，索引与审计里各存了 10000 字符。
*
* ## 为什么保留开头
*
* 理由的前半段通常更有信息量（"清理构建产物…"），截尾比截头损失小。
*
* @param reason 原始理由（可能为空或超长）。
* @returns 长度不超过 `MAX_REASON_CHARS` 的理由；空输入返回 undefined。
*/
function boundReason(reason) {
	if (reason === void 0 || reason === "") return void 0;
	return reason.length <= MAX_REASON_CHARS ? reason : `${reason.slice(0, 199)}…`;
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
	const size = d.isDirectory ? `${d.fileCount} entries, ${humanBytes(d.bytes)}` : `file, ${humanBytes(d.bytes)}`;
	return `moved to safe zone: ${result.target}\n  id: ${result.entry.id}  ${size}${top}\n  restore: safe_zone_restore id=${result.entry.id} (${retentionDays}d)` + (result.pruned.length > 0 ? `\n  pruned ${result.pruned.length} expired/over-cap entr${result.pruned.length === 1 ? "y" : "ies"}` : "");
}
//#endregion
export { describeApprovalRequest as a, describeSpaceRisks as c, classifyPath as d, deletePath as i, forecastSpace as l, boundReason as n, describeMoved as o, decideGate as r, describePreview as s, approvalFailureText as t, humanBytes as u };
