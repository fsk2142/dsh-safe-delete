//#region src/prune.ts
/** 安全区条目总字节数（用于状态展示）。 */
function safeZoneBytes(entries) {
	return entries.reduce((sum, e) => sum + e.bytes, 0);
}
/**
* 挑出该移入回收站的条目：**只看保留期**。
*
* 按 `movedAt` 升序返回，保证「最旧优先」在任何输入顺序下都成立。
*
* @param entries 安全区全部条目。
* @param opts 当前时间。
* @returns 待清理条目；空数组表示还没有到期的。
*/
function selectForPrune(entries, opts) {
	return [...entries].filter((entry) => entry.expiresAt <= opts.now).sort((a, b) => a.movedAt - b.movedAt);
}
//#endregion
export { safeZoneBytes, selectForPrune };
