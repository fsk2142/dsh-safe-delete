import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
//#region src/audit.ts
/**
* 审计日志：把每次拦截、授权、删除、取回、清理都记下来。
*
* 为什么需要它：`safe_zone_list` 只回答"安全区里现在有什么"，回答不了
* "昨天谁删了什么、当时为什么被拦"。出了问题要事后追查时，只有这份流水账能给答案。
*
* 格式：JSONL（一行一条），追加写。不读改，因此不会被并发写坏；读侧按行容错。
*/
/** 日志文件路径。 */
function journalPath(stateDir) {
	return path.join(stateDir, "journal.jsonl");
}
/**
* 追加一条审计记录。
*
* 刻意不抛错：审计写失败不该让一次删除失败 —— 那会让"记录"变成"功能"。
*/
function appendAudit(stateDir, record) {
	try {
		mkdirSync(stateDir, { recursive: true });
		const line = JSON.stringify({
			at: record.at ?? (/* @__PURE__ */ new Date()).toISOString(),
			...record
		});
		const file = journalPath(stateDir);
		let needsLeadingNewline = false;
		if (existsSync(file)) try {
			const size = statSync(file).size;
			if (size > 0) {
				const fd = openSync(file, "r");
				try {
					const buf = Buffer.alloc(1);
					readSync(fd, buf, 0, 1, size - 1);
					needsLeadingNewline = buf[0] !== 10;
				} finally {
					closeSync(fd);
				}
			}
		} catch {
			needsLeadingNewline = false;
		}
		appendFileSync(file, `${needsLeadingNewline ? "\n" : ""}${line}\n`, "utf8");
	} catch {}
}
/**
* 追加一批审计记录：**一次文件操作写多行**。
*
* ## 为什么需要它
*
* 批量删除 1000 个文件时，`appendAudit` 逐条调用要 728 ms —— 占总耗时的一半以上，
* 比实际移动（347 ms）还贵。原因是单条实现为了处理「上次写入留下半行」这个边界，
* 每条都做 `existsSync + statSync + openSync + readSync + closeSync + appendFileSync`
* 六次系统调用。
*
* 那个边界**每批只需要检查一次**：批量内部不会产生半行。所以这里先修一次，再把
* 所有行拼成一个字符串一次写入。
*
* ## 与单条版本的关系
*
* 输出格式完全一致（每行一个 JSON）。`appendAudit` 仍保留，用于零散的单条写入
* （拦截、取回、清理等，一次只有一条）。
*
* @param stateDir 安全区目录。
* @param records 要写入的记录（可含 `at`，否则用当前时间）。
*/
function appendAuditBatch(stateDir, records) {
	if (records.length === 0) return;
	try {
		mkdirSync(stateDir, { recursive: true });
		const file = journalPath(stateDir);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const lines = records.map((r) => JSON.stringify({
			at: r.at ?? now,
			...r
		}));
		let needsLeadingNewline = false;
		if (existsSync(file)) try {
			const size = statSync(file).size;
			if (size > 0) {
				const fd = openSync(file, "r");
				try {
					const buf = Buffer.alloc(1);
					readSync(fd, buf, 0, 1, size - 1);
					needsLeadingNewline = buf[0] !== 10;
				} finally {
					closeSync(fd);
				}
			}
		} catch {
			needsLeadingNewline = false;
		}
		appendFileSync(file, `${needsLeadingNewline ? "\n" : ""}${lines.join("\n")}\n`, "utf8");
	} catch {}
}
/**
* 读取最近的审计记录。
*
* ## 为什么从文件尾部读（2026-11-05 复审 A08）
*
* 旧实现 `readFileSync` 整份 `journal.jsonl` 再逐行 `JSON.parse`，最后取尾 N 条。
* 于是读 20 条的 CPU、峰值内存与读取字节数都随**历史总条目**增长 ——
* 实测 80,000 行 / 14 MB 时全量读 + 解析约 513 ms（Python 基准，同阶），
* 而尾部 16 KB 的 I/O 约 0.14 ms。
*
* 审计日志只增不减，这个成本会一直涨。现在按块从末尾往前读，凑够 N 条完整行
* 就停，只解析这些行。
*
* ## 边界
*
* - 半行（进程在写一半时被杀）：末尾的半行解析失败被跳过，不影响更早的完整行；
* - 单行超过块大小：块会继续放大，直到能容下一整行；
* - 空文件 / 文件不存在：返回空数组；
* - `limit <= 0`：返回空数组（不再走 `slice(-0)` 那种隐式语义）。
*
* @param stateDir 安全区目录。
* @param limit 最多返回多少条（最新的在前）。
*/
function readAudit(stateDir, limit = 20) {
	const wanted = Math.trunc(limit);
	if (!Number.isFinite(wanted) || wanted <= 0) return [];
	const file = journalPath(stateDir);
	let size;
	try {
		size = statSync(file).size;
	} catch {
		return [];
	}
	if (size === 0) return [];
	let fd;
	try {
		fd = openSync(file, "r");
	} catch {
		return [];
	}
	try {
		let chunk = Math.min(TAIL_CHUNK_BYTES, size);
		let start = size;
		let buffer = "";
		for (;;) {
			const from = Math.max(0, start - chunk);
			const length = start - from;
			const bytes = Buffer.allocUnsafe(length);
			const read = readSync(fd, bytes, 0, length, from);
			buffer = bytes.subarray(0, read).toString("utf8") + buffer;
			start = from;
			if (start === 0 || countNewlines(buffer) > wanted) break;
			chunk = Math.min(start, chunk * 2);
		}
		return parseTail(buffer, wanted);
	} catch {
		return [];
	} finally {
		try {
			closeSync(fd);
		} catch {}
	}
}
/** 尾部读取的起始块大小（字节）。够装几十条正常审计记录。 */
const TAIL_CHUNK_BYTES = 16384;
/** 数一段文本里的换行数（不分配数组，长文本下比 `split` 便宜）。 */
function countNewlines(text) {
	let count = 0;
	for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
	return count;
}
/**
* 从尾部文本里取最后 `wanted` 条合法记录（最新在前）。
*
* @param text 尾部原文（可能从某一行中间开始）。
* @param wanted 想要多少条。
* @returns 记录数组。
*/
function parseTail(text, wanted) {
	const lines = text.split("\n");
	const records = [];
	for (let i = lines.length - 1; i >= 0 && records.length < wanted; i -= 1) {
		const line = (lines[i] ?? "").trim();
		if (line === "") continue;
		try {
			const parsed = JSON.parse(line);
			if (typeof parsed.at === "string" && typeof parsed.event === "string") records.push(parsed);
		} catch {}
	}
	return records;
}
//#endregion
export { appendAudit, appendAuditBatch, journalPath, readAudit };
