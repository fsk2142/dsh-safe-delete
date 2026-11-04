import { appendAudit } from "./audit.js";
import { _ as describeTarget, a as listSafeZone, m as detectQuotaRisk, p as detectPermanentDeleteRisk, u as restoreFromSafeZone, v as classifyPath } from "./store-D4IxKQnZ.js";
import { i as requestCleanup, n as readCleanupJob } from "./cleanup-C1Bp2Hw-.js";
import { decideGate, deletePath, describeMoved, describePreview, describeRecycled, humanBytes as humanBytes$1, normalizeDestination } from "./delete-core.js";
import { n as createTools, r as normaliseDeleteTargets } from "./tools-Ctt8Cwds.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
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
* 不经过"删除动词"表达删除的构造。
*
* 为什么要单独一张表：`find -delete`、`rsync --delete`、`.Delete()`、`.unlink()`
* 这些写法里没有 `rm`/`del` 这类动词，靠动词表永远匹配不到。它们同样是真删除，
* 漏掉就是静默失效 —— 用户以为有保护，实际没有。
*
* 命中即视为删除意图；目标仍按常规方式抽取（抽不出就 `ask`）。
*/
/**
* 会**执行**引号里那段代码的包装器（2026-11-01 审查 SD-17）。
*
* `sh -c "rm x"`、`node -e "unlink(...)"`、`powershell -Command "..."` ——
* 引号里的删除字样会被真的执行。而 `const note = "file.Delete()"` 的同样
* 字样只是普通字符串。
*
* 这个集合用来区分两者：只有命令头是这些包装器时，才把引号内的删除字样
* 当真删除。
*/
const RUNS_INLINE_CODE = /* @__PURE__ */ new Set([
	"sh",
	"bash",
	"zsh",
	"cmd",
	"powershell",
	"pwsh",
	"node",
	"nodejs",
	"python",
	"python3",
	"perl",
	"ruby",
	"eval",
	"exec",
	"invoke-expression",
	"iex"
]);
const DELETE_PATTERNS = [
	{
		label: "find -delete",
		pattern: /\bfind\b[^\n|]*\s-delete\b/i
	},
	{
		label: "rsync --delete",
		pattern: /\brsync\b[^\n|]*\s--del(?:ete)?\b/i
	},
	{
		label: ".Delete() method",
		pattern: /\.Delete\s*\(/
	},
	{
		label: ".unlink() method",
		pattern: /\.unlink(?:sync)?\s*\(/i
	},
	{
		label: ".rmdir() method",
		pattern: /\.rmdir(?:sync)?\s*\(/i
	},
	{
		label: "perl unlink",
		pattern: /\bunlink\s+[q']/i
	}
];
/**
* 拆开"执行一段字符串"的包装器，取出它要执行的命令。
*
* 覆盖：`cmd /c "…"`、`sh|bash|zsh -c "…"`、`powershell|pwsh -Command|-c "…"`、
* `Invoke-Expression "…"` / `iex "…"`、`eval "…"`。
*
* @param command 已去注释的文本。
* @returns 内层命令；不是包装器时返回 `null`。
*/
function unwrapExecutedCommand(command) {
	const trimmed = command.trim();
	const expression = /^(?:invoke-expression|iex|eval)\s+([\s\S]+)$/i.exec(trimmed);
	if (expression !== null) return stripOuterQuotes(expression[1].trim());
	const wrapper = /^(?:cmd|sh|bash|zsh)\s+\/c\s+([\s\S]+)$/i.exec(trimmed) ?? /^(?:sh|bash|zsh)\s+-c\s+([\s\S]+)$/i.exec(trimmed) ?? /^(?:powershell|pwsh)(?:\.exe)?\s+(?:-command|-c|-encodedcommand)\s+([\s\S]+)$/i.exec(trimmed);
	if (wrapper !== null) return stripOuterQuotes(wrapper[1].trim());
	const interpreter = /^(?:[^\s]*[\\/])?(?:python[0-9.]*|node|nodejs|perl|ruby|php|lua)(?:\.(?:exe|com|bat|cmd))?\s*(?:-c|-e|-E|-r|-p|--print)\s*([\s\S]+)$/i.exec(trimmed);
	if (interpreter !== null) return stripOuterQuotes(interpreter[1].trim());
	return null;
}
/**
* 去掉最外层的一对引号（`"…"`、`'…'`）。
*/
function stripOuterQuotes(text) {
	const first = text[0];
	const last = text[text.length - 1];
	if ((first === "\"" || first === "'") && first === last) return text.slice(1, -1);
	return text;
}
function stripComments(command) {
	let out = "";
	let i = 0;
	/** 当前所处的引号：`'`、`"` 或 `null`。 */
	let quote = null;
	while (i < command.length) {
		const ch = command[i];
		if (quote !== null) {
			out += ch;
			if (ch === "\\" && i + 1 < command.length) {
				out += command[i + 1];
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			i += 1;
			continue;
		}
		if (ch === "'" || ch === "\"") {
			quote = ch;
			out += ch;
			i += 1;
			continue;
		}
		if (ch === "#") {
			const prev = i === 0 ? " " : command[i - 1];
			if (i === 0 || /\s/.test(prev)) {
				while (i < command.length && command[i] !== "\n") i += 1;
				continue;
			}
		}
		if (ch === "/" && command[i + 1] === "/") {
			while (i < command.length && command[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && command[i + 1] === "*") {
			const close = command.indexOf("*/", i + 2);
			if (close !== -1) {
				i = close + 2;
				out += " ";
				continue;
			}
		}
		out += ch;
		i += 1;
	}
	return out;
}
/**
* 把**引号内的内容**替换成空格，只保留引号本身。
*
* ## 为什么需要（2026-11-01 审查 SD-17）
*
* `DELETE_PATTERNS` 里有 `.delete(` 这类方法调用形态。而字符串里也可能
* 出现同样的字样：
*
* ```
* const note = "file.Delete()"     ← 只是字符串，不会执行
* file.Delete()                    ← 真实调用
* ```
*
* 两者在"去注释后"的文本里长得一样。要区分它们，必须知道那个 `.Delete()`
* 是不是在引号里。
*
* 这个函数把 `"..."` 与 `'...'` 的内容抹成空格，于是：
*   - `const note = "file.Delete()"` → `const note = "              "`
*   - `file.Delete()` → 原样保留
*
* ## 为什么保留引号本身
*
* `targetFromPattern` 需要看引号来抽取目标路径。抹掉引号会让它误判。
*
* @param text 文本。
* @returns 引号内容被空格替换后的文本。
*/
function blankQuotedContent(text) {
	let out = "";
	let i = 0;
	let quote = null;
	while (i < text.length) {
		const ch = text[i];
		if (quote === null) {
			if (ch === "'" || ch === "\"") {
				quote = ch;
				out += ch;
				i += 1;
				continue;
			}
			out += ch;
			i += 1;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			out += "  ";
			i += 2;
			continue;
		}
		if (ch === quote) {
			quote = null;
			out += ch;
			i += 1;
			continue;
		}
		out += ch === "\n" ? "\n" : " ";
		i += 1;
	}
	return out;
}
/**
* 整条文本是否只是**一条赋值语句**（不会执行任何命令）。
*
* ## 为什么需要（2026-11-01 定版复核第 9 项）
*
* `const note = "fs.unlinkSync('x')"` 只是把字符串赋给变量。但
* `tokenize` 会剥掉引号并把内容并进 token 流，于是 `.unlinkSync(` 这类
* 模式仍能被匹配 —— 一次赋值被判成删除（实测 target="x"）。
*
* ## 判据（刻意窄）
*
* - 形如 `<可选 const/let/var/带类型> 标识符 = 值`；
* - **不含**命令分隔符（`;` `&&` `||` `|` 换行）。
*
* 不含分隔符是关键：`x = 1; rm -rf /tmp` 必须继续被判为删除（交给逐段
* 判定），所以这里只放行"整条就是一个赋值"的情况。
*
* @param text 已去注释的文本。
* @returns 是纯赋值返回 true。
*/
function isPureAssignment(text) {
	const withoutTrailing = text.trim().replace(/;\s*$/, "");
	if (/[;&|\n\r]/.test(withoutTrailing)) return false;
	const trimmed = text.trim();
	if (trimmed === "") return false;
	const assignment = /^(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:\s*[^=]+?)?\s*=\s*([\s\S]+)$/.exec(trimmed) ?? /^[A-Za-z_$][\w$]*\s*=\s*([\s\S]+)$/.exec(trimmed);
	if (assignment === null) return false;
	const rhs = (assignment[1] ?? "").trim();
	if (rhs === "") return false;
	const body = rhs.endsWith(";") ? rhs.slice(0, -1).trim() : rhs;
	if (body === "") return false;
	if (body.startsWith("`") && body.endsWith("`")) {
		if (body.length < 2) return false;
		if (body.includes("${")) return false;
		const inner = body.slice(1, -1);
		if (containsDeleteCommand(inner)) return false;
		if (tokenize(inner).some((t) => isDeleteArgumentMarker(t))) return false;
		if (hasCallStyleDelete(blankQuotedContent(inner))) return false;
		if (!/^(?:const|let|var)\s/.test(trimmed) && !provenHarmless(inner)) return false;
		return true;
	}
	const quote = body[0];
	if (quote === "'" || quote === "\"") {
		if (!body.endsWith(quote) || body.length < 2) return false;
		const inner = body.slice(1, -1);
		if (new RegExp(`(^|[^\\\\])${quote === "'" ? "'" : "\""}`).test(inner)) return false;
		if (quote === "'") return true;
		for (const substitution of commandSubstitutions(`"${inner}"`)) {
			if (!provenHarmless(substitution)) return false;
			if (containsDeleteCommand(substitution)) return false;
			if (tokenize(substitution).some((t) => isDeleteArgumentMarker(t))) return false;
			if (hasCallStyleDelete(blankQuotedContent(substitution))) return false;
		}
		return true;
	}
	const constructor = /^new\s+[A-Z][\w$]*\s*\(([\s\S]*)\)$/.exec(body);
	if (constructor !== null) {
		if (!/^new\s+(?:Map|Set|WeakMap|WeakSet|Array|Date)\s*\(/.test(body)) return false;
		return isPureLiteralValue((constructor[1] ?? "").trim());
	}
	if (/^\[[\s\S]*\]$/.test(body) || /^\{[\s\S]*\}$/.test(body)) return isPureLiteralValue(body);
	return /^(?:-?\d+(?:\.\d+)?|true|false|null|undefined)$/.test(body);
}
/**
* 判断一段值是否是**纯字面量**（求值不会产生任何副作用）。
*
* ## 为什么需要递归（2026-11-02 定版验收 F7-S1）
*
* 上一版只检查外层形状：
*
* ```
* const result = { deleted: require("fs").rmSync("/tmp/x") }   ← 属性值会求值
* const result = [require("fs").rmSync("/tmp/x")]              ← 元素会求值
* const result = new Array([require("fs").rmSync("/tmp/x")])   ← 构造参数会求值
* ```
*
* 三条都被当成"纯数据"放行。而 JS 里对象属性、数组元素、构造参数**都会
* 在赋值完成前求值** —— 删除已经执行了。
*
* ## 判据（递归下降，不做完整 JS 解析）
*
* 允许：
*   - 数字 / 字符串 / 布尔 / null / undefined
*   - 数组 `[…]`，其中每个元素都能证明
*   - 对象 `{…}`，其中每个值都能证明（键名不限制）
*
* 拒绝：
*   - 任何调用 `f(` / `x.y(`
*   - `require` / `import`
*   - 模板插值 `${`
*   - 二次求值：`=>`、`function`、`eval`
*   - 二元/一元运算（可能藏调用）
*
* @param text 值文本（已去首尾空白）。
* @returns 能证明是纯字面量返回 true。
*/
function isPureLiteralValue(text) {
	const t = text.trim();
	if (t === "") return true;
	if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(t)) return true;
	if (/^(?:true|false|null|undefined|NaN|Infinity|True|False|None)$/.test(t)) return true;
	if (t.startsWith("'") && t.endsWith("'") || t.startsWith("\"") && t.endsWith("\"") || t.startsWith("`") && t.endsWith("`")) return !t.slice(1, -1).includes("${") && t.length >= 2;
	if (t.startsWith("[") && t.endsWith("]")) {
		const inner = t.slice(1, -1).trim();
		if (inner === "") return true;
		return splitTopLevel(inner, ",").every((part) => isPureLiteralValue(part));
	}
	if (t.startsWith("{") && t.endsWith("}")) {
		const inner = t.slice(1, -1).trim();
		if (inner === "") return true;
		return splitTopLevel(inner, ",").every((entry) => {
			const trimmed = entry.trim();
			const colon = findTopLevel(trimmed, ":");
			if (colon === -1) return /^[A-Za-z_$][\w$]*$/.test(trimmed);
			const key = trimmed.slice(0, colon).trim();
			const value = trimmed.slice(colon + 1).trim();
			if (key.startsWith("[") && key.endsWith("]")) return false;
			if (!/^(?:[A-Za-z_$][\w$]*|'[^']*'|"[^"]*"|\d+)$/.test(key)) return false;
			return isPureLiteralValue(value);
		});
	}
	return false;
}
/**
* 按顶层分隔符切分（忽略括号与引号内部）。
*
* @param text 文本。
* @param separator 单字符分隔符。
* @returns 各段。
*/
function splitTopLevel(text, separator) {
	const parts = [];
	let depth = 0;
	let quote = null;
	let current = "";
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quote !== null) {
			current += ch;
			if (ch === "\\" && i + 1 < text.length) {
				current += text[i + 1];
				i += 1;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === "\"" || ch === "`") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") depth += 1;
		else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
		if (ch === separator && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	parts.push(current);
	return parts;
}
/**
* 找顶层某个字符的位置（忽略括号与引号内部）。
*
* @param text 文本。
* @param target 目标字符。
* @returns 索引；找不到返回 -1。
*/
function findTopLevel(text, target) {
	let depth = 0;
	let quote = null;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quote !== null) {
			if (ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === "\"" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") depth += 1;
		else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
		else if (ch === target && depth === 0) return i;
	}
	return -1;
}
/**
* 判断一条命令是否**可以证明**不会删除任何东西。
*
* ## 为什么判定方向反过来了（2026-11-02 架构调整）
*
* 前五轮的做法是"找删除证据"：识别到就拦，找不到就放行。
* 每轮复审都能找出一种没识别到的写法，而写法是无穷的 ——
* 实测 10 个等价写法里漏了 4 个，且能无限造新的。
*
* 根因不在某条规则，在**默认值**：`return { destructive: false }` 把
* "没找到证据"当成了"证明无害"。
*
* 现在：每一段都必须**正向证明**只读（`provenHarmless`），否则不算
* "仅提及"。未知写法的默认归宿从"放行"变成"要求审批"。
*
* ## 与旧版的差别
*
* 旧版 `segments.slice(1)` —— **跳过第一段**，只检查后续段。
* 于是第一段里的命令替换、或者整条就是一个替换时，检查不到。
* 现在每一段都要证明，包括第一段。
*
* @param command 命令原文。
* @returns 能证明无害返回 true（调用方据此放行）。
*/
function mentionsOnly(command) {
	const segments = splitOutsideQuotes(stripComments(command));
	if (segments.length === 0) return false;
	for (const segment of segments) if (!provenHarmless(segment)) return false;
	return true;
}
/**
* 把"删除"作为参数转发的工具。
*
* `find ... -exec rm {} \;`、`cat list | xargs rm`、`Get-Content | ForEach-Object { Remove-Item }`
* —— 这些命令自己的名字不含删除动词，但会把删除执行掉。
*/
const DELETES_VIA_ARGUMENT = /* @__PURE__ */ new Set([
	"xargs",
	"find",
	"foreach-object",
	"foreach",
	"start-job",
	"start-threadjob"
]);
/**
* 取出所有命令替换的内容：`$(...)` 与反引号 `` `...` ``。
*
* 为什么必须单独处理：这两种写法在真实 shell 里是**先执行**再取输出。
* `echo $(rm -rf /tmp/x)` 的段首是 `echo`（只读），但删除真会发生。
*
* @param text 命令文本。
* @returns 每处替换内部的文本（可能为空数组）。
*/
function commandSubstitutions(text) {
	const found = [];
	const inSingleQuote = singleQuoteMask(text);
	for (let i = 0; i < text.length - 1; i += 1) {
		if (inSingleQuote[i] === true) continue;
		if (text[i] !== "$" || text[i + 1] !== "(") continue;
		let depth = 1;
		let j = i + 2;
		for (; j < text.length && depth > 0; j += 1) if (text[j] === "(") depth += 1;
		else if (text[j] === ")") depth -= 1;
		if (depth === 0) found.push(text.slice(i + 2, j - 1));
	}
	let cursor = 0;
	while (cursor < text.length) {
		const open = text.indexOf("`", cursor);
		if (open === -1) break;
		const close = text.indexOf("`", open + 1);
		if (close === -1) break;
		if (inSingleQuote[open] !== true) found.push(text.slice(open + 1, close));
		cursor = close + 1;
	}
	return found;
}
/**
* 标记每个字符是否处在单引号区间内。
*
* ## 为什么要处理双引号里的单引号
*
* `echo "'$(rm -rf x)'"` 里那个单引号在**双引号内部**，不是单引号字符串的开始 ——
* POSIX 会照常执行 `$()`。如果朴素地"见到单引号就翻转状态"，这段会被判成
* 单引号区间，替换就被漏掉了（第四轮审查实测确认）。
*
* 规则：双引号区间内的单引号当普通字符；只有双引号**之外**的单引号才开启区间。
*
* @param text 命令文本。
* @returns 与 text 等长的布尔数组。
*/
function singleQuoteMask(text) {
	const mask = new Array(text.length).fill(false);
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (inSingle) {
			mask[i] = true;
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\"") inDouble = false;
			mask[i] = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			mask[i] = true;
			continue;
		}
		if (ch === "\"") {
			inDouble = true;
			mask[i] = false;
			continue;
		}
		mask[i] = false;
	}
	return mask;
}
/**
* 按 shell 的命令分隔符切段，但**跳过引号内部**。
*
* 为什么不能直接 `split(/;/)`：`cat 'x; rm -rf y'` 里那个分号是字符串内容，
* 不是命令分隔。朴素切分会把它当成两条命令，于是第二段「以删除动词开头」，
* 整条被判成删除 —— 误伤。
*
* @param text 命令文本。
* @returns 各段（已 trim，空段被丢弃）。
*/
function splitOutsideQuotes(text) {
	const segments = [];
	let current = "";
	let quote = null;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i] ?? "";
		if (quote !== null) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "\"" || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "\r") {
			segments.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	segments.push(current);
	return segments.map((s) => s.trim()).filter((s) => s !== "");
}
/**
* 一段文本里是否含有会执行删除的命令。
*
* 不用 `tokenize` 来做主判断：它会把 `$(rm -rf x)` 整体当成一个 token，
* 于是里面的动词摸不到。这里同时看「切分后的 token」和「原始子串」两条线。
*
* @param text 一段命令文本。
* @returns 含有删除命令时为 `true`。
*/
function containsDeleteCommand(text) {
	const segments = splitOutsideQuotes(text);
	for (const segment of segments) {
		const tokens = tokenize(segment).map((t) => t.toLowerCase().replace(/^['"]|['"]$/g, ""));
		for (let i = 0; i < tokens.length; i += 1) {
			const token = tokens[i] ?? "";
			if (!isCommandPosition(tokens, i)) continue;
			if (isDeleteVerb(token)) return true;
			if (DELETES_VIA_ARGUMENT.has(token) && tokens.some((t) => isDeleteVerb(t))) return true;
		}
	}
	for (const inner of commandSubstitutions(text)) if (containsDeleteCommand(inner) && innerHasCommandVerb(inner)) return true;
	const unwrapped = unwrapExecutedCommand(text);
	if (unwrapped !== null && containsDeleteCommand(unwrapped)) return true;
	return false;
}
/**
* 命令替换内容里是否真的在**执行**删除。
*
* 只看该段自身的命令位：`$(cat rm.txt)` 里的 `rm.txt` 不是命令。
*
* @param text 命令替换内部文本。
* @returns 在执行删除时为 `true`。
*/
function innerHasCommandVerb(text) {
	const segments = splitOutsideQuotes(text);
	for (const segment of segments) {
		const tokens = tokenize(segment).map((t) => t.toLowerCase().replace(/^['"]|['"]$/g, ""));
		for (let i = 0; i < tokens.length; i += 1) {
			if (!isCommandPosition(tokens, i)) continue;
			if (isDeleteVerb(tokens[i] ?? "")) return true;
		}
	}
	return false;
}
/** 判断一个 token 是否就是删除动词（去引号、按 basename 比、忽略 .exe/.com）。 */
function isDeleteVerb(token) {
	const cleaned = token.toLowerCase().replace(/^['"]|['"]$/g, "");
	const base = cleaned.split(/[\\/]/).pop() ?? cleaned;
	const withoutExe = base.replace(/\.(exe|com|cmd|bat)$/, "");
	return DELETE_VERBS.includes(base) || DELETE_VERBS.includes(withoutExe);
}
/**
* 在**参数位置**表达删除的标记（2026-11-01 审查 SD-10）。
*
* `DELETE_VERBS` 是**命令名**的集合。但有些工具把删除表达为**选项**：
*
* ```
* find /tmp/x -delete          ← 命令名是 find（不在 DELETE_VERBS 里）
* rsync --delete src/ dst/     ← 命令名是 rsync
* ```
*
* 切段后的 `mentionsOnly` 只查段首是不是删除动词，于是
* `echo ready; find /tmp/x -delete` 被判为"仅提及"而放行 ——
* 而 `find /tmp/x -delete` 单独出现时能被别处的整串正则抓到。
*
* 隔离验证：前者 `destructive=false`，后者 `true`。同一个删除，加了只读前缀
* 就豁免了。
*/
/**
* 可以**证明**只读的命令（正向白名单）。
*
* ## 为什么是白名单而不是黑名单（2026-11-02 架构调整）
*
* 前五轮都在做"识别删除"——每轮补一种写法，复审再找出一种新的。
* 实测证明这条路没有终点：`awk system()`、`busybox rm`、
* `xargs sh -c` 等 10 个等价写法里我漏了 4 个，而且能无限造。
*
* 根因是 `parseCommand` 的最后一个 `return { destructive: false }` ——
* **"没找到删除证据"被当成了"证明不会删除"**。
*
* 现在把判定反过来：每个执行段必须落在下面的名单里，才允许放行；
* 其余一律要求审批。这样"未知写法"的默认归宿是**问**，不是**放**。
*
* ## 名单为什么这么短
*
* 越短越安全、误报越多。这里只收**明确不会产生文件系统副作用**的命令：
*
* - 纯输出：`echo` / `printf` / `print`
* - 纯读取：`cat` / `head` / `tail` / `less` / `more` / `wc` / `sort` / `uniq`
* - 纯检索：`grep` / `rg` / `egrep` / `ag` / `findstr`
* - 纯查询：`pwd` / `whoami` / `date` / `env` / `which` / `type`
* - 版本控制**只读子命令**另判（`git status` 等），不整条 `git` 放行
*
* ## 刻意不收的
*
* - `find`：支持 `-delete` / `-exec`
* - `awk` / `sed`：支持 `system()` / `e` 命令
* - `xargs`：会把管道内容当命令执行
* - `sh` / `bash` / `node` / `python`：执行包装器
* - `tee` / `touch` / `mkdir` / `cp` / `mv`：有写入副作用
*/
const PROVEN_READ_ONLY = /* @__PURE__ */ new Set([
	"echo",
	"printf",
	"print",
	"console.log",
	"ls",
	"dir",
	"pwd",
	"whoami",
	"date",
	"which",
	"cat",
	"type",
	"less",
	"more",
	"head",
	"tail",
	"wc",
	"sort",
	"uniq",
	"grep",
	"egrep",
	"rg",
	"ag",
	"findstr",
	"cp",
	"copy",
	"find",
	"get-content",
	"select-string",
	"write-output",
	"write-host",
	"man",
	"help",
	"true",
	"false",
	"test",
	"get-childitem",
	"get-item",
	"get-itemproperty",
	"get-location",
	"get-process",
	"get-service",
	"get-command",
	"get-help",
	"get-date",
	"get-content",
	"select-object",
	"where-object",
	"sort-object",
	"measure-object",
	"format-table",
	"format-list",
	"out-string",
	"resolve-path",
	"test-path",
	"join-path",
	"split-path"
]);
/**
* `python -m <module>` 里**整体**可以证明只读的模块。
*
* `python -m pytest` / `python -m json.tool` 是标准开发命令；
* 而 `python -m 任意模块` 可能调用 `shutil.rmtree`。
*
* ## `pip` / `venv` 不在这里（2026-11-02 定版验收 F7-S3）
*
* 上一版把 `pip` 和 `venv` 整体列为安全。但：
*
* - `python -m venv --clear /tmp/env` —— `--clear` **会删除**已存在目标目录的内容
*   （`python -m venv --help` 有原文说明）；
* - `python -m pip uninstall -y demo` —— 卸载并**删除**已安装文件。
*
* 一个模块里有查询能力，不能推出它的**所有**调用都不删文件。
* 所以这两个改为按子操作判断（见 `PROVEN_READ_ONLY_PY_SUBCOMMAND`）。
*/
const PROVEN_READ_ONLY_PY_MODULE = /* @__PURE__ */ new Set([
	"pytest",
	"unittest",
	"json.tool",
	"http.server",
	"compileall",
	"pydoc"
]);
/**
* 需要看**子操作与参数**才能判断的 python 模块。
*
* 每条都只放行明确的查询形态；其余（`uninstall`、`--clear`、
* 以及任何不认识的子命令/参数）都要求审批。
*/
const PROVEN_READ_ONLY_PY_SUBCOMMAND = {
	pip: (args) => {
		const sub = (args[0] ?? "").toLowerCase();
		if (!(/* @__PURE__ */ new Set([
			"list",
			"show",
			"freeze",
			"check",
			"--version",
			"-v",
			"search",
			"index",
			"inspect"
		])).has(sub)) return false;
		return !args.some((a) => /^(?:--target|-t|--prefix|--root|--clear)/i.test(a));
	},
	venv: (args) => !args.some((a) => /^--(?:clear|upgrade)\b/i.test(a))
};
/**
* `git` 的只读子命令。
*
* 为什么单独判而不整条放行 `git`：`git clean -fdx` 会**真的删文件**，
* 而 `git status` / `git log` / `git diff` 只读。按子命令区分才准确。
*/
const PROVEN_READ_ONLY_GIT = /* @__PURE__ */ new Set([
	"status",
	"log",
	"diff",
	"show",
	"branch",
	"remote",
	"rev-parse",
	"ls-files",
	"blame",
	"describe",
	"tag",
	"config",
	"add",
	"commit",
	"fetch",
	"pull",
	"push"
]);
/**
* 包管理器的**只读**子命令。
*
* `pnpm typecheck` / `pnpm test` 是开发时最高频的写法，不该弹卡；
* 而 `pnpm remove` / `pnpm uninstall` 会改文件系统（并删目录）。
*/
const PROVEN_READ_ONLY_PKG = /* @__PURE__ */ new Set([
	"typecheck",
	"test",
	"lint",
	"build",
	"start",
	"ls",
	"list",
	"outdated",
	"why",
	"view",
	"info"
]);
/**
* 判断一个命令 token 是否是"已证明只读"的主命令。
*
* @param token 命令名（已小写、已去引号）。
* @param next 紧邻的下一个 token（用于 `git` / `pnpm` 这类要看子命令的）。
* @returns 能证明只读返回 true。
*/
function isProvenReadOnlyCommand(token, next) {
	const base = (token.split(/[\\/]/).pop() ?? token).replace(/\.(exe|com|cmd|bat)$/, "");
	if (PROVEN_READ_ONLY.has(base)) return true;
	if (base === "git") {
		const sub = (next ?? "").toLowerCase();
		return sub !== "" && PROVEN_READ_ONLY_GIT.has(sub);
	}
	if (base === "pnpm" || base === "npm" || base === "yarn") {
		const sub = (next ?? "").toLowerCase();
		return sub !== "" && PROVEN_READ_ONLY_PKG.has(sub);
	}
	return false;
}
/**
* 判断一个执行段是否能**证明**不会删除任何东西。
*
* ## 为什么需要它（2026-11-02 架构调整）
*
* 五轮复审的共同根因：判定逻辑是"找删除证据"，找不到就放行。
* 于是任何我没预料到的写法都是漏洞，而写法是无穷的。
*
* 这个函数是**正向证明**：只有落在已知安全的形态里才返回 true。
* 调用方（`mentionsOnly`）在它返回 false 时要求审批 ——
* 未知的默认归宿从"放行"变成"问"。
*
* ## 判据
*
* 1. 展开命令替换（`$(…)` / 反引号）后，**每一段**的主命令都能证明只读；
* 2. 段内不含任何删除构造（动词、参数级标记、方法调用、`system(`）。
*
* @param segment 一个执行段（已按分隔符切开）。
* @param depth 递归深度（防循环）。
* @returns 能证明无害返回 true。
*/
function provenHarmless(segment, depth = 0) {
	if (depth > 4) return false;
	const text = segment.trim();
	if (text === "") return false;
	const containerOnly = isContainerDeleteOnly(text);
	if (/\b(?:system|popen|execSync|spawnSync)\s*\(/i.test(text)) return false;
	if (containerOnly) return true;
	if (containsDeleteCommand(text)) return false;
	if (!(() => {
		const tokens = tokenize(text);
		const first = tokens[0]?.toLowerCase();
		if (first === void 0) return false;
		return (first.split(/[\\/]/).pop() ?? first).replace(/\.(exe|com|cmd|bat)$/, "") === "git" && isProvenReadOnlyCommand("git", tokens[1]?.toLowerCase());
	})() && tokenize(text).some((t) => isDeleteArgumentMarker(t))) return false;
	if (hasCallStyleDelete(blankQuotedContent(text))) return false;
	if (/^delete\s+[\w$.]+\s*(\[[^\]]*\])?$/.test(text)) return true;
	if (/^rsync\b/i.test(text) && !/--(?:del|delete)/i.test(text)) return true;
	for (const substitution of commandSubstitutions(text)) if (!provenHarmless(substitution, depth + 1)) return false;
	const tokens = tokenize(text.replace(/\$\([^)]*\)/g, " ").replace(/`[^`]*`/g, " ").trim());
	const rawFirst = tokens[0]?.toLowerCase();
	const first = rawFirst === void 0 ? void 0 : (rawFirst.split("(")[0] ?? rawFirst).trim() || void 0;
	if (first === void 0) return commandSubstitutions(text).length > 0;
	if (/^(?:python[0-9.]*|py)$/.test(first) && tokens[1]?.toLowerCase() === "-m") {
		const module = (tokens[2] ?? "").toLowerCase();
		if (module === "") return false;
		if (PROVEN_READ_ONLY_PY_MODULE.has(module)) return true;
		const judge = PROVEN_READ_ONLY_PY_SUBCOMMAND[module];
		if (judge !== void 0) return judge(tokens.slice(3));
		return false;
	}
	if (first === "env") return tokens.length === 1;
	return isProvenReadOnlyCommand(first, tokens[1]?.toLowerCase());
}
/**
* 判断文本里**唯一**的删除嫌疑是否来自容器方法调用。
*
* ## 为什么需要（2026-11-02 架构调整）
*
* `Map.delete(k)` / `Set.delete(v)` / `cache.delete(key)` 是内存操作，
* 不碰文件系统。但 `containsDeleteCommand` 与 `hasCallStyleDelete` 看到
* `.delete(` 就命中 —— 第六轮复审专门测过这类误判。
*
* ## 判据
*
* 1. 文本含 `<容器名>.delete(` 形态；
* 2. 且**移除**这些调用后，不再有任何删除构造。
*
* 两条都满足才算"只是容器操作"。这样
* `const m = new Map(); m.delete('k'); fs.rmSync('x')` 仍会被否决
* —— 它的删除嫌疑不只来自容器。
*
* @param text 命令文本。
* @returns 只有容器删除返回 true。
*/
function isContainerDeleteOnly(text) {
	const pattern = /\b(?:map|set|weakmap|weakset|cache\w*|\w*map|\w*set|\w*cache|m|s|registry|store|pool|queue|list|dict|tree|index|memo)\s*\.\s*delete\s*\(/gi;
	if (!pattern.test(text)) return false;
	const without = text.replace(pattern, " ");
	if (containsDeleteCommand(without)) return false;
	if (hasCallStyleDelete(blankQuotedContent(without))) return false;
	if (tokenize(without).some((t) => isDeleteArgumentMarker(t))) return false;
	return true;
}
/**
* 判断一段**表达式**（不是命令）是否只读。
*
* ## 为什么与 `provenHarmless` 分开
*
* `node -p 'process.version'` 的内层是表达式 —— `process.version` 不是
* 命令名，所以 `provenHarmless` 的白名单判定不适用。
*
* 但表达式同样可能删东西：`node -p 'require("fs").rmSync("x")'`。
*
* 判据：不含任何删除构造、不含能执行字符串的调用（`eval` / `Function` /
* `system`）、不含命令替换。
*
* @param text 表达式文本。
* @returns 能证明只读返回 true。
*/
function isReadOnlyExpression(text) {
	const t = text.trim();
	if (t === "") return false;
	if (containsDeleteCommand(t)) return false;
	if (tokenize(t).some((token) => isDeleteArgumentMarker(token))) return false;
	if (hasCallStyleDelete(blankQuotedContent(t))) return false;
	if (/[`$]/.test(t)) return false;
	if (t.includes("(") || t.includes("::") || t.includes("=>")) return false;
	if (/\b(?:require|import|eval|Function|new)\b/.test(t)) return false;
	if (/[+\-*/%&|^~<>!=?]/.test(t)) return false;
	if (/^-?\d+(?:\.\d+)?$/.test(t)) return true;
	if (/^(?:true|false|null|undefined|NaN|Infinity|True|False|None)$/.test(t)) return true;
	if (t.startsWith("'") && t.endsWith("'") || t.startsWith("\"") && t.endsWith("\"")) return t.length >= 2;
	if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(t)) return true;
	return false;
}
/**
* 在参数位置表达删除的标记。
*/
const DELETE_ARGUMENT_MARKERS = [
	"-delete",
	"--delete",
	"--delete-after",
	"--delete-before",
	"--delete-during",
	"--delete-excluded",
	"--remove-source-files"
];
/**
* 判断一个 token 是否是"参数位置的删除标记"。
*
* 也覆盖方法调用形态：`.delete()`、`.unlink()`、`.rmdir()`、`.remove()`
* —— PowerShell 的 `(Get-Item x).Delete()` 与 Node 的 `fs.unlinkSync(x)`
* 都是这种形状，动词不在段首。
*
* @param token token（已小写、已去引号）。
* @returns 是删除标记返回 true。
*/
function isDeleteArgumentMarker(token) {
	const cleaned = token.toLowerCase().replace(/^['"]|['"]$/g, "");
	if (DELETE_ARGUMENT_MARKERS.includes(cleaned)) return true;
	return /\.(delete|deletemany|unlink|unlinksync|rmdir|rmdirsync|remove|removeitem)\s*\(/.test(cleaned);
}
/** 取出 token 的动词基本形式（`C:\…\rd.exe` → `rd`）。 */
function baseVerbOf(token) {
	const cleaned = token.toLowerCase().replace(/^['"]|['"]$/g, "");
	return (cleaned.split(/[\\/]/).pop() ?? cleaned).replace(/\.(exe|com|cmd|bat)$/, "");
}
/**
* 判断第 `index` 个 token 是否处在「命令位」（会被 shell 当命令执行）。
*
* 命令位 = 段首，或紧跟在分隔符、包装器之后：
*   - 索引 0；
*   - 前一个 token 以 `|`、`;`、`&` 结尾（分隔符被并进上一个 token 时）；
*   - 前一个 token 是 `cmd /c`、`powershell -Command`、`Invoke-Expression` 之类。
*
* 为什么要区分：`C:\Windows\System32\rd.exe /s /q X` 是调用删除，而
* `cp /tmp/rm /backup/` 只是复制一个恰好叫 rm 的文件。只看 basename
* 会把后者判成「删除 /backup/」，给模型一条错误信息。
*
* @param tokens 整条命令的 token 列表。
* @param index 待判断的下标。
* @returns 处在命令位时为 `true`。
*/
function isCommandPosition(tokens, index) {
	if (index === 0) return true;
	const previousStripped = (tokens[index - 1] ?? "").toLowerCase().replace(/^['"]|['"]$/g, "");
	if (/[|;&]$/.test(previousStripped)) return true;
	if ((/* @__PURE__ */ new Set([
		"cmd",
		"sh",
		"bash",
		"zsh",
		"pwsh",
		"powershell",
		"eval",
		"exec",
		"invoke-expression",
		"iex",
		"call",
		"xargs",
		"sudo",
		"doas",
		"env",
		"time",
		"nohup"
	])).has(previousStripped)) return true;
	if ((/* @__PURE__ */ new Set([
		"/c",
		"-c",
		"-command",
		"/command",
		"-encodedcommand"
	])).has(previousStripped)) return true;
	return false;
}
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
* 按 shell 规则分词：引号内的空白不切分，引号本身被去掉。
*
* 为什么不能用 `split(/\s+/)`：`rm -rf "/tmp/real target"` 的目标含空格，
* 裸切分会把它拆成 `"/tmp/real` 和 `target"`，抽出来的路径是错的 —— 而分类器
* 基于错误路径判断，等于保护规则出错。
*/
function tokenize(command) {
	const tokens = [];
	let current = "";
	let quote = null;
	let started = false;
	for (const ch of command) {
		if (quote !== null) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "\"" || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += ch;
		started = true;
	}
	if (started) tokens.push(current);
	return tokens;
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
* 从"没有删除动词"的构造里抽取目标路径。
*
* @param command 原始命令文本。
* @param label 命中的模式标签，决定抽取策略。
* @returns 目标路径；抽不出或不可解析时返回 `null`（交给人类判断）。
*/
function targetFromPattern(command, label) {
	switch (label) {
		case "find -delete": {
			const after = /\bfind\b\s+(.+)$/i.exec(command);
			if (after === null) return null;
			for (const token of after[1].split(/\s+/)) {
				if (token === "" || isOptionToken(token)) continue;
				if (/\s-delete\b/i.test(token)) continue;
				const cleaned = token.replace(/^['"]|['"]$/g, "");
				if (cleaned === "" || cleaned === "-delete") return null;
				return isUnresolvableTarget(cleaned) ? null : cleaned;
			}
			return null;
		}
		case "rsync --delete": {
			const tokens = command.split(/\s+/).filter((t) => t !== "" && !isOptionToken(t));
			const dst = tokens[tokens.length - 1];
			if (dst === void 0 || dst.toLowerCase() === "rsync") return null;
			const cleaned = dst.replace(/^['"]|['"]$/g, "");
			return isUnresolvableTarget(cleaned) ? null : cleaned;
		}
		default: return null;
	}
}
/**
* 判断一段被包装执行的脚本体是否**明确没有任何删除可能**。
*
* 用于 `node -e 'console.log(1)'` 这类高频无害写法：让它们直接放行，而不是
* 每一条都弹审批卡。审批疲劳会让人无脑点同意，那比少问一次更危险。
*
* 判据（全部满足才算无害）：
*   1. 没有任何删除动词出现在命令位（含「把删除当参数转发」的工具）；
*   2. 没有不透明执行（Base64、`-EncodedCommand`）；
*   3. 没有删除模式（`find -delete`、`rsync --delete`、`.unlink(` 等）；
*   4. 没有任何命令替换（替换里可能有看不见的东西）。
*
* 任何一条不满足就不算「明确无害」，交给上层按「看不清」处理。
*
* @param body 脚本体文本。
* @returns 明确无害时为 `true`。
*/
function isPlainlyHarmless(body) {
	if (body.trim() === "") return true;
	const bodyCode = blankQuotedContent(stripComments(body));
	if (OPAQUE_EXECUTION.some((pattern) => pattern.test(body))) return false;
	if (DELETE_PATTERNS.some((pattern) => pattern.pattern.test(bodyCode))) return false;
	if (containsDeleteCommand(bodyCode)) return false;
	if (hasCallStyleDelete(bodyCode)) return false;
	if (commandSubstitutions(body).length > 0) return false;
	return true;
}
/**
* 函数式删除调用。
*
* 覆盖语言标准库里"名字里就写着删除"的方法：`rmSync`、`rmtree`、`unlinkSync`、
* `os.remove`、`File.delete`、`fs.unlink`…
*
* ## 为什么分成两个正则
*
* `.delete(` 必须**大小写敏感**：`Map.delete("k")`、`Set.delete(1)` 是容器操作，
* 不碰文件系统。如果把 `.delete(` 放进带 `/i` 的那条里，大写 `.Delete(` 的模式
* 会反过来匹配小写 —— 误伤面就被重新打开（第六轮审查实测确认）。
*
* 所以：无歧义的名字走 `/i`（`rmSync`、`rmtree`、`os.remove`…），
* 有歧义的名字走大小写敏感（`File.delete`、`.Delete(`）。
*/
const CALL_STYLE_DELETE_ANY_CASE = new RegExp([
	String.raw`(?:^|[^\w])(?:rm|rmdir|removedir|unlink)(?:sync|_sync)?\s*\(`,
	String.raw`(?:rmtree|shutil\s*\.\s*rmtree)\s*\(`,
	String.raw`(?:os|fs|shutil)\s*\.\s*(?:remove|unlink|rmdir)\s*\(`
].join("|"), "i");
/**
* 有歧义的 `.delete(` —— 只有明确是文件 API 的写法才算删除。
*
* 覆盖：
*   - `File.delete(`（Ruby）
*   - `.Delete(`（大写 D，C# / PowerShell 风格）
*   - `[System.IO.File]::Delete(`（.NET 静态调用，双冒号）
*
* 排除容器操作：`Map.delete(`、`Set.delete(`、`cache.delete(`。
*/
const CALL_STYLE_DELETE_CASE_SENSITIVE = /(?:System\s*\.\s*IO\s*\.\s*)?(?:File|Directory|DirectoryInfo|FileInfo)\]?\s*(?:\.|::)\s*[Dd]elete\s*\(|\.Delete\s*\(/;
/**
* 判断脚本体里是否有函数式删除调用。
*
* @param body 脚本体。
* @returns 含删除调用时为 `true`。
*/
function hasCallStyleDelete(body) {
	return CALL_STYLE_DELETE_ANY_CASE.test(body) || CALL_STYLE_DELETE_CASE_SENSITIVE.test(body);
}
/**
* 解析命令文本。
*
* @param command 命令原文（可以是 shell 命令，也可以是 `run_code` 的代码体）。
*/
function parseCommand(command) {
	const raw = command ?? "";
	const text = normalizeObfuscation(stripComments(raw));
	const lower = text.toLowerCase();
	const tokens = tokenize(text);
	if (mentionsOnly(raw)) return { destructive: false };
	if (isPureAssignment(text)) return { destructive: false };
	if (OPAQUE_EXECUTION.some((pattern) => pattern.test(raw))) return {
		destructive: true,
		kind: "delete",
		recursive: RECURSIVE_FLAGS.some((flag) => lower.includes(flag)),
		target: null
	};
	const wrapped = unwrapExecutedCommand(text);
	if (wrapped !== null) {
		if (isReadOnlyExpression(wrapped)) return { destructive: false };
		const inner = parseCommand(wrapped);
		if (inner.destructive) return inner;
		if (isPlainlyHarmless(wrapped)) return { destructive: false };
		return {
			destructive: true,
			kind: "delete",
			recursive: false,
			target: null
		};
	}
	const commentFree = stripComments(raw);
	const quotedBlanked = blankQuotedContent(commentFree);
	const containerOnly = isContainerDeleteOnly(commentFree);
	const containerPattern = /\b(?:weakmap|weakset|map|set|cache\w*|\w+map|\w+set|\w+cache|m|s|registry|store|pool|queue|list|dict|tree|index|memo)\s*\.\s*delete\s*\(/gi;
	const matchSource = containerOnly ? commentFree.replace(containerPattern, " ") : commentFree;
	const matchBlanked = containerOnly ? quotedBlanked.replace(containerPattern, " ") : quotedBlanked;
	const outsideQuotesHit = DELETE_PATTERNS.find((entry) => entry.pattern.test(matchBlanked));
	const anyHit = DELETE_PATTERNS.find((entry) => entry.pattern.test(matchSource));
	/**
	* 是否在用包装器执行引号里的内容。
	*
	* `sh -c "rm x"`、`node -e "unlink(...)"`、`powershell -Command "..."` ——
	* 这些的删除字样在引号内，但**会被真的执行**。而
	* `const note = "file.Delete()"` 的同样字样只是普通字符串。
	*
	* 只看命令的第一个 token，避免把很长的脚本正文当成匹配对象。
	*/
	const runsQuotedCode = (() => {
		const segTokens = tokenize(splitOutsideQuotes(commentFree)[0] ?? "");
		for (const token of segTokens.slice(0, 4)) {
			const cleaned = token.toLowerCase().replace(/^['"]|['"]$/g, "");
			const base = (cleaned.split(/[\\/]/).pop() ?? cleaned).replace(/\.(exe|com|cmd|bat)$/, "");
			if (RUNS_INLINE_CODE.has(base)) return true;
		}
		return false;
	})();
	const patternHit = outsideQuotesHit ?? (runsQuotedCode ? anyHit : void 0);
	if (patternHit !== void 0) return {
		destructive: true,
		kind: "delete",
		recursive: /-delete\b/i.test(commentFree) || /--del(?:ete)?\b/i.test(commentFree) || /recursive\s*:\s*true/i.test(lower) || RECURSIVE_FLAGS.some((flag) => tokens.includes(flag)),
		target: targetFromPattern(commentFree, patternHit.label)
	};
	let verbIndex = -1;
	let matchedVerb = "";
	const EXEC_SIGNALS = /* @__PURE__ */ new Set([
		"-exec",
		"-execdir",
		"-ok",
		"-okdir",
		"xargs",
		"parallel",
		"eval",
		"exec"
	]);
	for (let i = 1; i < tokens.length; i += 1) {
		const previous = (tokens[i - 1] ?? "").toLowerCase().replace(/^['"]|['"]$/g, "");
		if (!EXEC_SIGNALS.has(previous)) continue;
		const token = (tokens[i] ?? "").toLowerCase().replace(/^['"]|['"]$/g, "");
		if (isDeleteVerb(token) && (verbIndex === -1 || i < verbIndex)) {
			verbIndex = i;
			matchedVerb = baseVerbOf(token);
		}
	}
	for (let i = 0; i < tokens.length; i += 1) {
		if ((tokens[i] ?? "") !== "{") continue;
		const token = (tokens[i + 1] ?? "").toLowerCase().replace(/^['"]|['"]$/g, "");
		if (isDeleteVerb(token) && (verbIndex === -1 || i + 1 < verbIndex)) {
			verbIndex = i + 1;
			matchedVerb = baseVerbOf(token);
		}
	}
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i].toLowerCase().replace(/^['"]|['"]$/g, "");
		if (isCommandPosition(tokens, i) && isDeleteVerb(token)) {
			verbIndex = i;
			matchedVerb = baseVerbOf(token);
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
	if (verbIndex === -1) {
		if (containsDeleteCommand(text)) return {
			destructive: true,
			kind: "delete",
			recursive: false,
			target: null
		};
		if (!isContainerDeleteOnly(text) && hasCallStyleDelete(blankQuotedContent(text))) return {
			destructive: true,
			kind: "delete",
			recursive: false,
			target: null
		};
		for (const substitution of commandSubstitutions(text)) {
			if (containsDeleteCommand(substitution)) return {
				destructive: true,
				kind: "delete",
				recursive: false,
				target: null
			};
			if (tokenize(substitution).some((t) => isDeleteArgumentMarker(t))) return {
				destructive: true,
				kind: "delete",
				recursive: false,
				target: null
			};
			if (hasCallStyleDelete(blankQuotedContent(substitution))) return {
				destructive: true,
				kind: "delete",
				recursive: false,
				target: null
			};
		}
		for (const segment of splitOutsideQuotes(text)) {
			const inner = unwrapExecutedCommand(segment);
			if (inner !== null && provenHarmless(inner)) continue;
			if (inner !== null && isReadOnlyExpression(inner)) continue;
			if (provenHarmless(segment)) continue;
			return {
				destructive: true,
				kind: "delete",
				recursive: RECURSIVE_FLAGS.some((flag) => tokens.includes(flag)),
				target: targetFromPattern(text, "unverifiable command") ?? null
			};
		}
		return { destructive: false };
	}
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
/**
* 全部可配置项的说明。
*
* 顺序即 `/safe-delete config` 的展示顺序。
*/
const SETTING_GUIDES = [
	{
		key: "deleteDestination",
		unit: "choice",
		choices: ["safe-zone", "recycle-bin"],
		summary: "删除的文件去安全区还是直接进系统回收站。安全区会统计文件数与总大小（大目录删除慢一些），换来「删太多先问一次」和插件内按条目恢复；回收站跳过统计，速度与文件数无关，但超大删除不再额外确认、取回要去系统回收站。",
		effect: "改成 recycle-bin：删除更快，但不再统计大小、不触发按大小/条数的确认，恢复要用系统回收站。改成 safe-zone：回到默认行为，保留插件内恢复与两道确认阈值。",
		range: "safe-zone 或 recycle-bin；默认 safe-zone",
		defaultValue: "safe-zone"
	},
	{
		key: "retentionDays",
		unit: "days",
		summary: "删掉的东西在安全区里放多少天。到期后移入系统回收站，不是永久删除。",
		effect: "调大：安全区停留更久，占用磁盘更久。调小：更早交给回收站。",
		range: "1 到 365 天；默认 1 天",
		defaultValue: 1
	},
	{
		key: "confirmFileCount",
		unit: "count",
		summary: "一次删除的条目数超过多少时，额外要你确认一次。",
		effect: "调大：大批量删除更少被打断。调小：更容易被要求确认。0 表示不按条目数确认。",
		range: "0 或正整数；默认 5000",
		defaultValue: 5e3
	},
	{
		key: "confirmBytes",
		unit: "bytes",
		summary: "一次删除的总大小超过多少时，额外要你确认一次。",
		effect: "调大：删大文件更少被打断。调小：更容易被要求确认。0 表示不按大小确认。",
		range: "0 或至少 1 MB；默认 2 GB",
		defaultValue: 2147483648
	},
	{
		key: "autoPrune",
		unit: "boolean",
		summary: "是否自动清理。关掉后过期条目不会被自动移走，只能手动清理。",
		effect: "关掉：安全区会持续变大，需要自己执行 /safe-delete clean。",
		range: "on / off；默认 on",
		defaultValue: true
	},
	{
		key: "blockShellDeletes",
		unit: "boolean",
		summary: "是否拦截裸 shell 的删除命令（rm -rf、Remove-Item -Recurse 等）。",
		effect: "关掉：模型可直接用 shell 删文件，且不可恢复。",
		range: "on / off；默认 on",
		defaultValue: true
	},
	{
		key: "blockProtectedWrites",
		unit: "boolean",
		summary: "是否拦截对启动关键文件的写入（profile 清单、补丁层、lockfile、node_modules）。",
		effect: "关掉：这些文件可被改写，写坏会导致 DSH 起不来。",
		range: "on / off；默认 on",
		defaultValue: true
	}
];
/** 按 key 查说明。 */
function guideOf(key) {
	return SETTING_GUIDES.find((guide) => guide.key === key);
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
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${Number(value.toFixed(2))} ${units[index]}`;
}
/** 人类可读的时长。 */
function humanDuration(ms) {
	if (ms < 6e4) return `${Math.round(ms / 1e3)} 秒`;
	const minutes = ms / 6e4;
	if (minutes < 60) return `${Number(minutes.toFixed(1))} 分钟`;
	const hours = minutes / 60;
	if (hours < 24) return `${Number(hours.toFixed(2))} 小时`;
	return `${Number((hours / 24).toFixed(2))} 天`;
}
/**
* 把配置值格式化成带单位的可读文本。
*/
function formatSetting(guide, value) {
	if (guide.unit === "boolean") return value === true ? "on" : "off";
	if (guide.unit === "choice") return typeof value === "string" ? value : "(未设置)";
	if (typeof value !== "number" || !Number.isFinite(value)) return "(未设置)";
	switch (guide.unit) {
		case "bytes": return humanBytes(value);
		case "milliseconds": return humanDuration(value);
		case "percent": return `${value}%`;
		case "days": return `${value} 天`;
		case "count": return value === 0 ? "0（不按条目数确认）" : `${value} 条`;
		default: return String(value);
	}
}
/**
* 解析用户输入的值。
*
* 支持带单位的写法（`20GB`、`500MB`、`2h`、`30min`），也支持纯数字
* （按该字段的单位解释）。范围检查与说明里的 `range` 保持一致。
*/
function parseSetting(guide, raw) {
	const text = raw.trim();
	if (text === "") return {
		ok: false,
		error: `需要一个值。${guide.summary}（范围：${guide.range}）`
	};
	if (guide.unit === "boolean") {
		const lowered = text.toLowerCase();
		if ([
			"on",
			"true",
			"1",
			"yes",
			"开"
		].includes(lowered)) return {
			ok: true,
			value: true
		};
		if ([
			"off",
			"false",
			"0",
			"no",
			"关"
		].includes(lowered)) return {
			ok: true,
			value: false
		};
		return {
			ok: false,
			error: `只接受 on 或 off。${guide.summary}`
		};
	}
	if (guide.unit === "choice") {
		const lowered = text.toLowerCase();
		const allowed = guide.choices ?? [];
		if (allowed.includes(lowered)) return {
			ok: true,
			value: lowered
		};
		return {
			ok: false,
			error: `只接受 ${allowed.join(" 或 ")}。${guide.summary}`
		};
	}
	const match = /^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z%]*)$/.exec(text);
	if (match === null) return {
		ok: false,
		error: `无法解析 "${text}"。${guide.summary}（范围：${guide.range}）`
	};
	const amount = Number(match[1]);
	const suffix = (match[2] ?? "").toLowerCase();
	if (!Number.isFinite(amount) || amount < 0) return {
		ok: false,
		error: `值必须是非负数。（范围：${guide.range}）`
	};
	if (guide.unit === "bytes") {
		const factor = suffix === "" || suffix === "b" ? 1 : suffix === "kb" ? 1024 : suffix === "mb" ? 1024 ** 2 : suffix === "gb" ? 1024 ** 3 : suffix === "tb" ? 1024 ** 4 : void 0;
		if (factor === void 0) return {
			ok: false,
			error: `体积单位只接受 KB / MB / GB / TB（例如 20GB）。范围：${guide.range}`
		};
		const bytes = Math.round(amount * factor);
		if (bytes > 0 && bytes < 1048576) return {
			ok: false,
			error: `太小了，至少 1MB。范围：${guide.range}`
		};
		return {
			ok: true,
			value: bytes
		};
	}
	if (guide.unit === "milliseconds") {
		const factor = suffix === "" || suffix === "ms" ? 1 : suffix === "s" ? 1e3 : suffix === "min" ? 6e4 : suffix === "h" ? 36e5 : suffix === "d" ? 864e5 : void 0;
		if (factor === void 0) return {
			ok: false,
			error: `时长单位只接受 ms / s / min / h / d（例如 2h）。范围：${guide.range}`
		};
		const ms = Math.round(amount * factor);
		if (ms < 6e4) return {
			ok: false,
			error: `至少 1 分钟。范围：${guide.range}`
		};
		return {
			ok: true,
			value: ms
		};
	}
	if (guide.unit === "days") {
		const days = Math.round(amount);
		if (days < 1) return {
			ok: false,
			error: `至少 1 天。范围：${guide.range}`
		};
		if (days > 365) return {
			ok: false,
			error: `最多 365 天。范围：${guide.range}`
		};
		return {
			ok: true,
			value: days
		};
	}
	if (guide.unit === "percent") {
		if (amount < 0 || amount > 100) return {
			ok: false,
			error: `百分比必须在 0 到 100 之间。${guide.summary}`
		};
		return {
			ok: true,
			value: Math.round(amount)
		};
	}
	const count = Math.round(amount);
	if (count < 0) return {
		ok: false,
		error: `不能是负数。范围：${guide.range}`
	};
	return {
		ok: true,
		value: count
	};
}
//#endregion
//#region src/commands.ts
/**
* 斜杠命令的处理逻辑。
*
* 四个命令：
*   `/safe-delete <路径>`          把文件或目录移入安全区
*   `/safe-delete clean`           立即清理安全区
*   `/safe-delete config`          列出所有配置项与当前值、含义、范围
*   `/safe-delete config <key> <值>` 改一项
*
* 这一层是**纯逻辑**：它接收已经解析好的输入、读写回调，返回要显示给用户的文本。
* 把宿主 API 调用隔离在外面，是为了让「说明文案是否完整」「解析是否正确」可被单测。
*
* @module dsh-safe-delete/commands
*/
/** 帮助文本。 */
const HELP = `安全删除 —— 把删除变成可撤销的操作

用法：
  /safe-delete <路径>              把文件或目录移入安全区（默认 1 天内可取回）
  /safe-delete <路径> --preview    只看会发生什么，不真的移动
  /safe-delete list                列出安全区里的条目
  /safe-delete restore <id>        把某个条目取回原位
  /safe-delete clean               立即清空安全区（不看保留期）
  /safe-delete clean --dry-run     只报告会清理什么，不动手
  /safe-delete config              查看所有可配置项、当前值、含义与范围
  /safe-delete config <项> <值>     修改一项配置（例如 config confirmBytes 512MB）
  /safe-delete status              安全区概况

提示：这里的删除**不是永久删除** —— 东西先进安全区（默认 1 天），到期后移入
系统回收站，你仍能在那里取回，直到自己清空回收站。`;
/**
* 渲染配置清单。
*
* 每一项都给出：当前值、它管什么、调大调小的影响、合法范围。
* 这是「不要让用户在配置时产生疑问」的具体落实。
*/
function renderConfigList(values, guides = SETTING_GUIDES) {
	const lines = ["可配置项（改法：/safe-delete config <项> <值>）", ""];
	for (const guide of guides) {
		const raw = values[guide.key];
		const value = raw === void 0 ? guide.defaultValue : raw;
		lines.push(`${guide.key}  =  ${formatSetting(guide, value)}`);
		lines.push(`  作用：${guide.summary}`);
		lines.push(`  影响：${guide.effect}`);
		lines.push(`  范围：${guide.range}`);
		lines.push("");
	}
	lines.push("示例：");
	lines.push("  /safe-delete config confirmBytes 512MB  超过 512 MB 的删除要确认");
	lines.push("  /safe-delete config confirmFileCount 100 超过 100 条的删除要确认");
	return lines.join("\n");
}
/** 渲染单个配置项的详情（用于 `config <key>` 无值时）。 */
function renderConfigDetail(guide, values) {
	const raw = values[guide.key];
	const value = raw === void 0 ? guide.defaultValue : raw;
	return [
		`${guide.key} = ${formatSetting(guide, value)}（当前）`,
		"",
		`作用：${guide.summary}`,
		`影响：${guide.effect}`,
		`范围：${guide.range}`,
		`默认：${formatSetting(guide, guide.defaultValue)}`,
		"",
		`改法：/safe-delete config ${guide.key} <值>`
	].join("\n");
}
/** 已知的子命令。 */
const SUBCOMMANDS = /* @__PURE__ */ new Set([
	"list",
	"restore",
	"clean",
	"config",
	"status",
	"help",
	"--help",
	"-h"
]);
/**
* 从原文里删掉**恰好独立成段**的某个 flag，保留其余字节一一对应。
*
* ## 为什么不能用"分词 → 过滤 → join"（2026-11-01 定版复核第 4 项）
*
* 那条路径会把连续空格压成一个：`C:\My  Files\x` 变成 `C:\My Files\x`。
* 若两个目录都存在，被操作的是用户**没有指定**的那个 —— 这是"路径保真"
* 问题，不是格式化问题。
*
* ## 做法
*
* 扫描原文，记录引号外的空白分段边界。只有当某一段**完全等于** flag 时，
* 才把它连同**一侧**的空白删掉（选它前面那段，避免影响后续偏移）。
* 其余所有字节（含重复空格、制表符、引号）原样保留。
*
* @param text 原始参数串。
* @param flag 要移除的 flag（如 `--preview`）。
* @returns 处理后的文本与是否移除过。
*/
function stripStandaloneFlag(text, flag) {
	/** 每一段的 [start, end) —— 只记录引号外的空白切分。 */
	const spans = [];
	let quote = null;
	let segStart = -1;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quote !== null) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === "\"") {
			if (segStart === -1) segStart = i;
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (segStart !== -1) {
				spans.push({
					start: segStart,
					end: i
				});
				segStart = -1;
			}
			continue;
		}
		if (segStart === -1) segStart = i;
	}
	if (segStart !== -1) spans.push({
		start: segStart,
		end: text.length
	});
	let out = text;
	let removed = false;
	for (let k = spans.length - 1; k >= 0; k -= 1) {
		const span = spans[k];
		if (out.slice(span.start, span.end) !== flag) continue;
		let cutFrom = span.start;
		while (cutFrom > 0 && /\s/.test(out[cutFrom - 1])) cutFrom -= 1;
		let cutTo = span.end;
		if (cutFrom === span.start) while (cutTo < out.length && /\s/.test(out[cutTo])) cutTo += 1;
		out = out.slice(0, cutFrom) + out.slice(cutTo);
		removed = true;
	}
	return {
		text: out,
		removed
	};
}
/**
* 判断输入是子命令还是路径。
*
* 为什么不能简单取第一个词：路径本身可以带空格（`C:\My Files\x`），
* 而第一个词 `C:\My` 不是已知子命令。只有**恰好命中**已知子命令时才按子命令解释，
* 否则整串都是路径。
*/
function splitCommand(rawInput) {
	const trimmed = rawInput.trim();
	if (trimmed === "") return {
		verb: "",
		rest: ""
	};
	const space = trimmed.search(/\s/);
	const first = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
	if (!SUBCOMMANDS.has(first)) return {
		verb: "",
		rest: trimmed
	};
	return {
		verb: first,
		rest: space === -1 ? "" : trimmed.slice(space + 1).trim()
	};
}
/**
* 执行一个命令。
*
* @param rawInput 斜杠后的全部输入。
* @param deps 依赖。
*/
async function runCommand(rawInput, deps) {
	const { verb, rest } = splitCommand(rawInput);
	if (verb === "" && rest === "") return {
		kind: "success",
		text: HELP
	};
	if (verb === "help" || verb === "--help" || verb === "-h") return {
		kind: "success",
		text: HELP
	};
	if (verb === "list") {
		const entries = await deps.listSafeZone();
		if (entries.length === 0) return {
			kind: "success",
			text: "安全区是空的。"
		};
		const lines = [`安全区里有 ${entries.length} 项：`];
		for (const entry of entries.slice(0, 30)) {
			const expires = new Date(entry.expiresAt).toISOString().slice(0, 10);
			lines.push(`  ${entry.id}  ${expires} 到期  ${entry.originalPath}`);
		}
		if (entries.length > 30) lines.push(`  … 另有 ${entries.length - 30} 项`);
		lines.push("", "取回：/safe-delete restore <id>");
		return {
			kind: "success",
			text: lines.join("\n")
		};
	}
	if (verb === "status") return {
		kind: "success",
		text: await deps.status()
	};
	if (verb === "restore") {
		const id = rest.trim();
		if (id === "") return {
			kind: "error",
			text: "要取回哪一项？用法：/safe-delete restore <id>\n先用 /safe-delete list 查看 id。"
		};
		const restored = await deps.restore(id);
		if (!restored.ok) return {
			kind: "error",
			text: restored.error
		};
		return {
			kind: "success",
			text: `已取回：${restored.restoredTo}`
		};
	}
	if (verb === "clean") {
		const dryRun = rest.includes("--dry-run");
		const result = await deps.clean(dryRun);
		const failures = result.failures ?? [];
		const scheduled = result.scheduled;
		if (scheduled !== void 0) {
			if (scheduled.started) return {
				kind: "success",
				text: "已在后台开始清理。\n清理在独立进程里跑，所以本命令立即返回；用 `/safe-delete status` 查看进度与结果。"
			};
			const reason = scheduled.reason ?? "unknown";
			if (result.removed.length === 0 && failures.length === 0) return {
				kind: "error",
				text: `清理**没有启动**：${reason}\n这不等于"没有需要清理的条目" —— 后台任务未运行，安全区未被改动。
稍后重试，或用 \`/safe-delete status\` 查看当前状态。`
			};
		}
		if (result.removed.length === 0 && failures.length === 0) return {
			kind: "success",
			text: "没有需要清理的条目（都还在保留期内）。"
		};
		const lines = [];
		if (result.removed.length > 0) {
			const head = dryRun ? `将移入回收站 ${result.removed.length} 项（dry run，什么都没动）：` : `已移入回收站 ${result.removed.length} 项：`;
			lines.push(head, ...result.removed.map((item) => `  ${item}`));
		}
		if (failures.length > 0) {
			lines.push("", `⚠ ${failures.length} 项未能移入回收站，已**留在安全区**（不会永久删除）：`);
			lines.push(...failures.map((item) => `  ${item}`));
			return {
				kind: "error",
				text: lines.join("\n")
			};
		}
		if (!dryRun) lines.push("", "回收站里在你清空之前都能还原。");
		return {
			kind: "success",
			text: lines.join("\n")
		};
	}
	if (verb === "config") {
		const values = await deps.readConfig();
		if (rest === "") return {
			kind: "success",
			text: renderConfigList(values)
		};
		const parts = rest.split(/\s+/);
		const key = parts[0] ?? "";
		const guide = guideOf(key);
		if (guide === void 0) return {
			kind: "error",
			text: `没有 "${key}" 这一项。可配置项：${SETTING_GUIDES.map((item) => item.key).join("、")}\n\n查看全部说明：/safe-delete config`
		};
		if (parts.length < 2) return {
			kind: "success",
			text: renderConfigDetail(guide, values)
		};
		const parsed = parseSetting(guide, parts.slice(1).join(" "));
		if (!parsed.ok) return {
			kind: "error",
			text: parsed.error
		};
		const written = await deps.writeConfig(guide.key, parsed.value);
		if (!written.ok) return {
			kind: "error",
			text: `保存失败：${written.error ?? "未知原因"}（配置未改动）`
		};
		return {
			kind: "success",
			text: `已把 ${guide.key} 设为 ${formatSetting(guide, parsed.value)}。\n重启 DSH 后生效。\n\n作用：${guide.summary}`
		};
	}
	const stripped = stripStandaloneFlag(rest, "--preview");
	const preview = stripped.removed;
	const pathText = stripped.text.trim();
	if (pathText === "") return {
		kind: "error",
		text: `要删除什么？用法：/safe-delete <路径>\n例如：/safe-delete C:\\Work\\proj\\build`
	};
	const result = await deps.delete(pathText, { preview });
	return {
		kind: result.ok ? "success" : "error",
		text: result.text
	};
}
/**
* 本插件的配置。
*
* 每一项都带默认值，且默认值同时是「不配置时的行为」——
* 加了 schema 不代表行为变了。
*/
const Config = z.object({
	/** 安全区状态目录。 */
	stateDir: z.string().default(""),
	/**
	* 保留天数：条目在安全区里停留多少天，到期移入系统回收站。
	*
	* ## 可调，默认 1 天
	*
	* 界面上可改（`.volatile()`），只接受正整数天。调到更久意味着更长的取回窗口，
	* 代价是安全区占盘更久 —— 到期后条目本来就会交给系统回收站，那里同样能取回。
	*
	* 下限 1 天：设为 0 等于「删完立刻进回收站」，安全区就没有缓冲意义了。
	* 上限 365 天：挡住误填（例如把毫秒数当天数写进去）。
	*/
	retentionDays: z.number().default(1).volatile(),
	/**
	* 是否按保留期自动清理。
	*
	* 关掉后安全区只增不减，需要手动清理 —— 极端情况下想要"永不自动动手"时用。
	* 默认开。
	*/
	autoPrune: z.boolean().default(true).volatile(),
	/**
	* 删除去向。
	*
	* ## 两种模式的取舍（2026-11-04）
	*
	* | | `safe-zone`（默认） | `recycle-bin` |
	* |---|---|---|
	* | 目录全树统计 | 做 | **不做** |
	* | 卡片显示 | 共 N 个文件 / X MB | 顶层 N 个条目 |
	* | `confirmFileCount` / `confirmBytes` | 生效 | **不生效** |
	* | 大量删除速度 | 与文件数成正比 | 与文件数无关 |
	* | 恢复方式 | 插件内按条目恢复 | 系统回收站，保留原路径 |
	*
	* 回收站模式跳过统计是为了速度：统计要递归遍历整棵树，且发生在审批卡片
	* 出现**之前**。代价是「删太多先问一次」那两道阈值失去数据来源。
	*
	* 未知值一律按 `safe-zone` 处理（见 `normalizeDestination`）—— 那是
	* 「删除可反悔」的那条路。
	*/
	deleteDestination: z.union([z.const("safe-zone"), z.const("recycle-bin")]).default("safe-zone").volatile(),
	/** 单次删除的条目数阈值；超过就额外确认一次。0 表示不启用。 */
	confirmFileCount: z.number().default(5e3).volatile(),
	/** 单次删除的字节数阈值；超过就额外确认一次。0 表示不启用。 */
	confirmBytes: z.number().default(2147483648).volatile(),
	/** 拦截裸 shell 删除。 */
	blockShellDeletes: z.boolean().default(true),
	/** 拦截对启动关键路径的写入。 */
	blockProtectedWrites: z.boolean().default(true),
	/** 跨卷时是否允许复制式移入。 */
	crossVolumeCopy: z.boolean().default(false),
	/**
	* 「立即清理」的触发戳（毫秒时间戳；0 表示从未请求）。
	*
	* ## 为什么用配置项当按钮
	*
	* 浏览器里的按钮要触发宿主动作，必须有一条「界面 → 宿主」的通道。实测下来
	* 现成的通道都用不了：
	*
	*   - `tools` 根本没有 remote 端点 —— 浏览器调不到插件工具；
	*   - `commands/execute`、`terminal/*`、`dynamicCordisRunner/*` 都需要 agentId，
	*     而配置页不属于任何会话；
	*   - 自建 remote 需要 typert 生成器的整套分析管线（tsconfig.host/client +
	*     双面模型 + 产物发布），对一个按钮而言成本过高。
	*
	* 但宿主自带一条通道：**配置写入会触发 HMR 重载插件**，`apply` 因此重跑。
	* 于是把这个字段当信号灯：
	*
	*   1. 用户点按钮 → 客户端写入当前时间戳；
	*   2. HMR 检测到配置变化 → 卸载并重新 apply 本插件；
	*   3. apply 发现时间戳比上次执行的新 → 跑一次清理（过期条目移入回收站）。
	*
	* 代价：点按钮会让插件重载一次（几十毫秒），期间工具短暂不可用。对手动清理
	* 这种低频操作可以接受。
	*/
	cleanRequestedAt: z.number().default(0).volatile()
});
/**
* 把 schema 解析出来的配置转成纯值。
*
* `.volatile()` 字段是引用（`.get()`），必须先解包才能当普通配置读；
* 否则 `config.maxBytes > 0` 这类比较会恒为 `false` —— 静默失效。
*/
function unwrapConfig(config) {
	const isReference = (value) => value !== null && typeof value === "object" && typeof value.get === "function";
	const result = {};
	for (const [key, value] of Object.entries(config)) result[key] = isReference(value) ? value.get() : value;
	return result;
}
//#endregion
//#region src/escalate.ts
/**
* 重复拦截升级。
*
* 模型是目标驱动的。被拦一次它会换姿势重试 —— 换个工具、改个写法、复制到别的目录
* 再来一次。对于「它没读懂规则」这种情形，拒绝信息里的解释就够了；但对于
* 「它不接受这个结论」，唯一有效的信号是明确的 STOP：把决定权交回人手上。
*
* 判定只按**目标路径**计数（不按命令文本），因为换个写法绕同一路径正是要防的行为。
* 路径比较前统一小写，避免用大小写差异重置计数。
*/
/** 达到该次数后升级为 STOP。 */
const STOP_THRESHOLD = 3;
/** 计数上限，防止长时间运行时 Map 无限增长。 */
const MAX_TRACKED = 500;
const denials = /* @__PURE__ */ new Map();
/** 归一化被计数的主键。 */
function keyOf(target) {
	return target.toLowerCase();
}
/**
* 记录一次拦截。
*
* @param target 被拦的目标（路径或命令摘要）。
* @returns 该目标的累计拦截次数（含本次）。
*/
function recordDenial(target) {
	const key = keyOf(target);
	const next = (denials.get(key) ?? 0) + 1;
	denials.set(key, next);
	if (denials.size > MAX_TRACKED) {
		const oldest = denials.keys().next();
		if (oldest.done !== true) denials.delete(oldest.value);
	}
	return next;
}
/** 该目标是否已达到 STOP 阈值。 */
function appliesStop(target) {
	return (denials.get(keyOf(target)) ?? 0) >= STOP_THRESHOLD;
}
/**
* 追加到拒绝理由末尾的 STOP 条款。
*
* @param count 该目标已被拦截的次数。
*/
function stopClause(count) {
	return `\n\nSTOP: this target has been blocked ${count} times. Do NOT try other tools, renamed paths, copied locations, or encoding tricks to get around the guard — that is exactly what it exists to stop. Explain the situation to the user and ask how they want to proceed.`;
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
/**
* 设置命名空间 = 本插件在 profile 里的**条目 id**。
*
* 宿主的 settings 服务按条目 id 寻址，不是包名。本插件两者恰好相同
* （`cordis.patch.yml` 里 `id: dsh-safe-delete`），但如果将来改了行 id，
* 这里必须跟着改 —— 否则命令写入会落在不存在的条目上。
*/
const PLUGIN_NAMESPACE = "dsh-safe-delete";
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
* 推断 DSH 的安装目录，供分类器把「改动宿主自身文件」判为 protected。
*
* ## 为什么需要推断而不是配置
*
* 这个路径随用户的安装方式而变（桌面版在 `%LOCALAPPDATA%\Programs\...`，
* 也可能有别的部署），写死或要求用户手填都不合适。宿主加载插件时，
* `process.execPath` 指向的就是那一份运行时，从它往上找 `resources` 即可。
*
* ## 找不到时的行为
*
* 返回空对象 —— 即不给 `env.installDir`。分类器因此不会把任何路径判为
* 「安装目录」。这比猜一个错误路径更好：错猜会把正常文件误判成 protected。
*
* @returns `{ installDir }` 或空对象。
*/
function resolveInstallDir() {
	try {
		const exec = process.execPath;
		if (typeof exec !== "string" || exec === "") return {};
		/**
		* 认定「这确实是 DSH 的安装目录」而不是同名的无关目录。
		*
		* 只看有没有 `resources` 子目录太松：任何恰好带 `resources` 的目录都会被
		* 判成安装目录，那下面所有删除都会要求确认。要求 resources 里出现
		* `app.asar` 或 `app` 目录才算 —— 这是 Electron 桌面版的确定特征。
		*/
		const looksLikeInstall = (dir) => {
			const resources = path.join(dir, "resources");
			if (!fs.existsSync(resources)) return false;
			return fs.existsSync(path.join(resources, "app.asar")) || fs.existsSync(path.join(resources, "app"));
		};
		const direct = path.dirname(exec);
		if (looksLikeInstall(direct)) return { installDir: direct };
		let dir = direct;
		for (let i = 0; i < 4; i += 1) {
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
			if (looksLikeInstall(dir)) return { installDir: dir };
		}
		return {};
	} catch {
		return {};
	}
}
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
/**
* 从一个写入类工具调用里取出它要写的绝对路径。
*
* 已核实的参数字段：`write` / `edit` 用 `file_path`，`str_replace_editor` 用 `path`。
*
* @returns 目标路径；不是写入操作（例如 `str_replace_editor view`）或取不到路径时返回 `null`。
*/
function writeTargetOf(toolName, args) {
	if (args === void 0) return null;
	if (toolName === "write" || toolName === "edit") {
		const raw = args["file_path"];
		if (typeof raw !== "string" || raw === "") return null;
		return path.resolve(raw);
	}
	if (toolName === "str_replace_editor") {
		if (args["command"] === "view") return null;
		const raw = args["path"];
		if (typeof raw !== "string" || raw === "") return null;
		return path.resolve(raw);
	}
	return null;
}
function applyInner(ctx, config) {
	const raw = config;
	const unwrap = (value) => value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
	const numeric = (key, fallback) => {
		const value = unwrap(raw[key]);
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	};
	const booleanOf = (key, fallback) => {
		const value = unwrap(raw[key]);
		return typeof value === "boolean" ? value : fallback;
	};
	const textOf = (key, fallback) => {
		const value = unwrap(raw[key]);
		return typeof value === "string" && value !== "" ? value : fallback;
	};
	const homeDir = textOf("homeDir", os.homedir());
	const dshHome = raw["homeDir"] !== void 0 ? path.join(homeDir, ".dsh") : resolveDshHome();
	const stateDir = path.resolve(textOf("stateDir", path.join(dshHome, ".dsh-safe-delete")));
	const env = {
		home: homeDir,
		workdir: process.cwd(),
		dshHome,
		safeZoneDir: stateDir,
		...resolveInstallDir()
	};
	const retentionDays = Math.min(365, Math.max(1, numeric("retentionDays", 1)));
	/**
	* 删除会被系统永久执行的风险 —— apply 时算一次，钩子与工具共用同一个结论。
	*
	* 钩子必须自己拿到它：工具内部那条路是恒放行的桩（见下方 requestApproval
	* 的注释）。同一个值两处用，避免两处判定漂移。
	*/
	const hookPermanentDeleteRisk = detectPermanentDeleteRisk();
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
	const approvalPolicy = (session) => {
		const approval = ctx.get("approval");
		if (approval === void 0 || approval === null) return "absent";
		try {
			const policy = approval.effectivePolicy?.(session);
			if (policy === "ask" || policy === "never") return policy;
			const override = approval.overrideOf?.(session);
			if (override === "ask" || override === "never") return override;
		} catch {}
		return "ask";
	};
	const tools = createTools({
		stateDir,
		env,
		requestApproval,
		retentionDays,
		autoPrune: booleanOf("autoPrune", true),
		confirmFileCount: numeric("confirmFileCount", 5e3),
		confirmBytes: numeric("confirmBytes", 2147483648),
		crossVolumeCopy: booleanOf("crossVolumeCopy", false),
		destination: normalizeDestination(unwrap(raw["deleteDestination"])),
		permanentDeleteRisk: hookPermanentDeleteRisk
	});
	const registry = ctx.get("tools");
	if (registry?.register !== void 0) for (const tool of tools) registry.register(tool);
	const onPreExecute = async (exec, next) => {
		const toolName = exec?.name;
		if (toolName === void 0) return next();
		/** 本次调用的会话；取不到时为 `undefined`，由 `effectivePolicy` 回落到默认策略。 */
		const session = exec.agent?.session ?? exec.session;
		if (booleanOf("blockProtectedWrites", true)) {
			const writeTarget = writeTargetOf(toolName, exec.arguments);
			if (writeTarget !== null) {
				let classification;
				try {
					classification = classifyPath(writeTarget, env);
				} catch {
					classification = void 0;
				}
				if (classification === "protected") {
					const attempts = recordDenial(writeTarget);
					appendAudit(stateDir, {
						event: "block-write",
						target: writeTarget,
						tool: toolName,
						detail: `protected (attempt ${attempts})`
					});
					const escalate = appliesStop(writeTarget);
					return {
						kind: "deny",
						reason: `Blocked a write to "${writeTarget}": it is boot-critical (a profile manifest, a patch layer, a lockfile, node_modules, the DSH install directory, or the safe zone's own state). Corrupting it can make DSH fail to start — and a DSH that does not start cannot load this plugin to help you recover. If this change is really intended, ask the user to make it themselves; do NOT try to write it through another tool.` + (escalate ? stopClause(attempts) : ""),
						displayReason: {
							en: `Blocked a write to a boot-critical file: ${writeTarget}. Ask the user to make this change.`,
							zh: `已拦下对启动关键文件 ${writeTarget} 的写入。这类改动请让用户自己完成。`
						}
					};
				}
			}
		}
		if (toolName === "safe_delete") {
			if (exec.arguments?.["preview"] === true) return next();
			const args = exec.arguments ?? {};
			const targets = normaliseDeleteTargets(args);
			if (targets.error !== void 0 || targets.paths.length === 0) return next();
			const hookDestination = normalizeDestination(unwrap(raw["deleteDestination"]));
			if (typeof args.root === "string" && args.root.trim() !== "") {
				const rootPath = path.resolve(String(args.root));
				const classification = classifyPath(rootPath, env);
				if (approvalPolicy(session) === "never") {
					if (hookDestination === "recycle-bin") return {
						kind: "deny",
						reason: "refusing a potentially unrecoverable pattern delete because the approval policy is never; matched item sizes cannot be checked before execution"
					};
					return next();
				}
				const bits = [`root ${rootPath}`];
				if (typeof args.match === "string") bits.push(`match "${args.match}"`);
				if (typeof args.olderThan === "string") bits.push(`older than ${args.olderThan}`);
				if (classification === "protected") bits.push("the root is a protected path");
				else bits.push("the matched items are not known until execution, and may include protected paths");
				return {
					kind: "ask",
					reason: `Delete files matched under this path? ` + bits.join("; ") + ". The root directory itself is kept. " + (hookDestination === "recycle-bin" ? "Matched items go to the system recycle bin, not the safe zone. " + (hookPermanentDeleteRisk.risky ? `System policy will permanently delete them: ${hookPermanentDeleteRisk.reason ?? "recycling is disabled"}. ` : "Matched sizes are unknown before execution; items exceeding recycle-bin capacity may be permanently deleted. ") + "safe_zone_restore cannot restore these items. " : "Only matched items inside it move into the safe zone. ") + "The exact count is computed during execution and covered by this one approval."
				};
			}
			const plan = (() => {
				try {
					let fileCount = 0;
					let bytes = 0;
					let statsOmitted = false;
					/** 每个目标的字节数，与 `resolved` 等长；钩子的配额判定要用。 */
					const targetSizes = [];
					const dangerousPaths = [];
					const dangerousReasons = [];
					const resolved = [];
					const recycleMode = hookDestination === "recycle-bin";
					for (const raw of targets.paths) {
						const target = path.resolve(raw);
						resolved.push(target);
						const description = describeTarget(target, hookDestination === "recycle-bin" ? { stats: false } : {});
						if (description.statsOmitted === true) statsOmitted = true;
						fileCount += description.fileCount;
						bytes += description.bytes;
						targetSizes.push(description.bytes);
						const gate = decideGate(target, description, {
							env,
							confirmFileCount: recycleMode ? 0 : numeric("confirmFileCount", 5e3),
							confirmBytes: recycleMode ? 0 : numeric("confirmBytes", 2147483648)
						});
						if (gate.needsApproval) {
							dangerousPaths.push(target);
							dangerousReasons.push(...gate.reasons);
						}
					}
					const countLimit = recycleMode ? 0 : numeric("confirmFileCount", 5e3);
					const bytesLimit = recycleMode ? 0 : numeric("confirmBytes", 2147483648);
					const reasons = [...new Set(dangerousReasons)];
					if (countLimit > 0 && fileCount > countLimit) reasons.push(`${fileCount} entries in this batch exceeds the limit of ${countLimit}`);
					if (bytesLimit > 0 && bytes > bytesLimit) reasons.push(`${bytes} bytes in this batch exceeds the limit of ${bytesLimit}`);
					return {
						resolved,
						fileCount,
						bytes,
						reasons,
						statsOmitted,
						targetSizes,
						needsApproval: reasons.length > 0
					};
				} catch {
					return;
				}
			})();
			if (plan === void 0) return next();
			const riskVerdict = decideHookRisk({
				destination: hookDestination,
				...hookPermanentDeleteRisk === void 0 ? {} : { permanentDeleteRisk: hookPermanentDeleteRisk },
				targets: plan.resolved,
				sizes: plan.targetSizes
			});
			if (riskVerdict.kind === "ask") {
				if (approvalPolicy(session) === "never") return {
					kind: "deny",
					reason: `refusing an unrecoverable delete because the approval policy is 'never': ${riskVerdict.reason.split("\n")[0]}`
				};
				return {
					kind: "ask",
					reason: riskVerdict.reason
				};
			}
			if (!plan.needsApproval) return next();
			if (approvalPolicy(session) === "never") return next();
			const isBatch = plan.resolved.length > 1;
			const shown = plan.resolved.slice(0, 5);
			const more = plan.resolved.length > shown.length ? ` (+${plan.resolved.length - shown.length} more)` : "";
			const listText = shown.map((p) => `"${p}"`).join(", ") + more;
			const subject = isBatch ? `${plan.resolved.length} item(s): ${listText}` : `"${plan.resolved[0]}"`;
			const destination = hookDestination;
			return {
				kind: "ask",
				reason: buildInterceptReason({
					resolved: plan.resolved,
					fileCount: plan.fileCount,
					bytes: plan.bytes,
					reasons: plan.reasons,
					retentionDays,
					destination,
					statsOmitted: plan.statsOmitted === true
				}),
				displayReason: {
					en: buildInterceptReason({
						resolved: plan.resolved,
						fileCount: plan.fileCount,
						bytes: plan.bytes,
						reasons: plan.reasons,
						retentionDays,
						destination,
						statsOmitted: plan.statsOmitted === true,
						english: true
					}),
					zh: destination === "recycle-bin" ? `删除${isBatch ? `这 ${plan.resolved.length} 项` : ""}${subject}？${plan.reasons.join("；")}。会直接移入系统回收站，取回要用回收站本身。` : `删除${isBatch ? `这 ${plan.resolved.length} 项` : ""}${subject}？${plan.reasons.join("；")}。会移入安全区，${retentionDays} 天内可以取回。`
				}
			};
		}
		const field = SHELL_TOOLS[toolName];
		if (field === void 0) return next();
		if (!booleanOf("blockShellDeletes", true)) return next();
		const text = exec.arguments?.[field];
		if (typeof text !== "string" || text === "") return next();
		let verdict;
		try {
			verdict = parseCommand(text);
		} catch {
			return next();
		}
		if (!verdict.destructive) return next();
		if (verdict.target === null || isUnresolvableTarget(verdict.target)) {
			if (approvalPolicy(session) === "never") {
				appendAudit(stateDir, {
					event: "ask",
					tool: toolName,
					detail: `unresolvable target, allowed under the never policy: ${text.trim().slice(0, 200)}`
				});
				return next();
			}
			appendAudit(stateDir, {
				event: "ask",
				tool: toolName,
				detail: `unresolvable target: ${text.trim().slice(0, 200)}`
			});
			return {
				kind: "ask",
				reason: `A delete command was requested whose target cannot be resolved statically: ${text.trim()}. Review the command text before allowing it.`,
				displayReason: {
					en: "A delete command targets something that cannot be resolved (a variable, pipeline or wildcard). Review the command before allowing it.",
					zh: "有一条删除命令的目标无法静态解析（变量、管道或通配符）。请先看清命令内容再决定。"
				}
			};
		}
		const attempts = recordDenial(verdict.target);
		appendAudit(stateDir, {
			event: "block-shell",
			target: verdict.target,
			tool: toolName,
			detail: `${verdict.recursive ? "recursive" : "non-recursive"} (attempt ${attempts})`
		});
		const escalate = appliesStop(verdict.target);
		return {
			kind: "deny",
			reason: `Blocked a raw shell delete of "${verdict.target}" (${verdict.recursive ? "recursive" : "non-recursive"}). Deleting through the shell erases data permanently. Use the \`safe_delete\` tool instead: it moves the target into the safe zone, where it can be restored for a while. Run \`safe_delete\` with preview:true to see exactly what would be moved, then call it again to do it. Do not retry this shell command or look for another way around the block.` + (escalate ? stopClause(attempts) : ""),
			displayReason: {
				en: `Blocked a raw shell delete of "${verdict.target}". Use safe_delete so it can be restored.`,
				zh: `已拦下对 "${verdict.target}" 的原始 shell 删除。请改用 safe_delete，这样还能取回。`
			}
		};
	};
	const on = ctx.on;
	if (typeof on === "function") on.call(ctx, "tools/pre-execute", onPreExecute);
	/**
	* 取宿主 settings 服务。
	*
	* ## 为什么不在启动时捕获一次
	*
	* `ctx.get(name)` 是 strict 的：服务的 fiber 尚未就绪（`state !== 2`）时返回
	* `undefined`，而且**不报错**。启动时捕获会永久丢掉「稍后才就绪」的服务 ——
	* 表现为斜杠命令改配置永远失败，却说不出原因。
	*
	* 每次调用时现取，服务就绪后自然可用。
	*/
	const settingsServiceOf = () => ctx.get("settings");
	/** 从宿主 settings 快照里取本插件的当前值。 */
	const readSettings = () => {
		try {
			const described = settingsServiceOf()?.describe?.();
			const rows = Array.isArray(described) ? described : described?.namespaces;
			if (!Array.isArray(rows)) return {};
			for (const row of rows) {
				if (row === null || typeof row !== "object") continue;
				const record = row;
				if ((typeof record["ns"] === "string" ? record["ns"] : record["id"]) !== PLUGIN_NAMESPACE) continue;
				const value = record["value"];
				return value !== null && typeof value === "object" ? value : {};
			}
			return {};
		} catch {
			return {};
		}
	};
	/** 当前快照的修订号（并发围栏）。 */
	const readRevision = () => {
		try {
			const described = settingsServiceOf()?.describe?.();
			const rows = Array.isArray(described) ? described : described?.namespaces;
			if (!Array.isArray(rows)) return void 0;
			for (const row of rows) {
				if (row === null || typeof row !== "object") continue;
				const record = row;
				if ((typeof record["ns"] === "string" ? record["ns"] : record["id"]) !== PLUGIN_NAMESPACE) continue;
				return typeof record["revision"] === "number" ? record["revision"] : void 0;
			}
			return;
		} catch {
			return;
		}
	};
	registerCommands(ctx, {
		delete: async (pathText, options) => {
			const result = await deletePath({
				path: pathText,
				preview: options.preview
			}, {
				stateDir,
				env,
				retentionDays,
				confirmFileCount: numeric("confirmFileCount", 5e3),
				confirmBytes: numeric("confirmBytes", 2147483648),
				crossVolumeCopy: booleanOf("crossVolumeCopy", false),
				requestApproval,
				now: () => Date.now()
			});
			if (!result.ok) return {
				ok: false,
				text: result.error
			};
			return {
				ok: true,
				text: result.kind === "preview" ? describePreview(result, retentionDays, normalizeDestination(unwrap(raw["deleteDestination"]))) : result.kind === "recycled" ? describeRecycled(result) : describeMoved(result, retentionDays)
			};
		},
		listSafeZone: async () => listSafeZone(stateDir),
		restore: async (id) => {
			try {
				const { restoredTo } = await restoreFromSafeZone(stateDir, id);
				appendAudit(stateDir, {
					event: "restore",
					target: restoredTo,
					tool: "slash-command",
					detail: `id=${id}`
				});
				return {
					ok: true,
					restoredTo
				};
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		},
		clean: async (dryRun) => {
			const selected = [...await listSafeZone(stateDir)].sort((a, b) => a.movedAt - b.movedAt);
			if (dryRun) return {
				removed: selected.map((entry) => `${entry.originalPath} (${entry.id})`),
				freedBytes: selected.reduce((sum, entry) => sum + entry.bytes, 0)
			};
			const submitted = await requestCleanup({
				stateDir,
				limit: selected.length,
				minIntervalMs: 0,
				mode: "all"
			});
			if (!submitted.started) return {
				removed: [],
				freedBytes: 0,
				failures: [],
				scheduled: {
					started: false,
					reason: submitted.reason ?? "unknown reason"
				}
			};
			return {
				removed: [],
				freedBytes: 0,
				failures: [],
				scheduled: { started: true }
			};
		},
		readConfig: async () => {
			const stored = readSettings();
			return {
				...unwrapConfig(Config({})),
				...stored
			};
		},
		writeConfig: async (key, value) => {
			const settingsService = settingsServiceOf();
			if (settingsService?.mutate === void 0) return {
				ok: false,
				error: "这个宿主没有暴露设置服务，请改用 cordis.patch.yml"
			};
			try {
				const result = await settingsService.mutate(PLUGIN_NAMESPACE, [{
					op: "set",
					path: [key],
					value
				}], readRevision());
				if (result !== null && typeof result === "object" && result.ok === false) {
					const error = result.error;
					return {
						ok: false,
						error: typeof error === "string" ? error : "宿主拒绝了这次保存"
					};
				}
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		},
		status: async () => {
			const entries = await listSafeZone(stateDir);
			const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
			const job = readCleanupJob(stateDir);
			const cleanup = job === null ? "从未运行" : `${job.outcome}${job.recycled > 0 ? `，已回收 ${job.recycled} 条` : ""}${job.skipped > 0 ? `，跳过 ${job.skipped} 条` : ""}${job.lastError === void 0 ? "" : `，上次错误：${job.lastError}`}`;
			return [
				`安全区目录：${stateDir}`,
				`条目数：${entries.length}`,
				`占用：${humanBytes$1(total)}`,
				`保留期：${retentionDays} 天（到期移入系统回收站，不是永久删除）`,
				`自动清理：${booleanOf("autoPrune", true) ? "开（后台独立进程，不阻塞界面）" : "关"}`,
				`上次清理：${cleanup}`
			].join("\n");
		}
	});
	maybeRunRequestedClean(ctx, {
		stateDir,
		requestedAt: numeric("cleanRequestedAt", 0)
	});
	const systemPrompt = ctx.get("systemPrompt");
	if (systemPrompt?.section !== void 0) systemPrompt.section({
		name: "dsh-safe-delete:policy",
		order: 200,
		text: "Deleting files: use `safe_delete`, never the shell.\n- Unsure about a path? Call `safe_delete` with `preview: true` first — it reports size, entry count and danger level without changing anything.\n- Pass `paths: [...]` to delete several items in one call; a batch needs one approval, not one each.\n- Blocked shell deletes: do NOT retry, switch tools, or rename/encode around it. If an approval is rejected, ask the user what they want instead of looking for another route.\n- Deleted items are restorable via `safe_zone_restore id=<id>` until they expire."
	});
}
/**
* 注册 `/safe-delete` 斜杠命令。
*
* 与设置页的**配置是同一份**：两者都通过宿主的 settings 服务读写，所以命令行改完、
* 重启后设置页会显示新值，反之亦然。不存在「两处配置需要对账」。
*
* 命令不同于工具：它不经过模型，不消耗 token，用户直接触发。
*
* ## 为什么用 `ctx.inject(['commands'], …)` 而不是直接读 `ctx.commands`
*
* `commands` 是 cordis 服务，不是挂在 ctx 上的普通属性。直接在 apply 里访问
* `ctx.commands` 的风险是：服务尚未就绪时它是 `undefined`，于是 `?.` 静默跳过，
* **命令根本没注册**，而且不报错 —— 用户敲 `/safe-delete` 只会得到「未知命令」。
*
* `ctx.inject` 会让这段回调等服务就绪后再执行（宿主官方的 permission-presets
* 就是这么写的），所以服务晚到也能补上。
*/
function registerCommands(ctx, adapter) {
	/** 真正做注册的那一步。 */
	const attach = (registry) => {
		const register = registry?.register;
		if (typeof register !== "function") return;
		register.call(registry, {
			name: "safe-delete",
			description: "安全删除：把文件移入安全区（可恢复），或管理安全区与配置（无参数看用法）",
			input: { hint: "<路径> | clean | config | list | restore <id> | status" },
			handler: async ({ rawInput }) => runCommand(rawInput, adapter)
		});
	};
	if (typeof ctx.inject === "function") try {
		ctx.inject(["commands"], (scoped) => attach(scoped.commands));
		return;
	} catch {}
	attach(ctx.commands);
}
/** 记录「已消费到哪个清理请求戳」的文件名（放在安全区根目录）。 */
const CLEAN_MARKER = "last-clean-request.json";
/**
* 跨代清理锁（放在安全区根目录）。
*
* ## 为什么要跨代锁
*
* 清理是异步的（每条目一次 PowerShell，可达 20 秒），而 `apply` 不等待它。
* 如果清理期间用户又改了配置，HMR 会**卸载并重建插件模块**——新模块实例有自己的
* `serialized()` Promise 链，与旧实例那条**互不互斥**。于是旧代的清理和新代的
* 安全区操作会并发写索引，可能丢一条索引记录。
*
* 模块作用域里的变量扛不过重载，所以锁必须落在文件系统上。
*/
const CLEAN_LOCK = "clean.lock";
/** 锁的存活上限：超过就视为上次异常退出的残留，强行接管。 */
const CLEAN_LOCK_STALE_MS = 3e5;
/**
* 尝试获取跨代清理锁。
*
* 用 `wx`（独占创建）实现：文件已存在就失败，这是原子的，不需要额外的竞态处理。
*
* @param stateDir 安全区根目录。
* @returns 拿到锁返回释放函数；已有别人持锁返回 `undefined`。
*/
async function acquireCleanLock(stateDir) {
	const lockPath = path.join(stateDir, CLEAN_LOCK);
	try {
		await fs.promises.mkdir(stateDir, { recursive: true });
		await fs.promises.writeFile(lockPath, JSON.stringify({
			pid: process.pid,
			at: Date.now()
		}), {
			encoding: "utf8",
			flag: "wx"
		});
		return () => {
			try {
				fs.rmSync(lockPath, { force: true });
			} catch {}
		};
	} catch {
		try {
			const stat = await fs.promises.stat(lockPath);
			if (Date.now() - stat.mtimeMs > CLEAN_LOCK_STALE_MS) {
				await fs.promises.writeFile(lockPath, JSON.stringify({
					pid: process.pid,
					at: Date.now()
				}), "utf8");
				return () => {
					try {
						fs.rmSync(lockPath, { force: true });
					} catch {}
				};
			}
		} catch {}
		return;
	}
}
/**
* 响应配置页的「立即清理」按钮。
*
* ## 触发方式
*
* 客户端把时间戳写进 `cleanRequestedAt` 配置项 → 配置写入触发 HMR 重载插件 →
* 本函数随 `apply` 重跑 → 发现时间戳比上次消费的新 → 清一次。
*
* ## 为什么需要标记文件
*
* `apply` 会在**任何**配置改动后重跑。如果只看"时间戳非 0"，那么用户改容量、
* 改阈值也会顺带触发清理 —— 一个他没要求的副作用。标记文件记住已消费的时间戳，
* 才能做到"只有按过按钮才清理"。
*
* ## 失败不抛
*
* 这个函数在 `apply` 里调用。它若抛错，会让整个插件激活失败（工具、拦截全部
* 消失）—— 为了一次清理付出这个代价毫无道理。所以全部包在 try 里，失败只写日志。
*
* @param ctx 插件上下文（用于日志）。
* @param opts 状态目录与请求戳。
*/
async function maybeRunRequestedClean(ctx, opts) {
	try {
		if (!Number.isFinite(opts.requestedAt) || opts.requestedAt <= 0) return;
		const markerPath = path.join(opts.stateDir, CLEAN_MARKER);
		let consumed = 0;
		try {
			const raw = await fs.promises.readFile(markerPath, "utf8");
			const parsed = JSON.parse(raw);
			if (typeof parsed.consumedAt === "number") consumed = parsed.consumedAt;
		} catch {}
		if (opts.requestedAt <= consumed) return;
		const release = await acquireCleanLock(opts.stateDir);
		if (release === void 0) {
			ctx.logger?.info?.("[dsh-safe-delete] clean request skipped: another generation holds the clean lock");
			return;
		}
		try {
			const selected = [...await listSafeZone(opts.stateDir)].sort((a, b) => a.movedAt - b.movedAt);
			const submitted = selected.length === 0 ? {
				started: true,
				reason: "nothing to clean"
			} : await requestCleanup({
				stateDir: opts.stateDir,
				limit: selected.length,
				minIntervalMs: 0,
				mode: "all"
			});
			if (submitted.started) await fs.promises.writeFile(markerPath, JSON.stringify({
				consumedAt: opts.requestedAt,
				count: selected.length
			}), "utf8");
			else ctx.logger?.warn?.(`[dsh-safe-delete] panel clean request NOT consumed (${submitted.reason ?? "unknown"}); it stays pending so a later reload can retry`);
			ctx.logger?.info?.(`[dsh-safe-delete] panel clean request: ${submitted.started ? "started background cleanup" : `not started (${submitted.reason ?? "unknown"})`} for ${selected.length} entr(ies)`);
		} finally {
			release();
		}
	} catch (error) {
		try {
			ctx.logger?.error?.(error);
		} catch {}
	}
}
/**
* 钩子层的「这次删除会不可恢复」判定。
*
* ## 为什么必须在钩子层（2026-11-04 第 24 次审查 R24-1，P0）
*
* 工具内部的 `requestApproval` 在生产接线里是**恒 `'allowed-once'`** 的桩
* （见下方注释）—— 它的前提是「管线已经把 ask 解决了」。所以在工具内部
* 「问人」等于不问。
*
* 上一版把 `permanentDeleteRisk` 与配额风险的审批写在 `deletePath` /
* `deleteMany` 里，于是策略锁定的机器上删一个普通文件走的是：
*
* ```
* 钩子：free 分类、不超阈值 → next()（不弹卡）
* 工具：permanentDeleteRisk.risky → requestApproval → 桩恒返回 allowed-once
* 结果：永久删除，用户零提示
* ```
*
* README 承诺的「会先弹窗，不同意就放弃」因此不存在。这条判定必须提到
* 钩子 —— 那里才是真正能拦住调用、能弹卡的地方。
*
* @param input 目的地、风险与目标。
* @returns `ask` 要求审批；`next` 放行。
*/
function decideHookRisk(input) {
	if (input.destination !== "recycle-bin") return { kind: "next" };
	if (input.permanentDeleteRisk?.risky === true) return {
		kind: "ask",
		reason: `This delete will PERMANENTLY remove ${input.targets.length} item(s) — the recycle bin is not in effect.\n\nReason: ${input.permanentDeleteRisk.reason ?? "the system is configured to delete permanently"}\n\nApprove only if you accept that the data cannot be recovered.`
	};
	const oversized = input.targets.filter((_, i) => {
		const size = input.sizes[i];
		return typeof size === "number" && size > 0 && detectQuotaRisk(size) !== void 0;
	});
	if (oversized.length > 0) {
		const sample = oversized.slice(0, 3).map((p) => `"${p}"`).join(", ");
		const rest = oversized.length > 3 ? ` (+${oversized.length - 3} more)` : "";
		return {
			kind: "ask",
			reason: `This delete will PERMANENTLY remove ${oversized.length} file(s) larger than the recycle bin's per-volume limit: ${sample}${rest}.\n\nApprove only if you accept that they cannot be recovered.`
		};
	}
	return { kind: "next" };
}
/**
* 拼审批卡片上的那句「删除后会发生什么」。
*
* ## 为什么要按目的地改写（2026-11-04）
*
* 旧文案硬编码「移入安全区，N 天内可恢复」。回收站模式下这是**假的**：
* 文件不进安全区，`safe_zone_restore` 也找不回它，取回要去系统回收站。
* 承诺与实际不符比不说更糟 —— 用户会照着一个错误的心智去决策。
*
* 统计被跳过时同样不能报「共 N 个文件」：那个数字是 0，报出来就是谎报目标为空。
*
* @param input 目标、统计值、理由与目的地。
* @returns 审批文案。
*/
function buildInterceptReason(input) {
	const isBatch = input.resolved.length > 1;
	const shown = input.resolved.slice(0, 5);
	const more = input.resolved.length > shown.length ? ` (+${input.resolved.length - shown.length} more)` : "";
	const listText = shown.map((p) => `"${p}"`).join(", ") + more;
	const subject = isBatch ? `${input.resolved.length} item(s): ${listText}` : `"${input.resolved[0]}"`;
	const sizeText = input.statsOmitted === true ? "" : ` Total ${input.fileCount} entries, ${input.bytes} bytes.`;
	const why = `Why this needs your OK: ${input.reasons.join("; ")}.`;
	const outcome = input.destination === "recycle-bin" ? "It will be moved into the system recycle bin — restore it from there, the safe zone will not track it." : `It will be moved into the safe zone and can be restored for ${input.retentionDays} days.`;
	if (input.english === true) return `Delete ${subject}? ${input.reasons.join("; ")}. ${outcome}`;
	return `Delete ${subject}?${sizeText} ${why} ${outcome}`;
}
//#endregion
export { Config, apply, buildInterceptReason, decideHookRisk, inject, name };
