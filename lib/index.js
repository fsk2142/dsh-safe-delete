import { i as requiresApproval, n as createTools, r as classifyPath } from "./tools-CWoYWfZu.js";
import { s as describeTarget } from "./store-B4qDFAaC.js";
import os from "node:os";
import path from "node:path";
//#region src/command.ts
/**
* 删除类动词表。
*
* 顺序重要：长动词排在短动词前面，否则 `rmdir` 会被 `rm` 抢先匹配。
*
* 含 PowerShell 的**文档化别名**（`ri` / `del` / `erase` / `rd` / `rmdir` 都是
* Remove-Item 的别名）。别名漏一个，模型换个拼写就绕过了。
*/
const DELETE_VERBS = [
	"remove-item",
	"rmtree",
	"removedir",
	"unlink",
	"rmdir",
	"erase",
	"rd",
	"ri",
	"rm",
	"del"
];
/**
* 无法静态判定目标、但明确可能是删除的构造。
*
* `powershell -EncodedCommand <base64>`：命令内容静态看不到。这类构造不能当作
* "安全"放行 —— 必须交给人看。返回 `true` 表示"看不清，请人判断"。
*/
const OPAQUE_EXECUTION = [/-e(?:nc|ncodedcommand)\s+\S+/i, /frombase64string/i];
/**
* 在判定前把 shell 的「转义与引号拼接」归一化。
*
* 为什么必须有这一步：`r\m`、`r""m`、`r''m`、`^rm`、`\rm` 在真实 shell 里都等价于
* `rm`。只做朴素文本匹配的拦截器，换个写法就被绕过 —— 而绕过正是这个插件要防的事。
*
* 注意只处理"转义一个命令名首字符"的情形，不碰路径分隔符：`C:\Work` 里的 `\W`
* 是目录分隔，不是转义。
*/
function normalizeObfuscation(text) {
	return text.replace(/""/g, "").replace(/''/g, "").replace(/``/g, "").replace(/\^(?=[A-Za-z])/g, "").split(/(\s*[|;&]\s*)/).map((segment) => {
		if (/^\s*[|;&]\s*$/.test(segment)) return segment;
		const match = /^(\s*)(\S+)([\s\S]*)$/.exec(segment);
		if (match === null) return segment;
		const lead = match[1] ?? "";
		const first = match[2] ?? "";
		const rest = match[3] ?? "";
		return `${lead}${/^[A-Za-z][A-Za-z0-9_-]*$/.test(first.replace(/\\/g, "")) ? first.replace(/\\(?=[a-z])/g, "").replace(/^\\+/, "") : first}${rest}`;
	}).join("");
}
/** 递归标记。`/s` 只在 Windows `rd`/`rmdir`/`del` 语境下有意义，但多判一次无害。 */
const RECURSIVE_FLAGS = [
	"-recurse",
	"-r",
	"-rf",
	"-fr",
	"/s",
	"--recursive"
];
/**
* Windows 风格短选项（`rd /s`、`del /q`）。
*
* 必须是**白名单**而不是「以 / 开头」：POSIX 绝对路径也以 `/` 开头，
* 用前缀判定会把 `rm -rf /tmp/x` 的目标当成选项跳过，于是误判成「目标无法解析」。
*/
const WINDOWS_FLAGS = /* @__PURE__ */ new Set([
	"/s",
	"/q",
	"/f",
	"/r",
	"/p",
	"/a",
	"/d"
]);
/** 需要跳过的选项类 token。 */
function isOptionToken(token) {
	if (token.startsWith("-")) return true;
	return WINDOWS_FLAGS.has(token.toLowerCase());
}
/**
* 判断一个「目标」是否根本无法静态解析。
*
* 命中即 `true`：shell 变量（`$x`、`$env:X`、`${X}`、`$_.Prop`）、Windows 变量
* （`%X%`）、通配符（`*`、`?`）、命令替换（`$(...)`、反引号）。
*/
function isUnresolvableTarget(target) {
	if (target === "") return true;
	if (target.includes("$")) return true;
	if (target.includes("%")) return true;
	if (target.includes("*")) return true;
	if (target.includes("?")) return true;
	if (target.includes("`")) return true;
	return false;
}
/** 一行里是否含管道分隔（`|`，但不含 `||` 之外的复杂情况——判为不可解析即可）。 */
function hasPipeline(command) {
	return command.includes("|");
}
/**
* 在动词之后找目标 token。
*
* 返回 `null` 表示无法确定目标（管道、命令替换、通配、变量、找不到 token）。
*/
function targetAfterVerb(tokens, verbIndex, command) {
	if (hasPipeline(command)) return null;
	if (command.includes("$(") || command.includes("`")) return null;
	for (let i = verbIndex + 1; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === void 0) continue;
		if (isOptionToken(token)) continue;
		const cleaned = token.replace(/^['"]|['"]$/g, "");
		if (cleaned === "") continue;
		if (isUnresolvableTarget(cleaned)) return null;
		return cleaned;
	}
	return null;
}
/**
* 解析命令文本。
*
* @param command 命令原文（可以是 shell 命令，也可以是 `run_code` 的代码体）。
*/
function parseCommand(command) {
	const raw = command ?? "";
	const text = normalizeObfuscation(raw);
	const lower = text.toLowerCase();
	const tokens = text.split(/\s+/).filter((t) => t !== "");
	if (OPAQUE_EXECUTION.some((pattern) => pattern.test(raw))) return {
		destructive: true,
		kind: "delete",
		recursive: RECURSIVE_FLAGS.some((flag) => lower.includes(flag)),
		target: null
	};
	let verbIndex = -1;
	let matchedVerb = "";
	for (const verb of DELETE_VERBS) for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i].toLowerCase().replace(/^['"]|['"]$/g, "");
		if (token === verb) {
			if (verbIndex === -1 || i < verbIndex) {
				verbIndex = i;
				matchedVerb = verb;
			}
			break;
		}
		const callMatch = /^(?:[a-z_.]*\.)?([a-z]+)\s*\(/i.exec(token);
		if (callMatch !== null) {
			const callee = callMatch[1].toLowerCase();
			if ((callee === "rm" || callee === "rmsync" || callee === "rmtree" || callee === "unlink" || callee === "unlinksync" || callee === "remove" || callee === "removesync" || callee === "removedir") && (verbIndex === -1 || i < verbIndex)) {
				verbIndex = i;
				matchedVerb = callee;
			}
		}
	}
	if (verbIndex === -1) return { destructive: false };
	const flagTokens = tokens.map((t) => t.toLowerCase());
	const recursive = matchedVerb === "rmtree" || matchedVerb === "removedir" || flagTokens.some((token) => RECURSIVE_FLAGS.includes(token)) || /recursive\s*:\s*true/.test(lower);
	const callTarget = extractCallLiteral(text);
	if (callTarget !== null) return {
		destructive: true,
		kind: "delete",
		recursive,
		target: callTarget
	};
	return {
		destructive: true,
		kind: "delete",
		recursive,
		target: targetAfterVerb(tokens, verbIndex, text)
	};
}
/**
* 从函数式调用里取第一个字符串字面量作为目标。
*
* @returns 字面量路径；找不到或该字面量不可解析时返回 `null`。
*/
function extractCallLiteral(text) {
	const match = /\(\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(text);
	if (match === null) return null;
	const literal = match[2].replace(/\\(.)/g, "$1");
	if (literal === "" || isUnresolvableTarget(literal)) return null;
	return literal;
}
//#endregion
//#region src/index.ts
/**
* dsh-safe-delete host half.
*
* 让 DSH 里的删除变成可逆操作：裸 shell 删除被拦下并改走安全删除，危险路径的
* 删除在界面内点一下授权，删掉的内容进安全区、保留期内可原样取回。
*
* 这个文件只做**接线**，不含业务判断 —— 判定在 `command.ts` / `classify.ts`，
* 存储与清理在 `store.ts` / `prune.ts`。这样"什么东西会被删"这件事可以被单独
* 穷举验证，而不必启动一个 DSH。
*
* 三个刻意的约束：
*   1. 零外部运行时 import（只用 `node:*` 与包内相对路径）。以 `link:` 裸装的
*      bundle 没有自带 node_modules，import `@deepseek-ai/*` 会在启动时解析失败。
*   2. fail-soft：注册失败只降级记日志，安全插件自身绝不能成为 DSH 启动失败的原因。
*   3. 拦截走 `tools/pre-execute` 而不是 `tools.guard` —— guard 只能拒绝，
*      pre-execute 还能返回 `ask`，而 `ask` 会走到 DSH 自带的界面审批卡片。
*      这正是 dsh-safety 需要另开终端敲 `allow` 的根因。
*/
const name = "dsh-safe-delete";
/** 需要的服务：工具注册表与系统提示。 */
const inject = ["tools", "systemPrompt"];
/** 需要检查删除意图的工具 → 取出命令文本的字段名。 */
const SHELL_TOOLS = {
	bash: "command",
	pwsh: "command",
	run_code: "code",
	terminal_send: "text"
};
/**
* 插件入口。任何注册异常都在这里被吞掉并记日志 —— 见文件头「fail-soft」。
*/
function apply(ctx, config = {}) {
	try {
		applyInner(ctx, config);
	} catch (error) {
		try {
			(ctx.get?.("logger"))?.warn?.("dsh-safe-delete: apply failed — fail-soft, continuing boot", error);
		} catch {}
	}
}
/** 解析 `DSH_HOME`。 */
function resolveDshHome() {
	const fromEnv = process.env["DSH_HOME"];
	if (fromEnv !== void 0 && fromEnv !== "") return path.resolve(fromEnv);
	return path.join(os.homedir(), ".dsh");
}
function applyInner(ctx, config) {
	const dshHome = resolveDshHome();
	const stateDir = path.resolve(config.stateDir ?? path.join(dshHome, ".dsh-safe-delete"));
	const env = {
		home: os.homedir(),
		workdir: process.cwd(),
		dshHome
	};
	const retentionDays = typeof config.retentionDays === "number" && config.retentionDays > 0 ? config.retentionDays : 7;
	const maxBytes = typeof config.maxBytes === "number" && config.maxBytes > 0 ? config.maxBytes : 21474836480;
	const requestApproval = async () => "allowed-once";
	/**
	* 会话当前的审批策略。
	*
	* 为什么需要它：策略为 `never` 时，管线会在瀑布分发**之前**就把 `ask` 驳回成
	* `rejected`，卡片根本不会出现。此时若仍然返回 `ask`，结果不是"多问一句"，
	* 而是"什么都不许删" —— 用户切到 never 往往正是为了能干活（全盘访问），
	* 于是删除能力被无声地废掉。这正是我们要消灭的那种「因为流程不通所以干不了活」。
	*
	* 所以：`never` 下不再返回 `ask`，而是放行到安全删除 —— **可恢复这件事不依赖
	* 审批通道**，文件照样进安全区、照样能取回，只是少了当面确认这一步。
	*
	* 注意区分两种"问不成"：
	*   - 没有审批服务（插件没装 / 被裁剪）：这是一个配置事实，不代表用户想自动放行。
	*     仍然返回 `ask`，让管线按它自己的规则 fail-closed。
	*   - 有服务但策略是 `never`：用户明确选择了"别问我"。此时 ask 只会被静默驳回，
	*     返回它等于废掉删除能力，所以降级放行到安全删除。
	*/
	const approvalPolicy = () => {
		const approval = ctx.get("approval");
		if (approval === void 0 || approval === null) return "absent";
		try {
			const override = approval.overrideOf?.(void 0);
			if (override === "ask" || override === "never") return override;
		} catch {}
		return "ask";
	};
	const tools = createTools({
		stateDir,
		env,
		requestApproval,
		retentionDays,
		maxBytes,
		autoPrune: config.autoPrune !== false
	});
	const registry = ctx.get("tools");
	if (registry?.register !== void 0) for (const tool of tools) registry.register(tool);
	const onPreExecute = async (exec, next) => {
		const toolName = exec?.name;
		if (toolName === void 0) return next();
		if (toolName === "safe_delete") {
			const rawPath = exec.arguments?.["path"];
			if (exec.arguments?.["preview"] === true || typeof rawPath !== "string" || rawPath === "") return next();
			const target = path.resolve(rawPath);
			let classification;
			try {
				classification = classifyPath(target, env);
			} catch {
				return next();
			}
			if (!requiresApproval(classification)) return next();
			if (approvalPolicy() === "never") return next();
			let description;
			try {
				description = describeTarget(target);
			} catch {
				description = void 0;
			}
			return {
				kind: "ask",
				reason: `Delete "${target}"?${description === void 0 ? "" : ` ${description.isDirectory ? "Directory" : "File"}, ${description.fileCount} entries, ${description.bytes} bytes.`} It will be moved into the safe zone and can be restored for ${retentionDays} days.`,
				displayReason: {
					en: `Delete "${target}"? It moves into the safe zone and can be restored for ${retentionDays} days.`,
					zh: `删除“${target}”？它会移入安全区，${retentionDays} 天内可以取回。`
				}
			};
		}
		const field = SHELL_TOOLS[toolName];
		if (field === void 0) return next();
		if (config.blockShellDeletes === false) return next();
		const text = exec.arguments?.[field];
		if (typeof text !== "string" || text === "") return next();
		let verdict;
		try {
			verdict = parseCommand(text);
		} catch {
			return next();
		}
		if (!verdict.destructive) return next();
		if (verdict.target === null || isUnresolvableTarget(verdict.target)) return {
			kind: "ask",
			reason: `A delete command was requested whose target cannot be resolved statically: ${text.trim()}. Review the command text before allowing it.`,
			displayReason: {
				en: "A delete command targets something that cannot be resolved (a variable, pipeline or wildcard). Review the command before allowing it.",
				zh: "有一条删除命令的目标无法静态解析（变量、管道或通配符）。请先看清命令内容再决定。"
			}
		};
		return {
			kind: "deny",
			reason: `Blocked a raw shell delete of "${verdict.target}" (${verdict.recursive ? "recursive" : "non-recursive"}). Deleting through the shell erases data permanently. Use the \`safe_delete\` tool instead: it moves the target into the safe zone, where it can be restored for a while. Run \`safe_delete\` with preview:true to see exactly what would be moved, then call it again to do it. Do not retry this shell command or look for another way around the block.`,
			displayReason: {
				en: `Blocked a raw shell delete of "${verdict.target}". Use safe_delete so it can be restored.`,
				zh: `已拦下对 "${verdict.target}" 的原始 shell 删除。请改用 safe_delete，这样还能取回。`
			}
		};
	};
	const on = ctx.on;
	if (typeof on === "function") on.call(ctx, "tools/pre-execute", onPreExecute);
	const systemPrompt = ctx.get("systemPrompt");
	if (systemPrompt?.section !== void 0) systemPrompt.section({
		name: "dsh-safe-delete:policy",
		order: 200,
		text: "Deleting files — deletion in DSH goes through the `safe_delete` tool, not through the shell.\n- Before deleting anything you are unsure about, call `safe_delete` with `preview: true`. It reports the size, the entry count and whether the path is dangerous, and changes nothing.\n- Then call `safe_delete` without `preview` to move it into the safe zone. Ordinary workspace files move straight away; dangerous paths (the OS home directory, plugin sources, profile manifests, node_modules) show the user an approval card first.\n- If a raw shell delete is blocked, do NOT retry it, do not switch to another tool, and do not rename or encode your way around it. Use `safe_delete`. That is the only sanctioned delete path.\n- If the user rejects an approval, stop and ask what they actually want. Do not look for another route.\n- Deleted items stay in the safe zone for a while and can be brought back with `safe_zone_restore id=<id>`; `safe_zone_list` shows what is there."
	});
}
//#endregion
export { apply, inject, name };
