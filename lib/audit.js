import path from "node:path";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
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
* 读取最近的审计记录。
*
* @param stateDir 安全区目录。
* @param limit 最多返回多少条（最新的在前）。
*/
function readAudit(stateDir, limit = 20) {
	const file = journalPath(stateDir);
	if (!existsSync(file)) return [];
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const records = [];
	for (const line of text.split("\n")) {
		if (line === "") continue;
		try {
			const parsed = JSON.parse(line);
			if (typeof parsed.at === "string" && typeof parsed.event === "string") records.push(parsed);
		} catch {}
	}
	return records.slice(-limit).reverse();
}
//#endregion
export { appendAudit, journalPath, readAudit };
