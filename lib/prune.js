//#region src/prune.ts
/** 安全区条目总字节数。 */
function safeZoneBytes(entries) {
	return entries.reduce((sum, e) => sum + e.bytes, 0);
}
/**
* 实际触发清理的字节阈值。
*
* @param opts 清理参数。
* @returns 生效上限；阈值不合法时退回 `maxBytes`。
*/
function effectiveCapBytes(opts) {
	const percent = opts.pruneAtPercent;
	if (percent === void 0 || !Number.isFinite(percent) || percent <= 0 || percent >= 100) return opts.maxBytes;
	return Math.floor(opts.maxBytes * percent / 100);
}
/**
* 选出应当销毁的条目，按销毁顺序排列（最旧优先）。
*
* @param entries 当前条目（顺序无关）。
* @param opts 时间与容量策略。
* @returns 待销毁条目；空数组表示什么都不用删。
*/
function selectForPrune(entries, opts) {
	const ordered = [...entries].sort((a, b) => a.movedAt - b.movedAt);
	const selected = [];
	const selectedIds = /* @__PURE__ */ new Set();
	for (const entry of ordered) if (entry.expiresAt <= opts.now) {
		selected.push(entry);
		selectedIds.add(entry.id);
	}
	const cap = effectiveCapBytes(opts);
	if (cap <= 0) return [...ordered];
	let remaining = safeZoneBytes(entries.filter((e) => !selectedIds.has(e.id)));
	if (remaining <= cap) return selected;
	for (const entry of ordered) {
		if (remaining <= cap) break;
		if (selectedIds.has(entry.id)) continue;
		selected.push(entry);
		selectedIds.add(entry.id);
		remaining -= entry.bytes;
	}
	return selected;
}
//#endregion
export { effectiveCapBytes, safeZoneBytes, selectForPrune };
