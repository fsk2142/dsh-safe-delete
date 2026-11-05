import { appendAudit } from "./audit.js";
import { _ as describeTarget, b as requiresApproval, f as assessQuota, g as recycleManyToSystemBin, l as moveToSafeZone, v as classifyPath, y as normalize } from "./store-CwWWfFFR.js";
import { lstatSync, statfsSync } from "node:fs";
import path from "node:path";
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
/**
* 把配置里的原始值净化为合法去向。
*
* 旧配置、手改配置、拼错的字符串都会落到 `undefined` —— 一律按安全区处理，
* 因为那是「删除可反悔」的那一条路。
*
* @param raw 配置里的原始值。
* @returns 合法去向。
*/
function normalizeDestination(raw) {
	return raw === "recycle-bin" ? "recycle-bin" : "safe-zone";
}
/** 驱动盘根判定。 */
function isDriveRoot(p) {
	const resolved = path.resolve(p);
	return path.parse(resolved).root === resolved;
}
/**
* 判断目标是否落在安全区自己的状态目录里。
*
* ## 大小写必须归一化（2026-11-01 审查 SD-06）
*
* Windows 上 `C:\X\STATE` 与 `C:\X\state` 是同一个目录，而 `startsWith`
* 区分大小写。第一版直接比较，于是大写写法能把"目标是安全区自己"
* 判成 false —— 自保护被绕过。
*
* 复用 `classify.ts` 里已有的归一化（那里早就是这么做的），
* 避免两处规则漂移。
*
* @param target 待判定路径。
* @param stateDir 安全区目录。
* @returns 在安全区内返回 true。
*/
function isInsideStateDir(target, stateDir) {
	const state = normalize(stateDir);
	const t = normalize(target);
	return t === state || t.startsWith(state + path.sep);
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
	if (description.statsIncomplete) reasons.push("target statistics are incomplete; some entries could not be inspected");
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
	const refusal = hardRefusal(target, ctx.stateDir);
	if (refusal !== void 0) return {
		ok: false,
		error: refusal
	};
	if (lstatSync(target, { throwIfNoEntry: false }) === void 0) return {
		ok: false,
		target,
		error: `not found: ${target}`
	};
	const recycleMode = normalizeDestination(ctx.destination) === "recycle-bin";
	const description = describeTarget(target, recycleMode ? { stats: false } : {});
	const gate = decideGate(target, description, recycleMode ? {
		...ctx,
		confirmFileCount: 0,
		confirmBytes: 0
	} : ctx);
	if (request.preview === true) return {
		ok: true,
		kind: "preview",
		target,
		description,
		gate
	};
	const forecast = recycleMode ? void 0 : await forecastSpace(description, {
		stateDir: ctx.stateDir,
		...ctx.crossVolumeCopy === true ? { crossVolumeCopy: true } : {}
	}, target);
	const risks = forecast === void 0 ? [] : describeSpaceRisks(forecast);
	if (forecast?.copyWillNotFit === true) {
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
	if (normalizeDestination(ctx.destination) === "recycle-bin") {
		if ((ctx.permanentDeleteRisk?.status ?? (ctx.permanentDeleteRisk?.risky === true ? "risky" : "safe")) !== "safe") {
			const outcome = await ctx.requestApproval(`This delete will PERMANENTLY remove ${target} — the recycle bin is not in effect.\n\nReason: ${ctx.permanentDeleteRisk?.reason ?? "the system is configured to delete permanently"}\n\nApprove only if you accept that the data cannot be recovered.`);
			if (outcome !== "allowed-once") return {
				ok: false,
				target,
				error: approvalFailureText(outcome, target)
			};
		}
		const quota = assessQuota(description.bytes, { ...description.isDirectory === true ? { sizeIsLowerBound: true } : {} });
		if (quota.status !== "within") {
			const outcome = await ctx.requestApproval(`This delete may PERMANENTLY remove ${target} — ${quota.reason}.\n\nApprove only if you accept that the data cannot be recovered.`);
			if (outcome !== "allowed-once") return {
				ok: false,
				target,
				error: approvalFailureText(outcome, target)
			};
		}
		const recycled = await (ctx.recycler ?? recycleManyToSystemBin)([target]);
		const succeeded = recycled.succeededPaths;
		const failed = recycled.failedPaths;
		if (recycled.ok && (succeeded !== void 0 ? succeeded.includes(target) : failed !== void 0 ? !failed.includes(target) : recycled.recycled > 0)) {
			appendAudit(ctx.stateDir, {
				event: "delete",
				target,
				tool: "safe_delete",
				detail: `destination=recycle-bin cls=${gate.classification}${reason === void 0 ? "" : ` reason=${reason}`}`
			});
			return {
				ok: true,
				kind: "recycled",
				target,
				description,
				gate
			};
		}
		appendAudit(ctx.stateDir, {
			event: "delete",
			target,
			tool: "safe_delete",
			detail: `destination=recycle-bin fell back to safe zone: ${recycled.ok ? "the shell did not confirm this path was recycled" : recycled.reason}`
		});
	}
	const entry = await moveToSafeZone(ctx.stateDir, target, {
		retentionDays: ctx.retentionDays,
		now: ctx.now(),
		...ctx.crossVolumeCopy === true ? { crossVolumeCopy: true } : {},
		...reason === void 0 ? {} : { reason },
		...description.statsOmitted === true ? {} : { description }
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
/**
* 顶层条目列表后面那行「还有多少」。
*
* ## 为什么不能直接算差值（2026-11-04）
*
* 旧代码写 `${d.fileCount - 10} more`。回收站模式跳过统计时 `fileCount` 是 0，
* 于是打印出 `-10 more`。统计被跳过时改用不带数字的说法。
*
* @param d 目标描述。
* @returns 以换行开头的追加文本。
*/
function moreText(d) {
	if (d.statsOmitted === true) return "\n  … and more";
	const rest = d.fileCount - d.topEntries.slice(0, 10).length;
	return rest > 0 ? `\n  … and ${rest} more` : "\n  … and more";
}
/**
* 「多少个文件、多大」那一段。
*
* 统计被跳过时不能报 `0 entries, 0 B` —— 那是谎报目标为空。
*
* @param d 目标描述。
* @returns 人看的尺寸描述。
*/
function sizeText(d) {
	if (d.statsOmitted === true) return d.truncated ? `${d.topEntries.length}+ top-level entries` : `${d.topEntries.length} top-level entries`;
	return d.isDirectory ? `${d.fileCount} entries, ${humanBytes(d.bytes)}` : `file, ${humanBytes(d.bytes)}`;
}
/** 把预览结论拼成人看的文本。 */
function describePreview(result, retentionDays, destination = "safe-zone") {
	const d = result.description;
	const top = d.topEntries.length > 0 ? `\n  ${d.topEntries.slice(0, 10).join("\n  ")}${d.truncated ? moreText(d) : ""}` : "";
	return `PREVIEW (nothing moved):\n${result.target}\n${d.isDirectory ? "directory" : "file"}: ${sizeText(d)}${top}\n\nclassification: ${result.gate.classification}` + (result.gate.needsApproval ? ` — will need your approval (${result.gate.reasons.join("; ")})` : " — moves without asking") + (destination === "recycle-bin" ? "\nwill go into the system recycle bin — restore from there; the safe zone will not track it" : `\nretention: ${retentionDays} days`);
}
/** 把移动结论拼成人看的文本。 */
function describeMoved(result, retentionDays) {
	const d = result.description;
	const top = d.topEntries.length > 0 ? `\n  ${d.topEntries.slice(0, 10).join("\n  ")}${d.truncated ? moreText(d) : ""}` : "";
	const size = sizeText(d);
	return `moved to safe zone: ${result.target}\n  id: ${result.entry.id}  ${size}${top}\n  restore: safe_zone_restore id=${result.entry.id} (${retentionDays}d)` + (result.pruned.length > 0 ? `\n  pruned ${result.pruned.length} expired/over-cap entr${result.pruned.length === 1 ? "y" : "ies"}` : "");
}
/**
* 把「直接进回收站」的结论拼成人看的文本。
*
* 与 `describeMoved` 的关键差别：**没有条目 id**，因为安全区索引里没有它 ——
* 取回要去系统回收站，不是 `safe_zone_restore`。这一点必须写明，否则模型会
* 编一个 id 去调恢复工具。
*
* @param result 删除结果。
* @returns 人看的文本。
*/
function describeRecycled(result) {
	const d = result.description;
	const top = d.topEntries.length > 0 ? `\n  ${d.topEntries.slice(0, 10).join("\n  ")}${d.truncated ? moreText(d) : ""}` : "";
	return `moved to the system recycle bin: ${result.target}\n  ${d.isDirectory ? "directory" : "file"}: ${sizeText(d)}${top}\n  Restore it from the recycle bin itself — this deletion is not tracked in the safe zone, so safe_zone_restore cannot bring it back.`;
}
/**
* 硬拒绝：这些目标**永远**不许删，批量路径也一样。
*
* ## 为什么必须共享（2026-11-04 审查 Important-4）
*
* 这两条判定原来只写在 `deletePath` 里。批量删除走 `deleteMany`，它两条都没有；
* 而回收站分支又跳过了 `stageInto` 自带的自保护（那里也会拒绝安全区自身）。
*
* 于是 `paths: [stateDir]` 在改前被逐条拒绝，改后只要一次审批就能把**安全区
* 自己**（旧删除的唯一副本）送进回收站 —— 数据丢失级别的回归。
*
* @param target 已 resolve 的目标路径。
* @param stateDir 安全区根目录。
* @returns 拒绝原因；可以删时返回 `undefined`。
*/
function hardRefusal(target, stateDir) {
	if (isDriveRoot(target)) return `refusing to trash a filesystem root "${target}"`;
	if (isInsideStateDir(target, stateDir) || isInsideStateDir(stateDir, target)) return `refusing to delete "${target}": it is the safe zone's own state directory`;
}
//#endregion
export { approvalFailureText, boundReason, decideGate, deletePath, describeApprovalRequest, describeMoved, describePreview, describeRecycled, describeSpaceRisks, forecastSpace, hardRefusal, humanBytes, isDriveRoot, isInsideStateDir, normalizeDestination };
