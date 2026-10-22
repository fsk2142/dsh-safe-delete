//#region src/settings-guide.ts
/** 1 GB 的字节数。 */
const GB = 1073741824;
/**
* 全部可配置项的说明。
*
* 顺序即 `/safe-delete config` 的展示顺序。
*/
const SETTING_GUIDES = [
	{
		key: "maxBytes",
		unit: "bytes",
		summary: "安全区最多占用多少磁盘。超过后最旧的条目会被真正删除。",
		effect: "调大：能留住更久的删除历史，占盘更多。调小：更早清掉旧条目，取回窗口更短。",
		range: "至少 1 MB；建议 5 GB 以上",
		defaultValue: 20 * GB
	},
	{
		key: "pruneAtPercent",
		unit: "percent",
		summary: "占用达到「容量上限」的百分之多少时就开始提前清理，为下一次删除腾空间。",
		effect: "调大（如 95）：更贴近上限才清理，盘用得更满但清理更频繁地逼近上限。调小（如 70）：更早开始清，盘更宽裕，但旧条目留得更短。设为 0 表示只在超过上限时才清。",
		range: "0 到 100；0 与 100 等价于「只在超过上限时清理」",
		defaultValue: 90
	},
	{
		key: "autoPruneIntervalMs",
		unit: "milliseconds",
		summary: "多久检查一次该不该清理。检查在每次使用插件时顺路发生，不是后台定时器。",
		effect: "调大：检查更少，过期条目可能多留一会儿。调小：检查更频繁，但每次都只是看一眼，开销很小。",
		range: "至少 1 分钟；默认 1 小时",
		defaultValue: 36e5
	},
	{
		key: "retentionDays",
		unit: "days",
		summary: "删掉的东西在安全区里放多少天，超过期限就会被真正删除。",
		effect: "调大：取回窗口更长，占盘更多。调小：更早彻底删除，误删的挽回时间更短。",
		range: "至少 1 天；默认 7 天",
		defaultValue: 7
	},
	{
		key: "confirmFileCount",
		unit: "count",
		summary: "一次删除的条目数超过多少时，额外要你确认一次。",
		effect: "调大：大批量删除也更少被打断。调小：更容易被要求确认。设为 0 表示不按条目数确认。",
		range: "0 或正整数；默认 5000",
		defaultValue: 5e3
	},
	{
		key: "confirmBytes",
		unit: "bytes",
		summary: "一次删除的总大小超过多少时，额外要你确认一次。",
		effect: "调大：删大文件也更少被打断。调小：更容易被要求确认。设为 0 表示不按大小确认。",
		range: "0 或至少 1 MB；默认 2 GB",
		defaultValue: 2 * GB
	},
	{
		key: "autoPrune",
		unit: "boolean",
		summary: "是否自动清理。关掉后过期条目不会被自动删除，只能手动清理。",
		effect: "关掉：安全区会一直变大，需要你自己执行 /safe-delete clean。",
		range: "on / off；默认 on",
		defaultValue: true
	},
	{
		key: "blockShellDeletes",
		unit: "boolean",
		summary: "是否拦截裸 shell 的删除命令（rm -rf、Remove-Item -Recurse 等）。",
		effect: "关掉：模型可以直接用 shell 删文件，且**不可恢复**。除非你清楚后果，否则不要关。",
		range: "on / off；默认 on",
		defaultValue: true
	},
	{
		key: "blockProtectedWrites",
		unit: "boolean",
		summary: "是否拦截对启动关键文件的写入（profile 清单、补丁层、lockfile、node_modules）。",
		effect: "关掉：这些文件可被随意改写，写坏会导致 DSH 起不来。除非你清楚后果，否则不要关。",
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
export { SETTING_GUIDES, formatSetting, guideOf, humanBytes, humanDuration, parseSetting };
