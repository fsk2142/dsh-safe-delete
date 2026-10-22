//#region src/prune.ts
/** 安全区条目总字节数。 */
function safeZoneBytes(entries) {
	return entries.reduce((sum, e) => sum + e.bytes, 0);
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
	let remaining = safeZoneBytes(entries.filter((e) => !selectedIds.has(e.id)));
	if (remaining <= opts.maxBytes) return selected;
	for (const entry of ordered) {
		if (remaining <= opts.maxBytes) break;
		if (selectedIds.has(entry.id)) continue;
		selected.push(entry);
		selectedIds.add(entry.id);
		remaining -= entry.bytes;
	}
	return selected;
}
//#endregion
export { safeZoneBytes, selectForPrune };
