window.__ModuleLoader__.load({
	id: "dsh-safe-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		/**
		* 插件页里的「安全区设置」表单。
		*
		* ## 为什么放在插件页而不是设置页
		*
		* DSH 的插件页声明了 `plugins.row.config` 槽位，插件可以把自己的配置渲染在
		* 自己的详情页里。设置页需要额外处理 tab 挂载与切换，反而更绕。
		*
		* ## 为什么保存后提示「重启 DSH 生效」
		*
		* 配置本身是 `.volatile()` 的，值会立即对读者可见；但本插件的**拦截线是否挂上**
		* 是在 `apply()` 时决定的，而 `apply` 不会因配置变更重跑。所以诚实的说法是
		* 「重启生效」—— 不假装即时。
		*
		* @module dsh-safe-delete/client
		*/
		/** 宿主侧设置的命名空间（= 插件在 profile 里的行 id）。 */
		const NAMESPACE = "dsh-safe-delete";
		/** 字节单位。 */
		const MB = 1048576;
		const GB = 1024 * MB;
		/** 1 GB 的字节数。 */
		const GIGABYTE = 1073741824;
		/**
		* 表单字段。
		*
		* 刻意只放**用户真正会调**的项：`stateDir`、`blockShellDeletes` 这类要么改动风险高
		* （换目录会让现有安全区「消失」）、要么属于核心安全语义（关掉拦截），不放进表单。
		*/
		const FIELDS = [
			{
				key: "maxBytes",
				label: "最大安全区容量",
				hint: "超过这个大小就开始清理最旧的条目。",
				kind: "bytes",
				min: 1,
				fallback: 20 * GIGABYTE
			},
			{
				key: "pruneAtPercent",
				label: "提前清理阈值",
				hint: "占用达到该百分比就开始清理，为新删除腾出空间。0 表示只在超过容量上限时才清。",
				kind: "percent",
				min: 0,
				max: 100,
				fallback: 90
			},
			{
				key: "autoPruneIntervalMs",
				label: "定时清理间隔",
				hint: "每次工具调用时顺路检查，超过这个间隔才真正清理一次。",
				kind: "duration",
				min: 6e4,
				fallback: 36e5
			},
			{
				key: "confirmFileCount",
				label: "单次删除条目数确认",
				hint: "一次删除超过这么多条就额外问一次。0 表示关闭。",
				kind: "number",
				min: 0,
				fallback: 5e3
			},
			{
				key: "confirmBytes",
				label: "单次删除大小确认",
				hint: "一次删除超过这么大就额外问一次。0 表示关闭。",
				kind: "bytes",
				min: 0,
				fallback: 2 * GIGABYTE
			}
		];
		/** 把值格式化成字节单位（GB/MB 取整，避免 20.000000001 GB 这种）。 */
		function toBytesInput(value) {
			if (value >= GB) {
				const amount = value / GB;
				return {
					amount: Number(amount.toFixed(2)).toString(),
					unit: "GB"
				};
			}
			const amount = Math.max(0, value / MB);
			return {
				amount: Number(amount.toFixed(2)).toString(),
				unit: "MB"
			};
		}
		/** 把毫秒格式化成小时（最小 1 分钟）。 */
		function toHoursInput(ms) {
			return Number((ms / 36e5).toFixed(2)).toString();
		}
		/** 读取一个数字字段的当前值（兼容 volatile 引用与普通值）。 */
		function numericOf(source, key, fallback) {
			const raw = source[key];
			const value = raw !== null && typeof raw === "object" && "get" in raw ? raw.get() : raw;
			return typeof value === "number" && Number.isFinite(value) ? value : fallback;
		}
		/**
		* 从 `describe()` 的返回里找出本命名空间的配置值。
		*
		* 形状随宿主版本可能不同（顶层数组 / `{namespaces}` / 直接对象），
		* 所以三种都认 —— 认不出就当成空对象，让界面显示默认值而不是崩掉。
		*/
		function pickNamespace(payload) {
			const dig = (node, depth) => {
				if (depth > 4 || node === null || typeof node !== "object") return void 0;
				const record = node;
				if (Array.isArray(record.namespaces)) {
					const found = record.namespaces.find((item) => item !== null && typeof item === "object" && item.name === NAMESPACE);
					if (found !== void 0) {
						const value = found.value;
						return value !== null && typeof value === "object" ? value : {};
					}
				}
				if (record.name === NAMESPACE && record.value !== null && typeof record.value === "object") return record.value;
				for (const value of Object.values(record)) {
					const deeper = dig(value, depth + 1);
					if (deeper !== void 0) return deeper;
				}
			};
			return dig(payload, 0) ?? {};
		}
		/** 表单组件。 */
		function SafeZoneSettings() {
			const [values, setValues] = (0, react.useState)({});
			const [status, setStatus] = (0, react.useState)("loading");
			const [message, setMessage] = (0, react.useState)("");
			const [saving, setSaving] = (0, react.useState)(false);
			const [saved, setSaved] = (0, react.useState)(false);
			const [errors, setErrors] = (0, react.useState)({});
			const remote = (0, react.useMemo)(() => {
				return globalThis.__dshSafeDeleteCtx?.remote?.settings;
			}, []);
			(0, react.useEffect)(() => {
				let alive = true;
				const load = async () => {
					if (remote?.describe === void 0) {
						if (alive) {
							setStatus("error");
							setMessage("这个宿主没有暴露设置接口，配置请改用 cordis.patch.yml。");
						}
						return;
					}
					try {
						const payload = await remote.describe();
						if (!alive) return;
						setValues(pickNamespace(payload));
						setStatus("ready");
					} catch (error) {
						if (!alive) return;
						setStatus("error");
						setMessage(error instanceof Error ? error.message : String(error));
					}
				};
				load();
				return () => {
					alive = false;
				};
			}, [remote]);
			const setField = (0, react.useCallback)((key, raw) => {
				setValues((prev) => ({
					...prev,
					[`${key}.draft`]: raw
				}));
				setSaved(false);
				setErrors((prev) => {
					const next = { ...prev };
					delete next[key];
					return next;
				});
			}, []);
			/** 校验并转成实际值；返回 undefined 表示不合法。 */
			const coerce = (0, react.useCallback)((spec, raw) => {
				const text = typeof raw === "string" ? raw.trim() : String(raw ?? "");
				if (text === "") return spec.min === 0 ? 0 : void 0;
				const amount = Number(text);
				if (!Number.isFinite(amount) || amount < 0) return void 0;
				if (spec.min !== void 0 && amount < spec.min) return void 0;
				if (spec.max !== void 0 && amount > spec.max) return void 0;
				if (spec.kind === "bytes") {
					const unit = values[`${spec.key}.unit`] === "MB" ? MB : GB;
					return Math.round(amount * unit);
				}
				if (spec.kind === "duration") return Math.round(amount * 60 * 60 * 1e3);
				return amount;
			}, [values]);
			const save = (0, react.useCallback)(async () => {
				if (remote?.mutate === void 0) return;
				const nextErrors = {};
				const payload = {};
				for (const spec of FIELDS) {
					const draft = values[`${spec.key}.draft`];
					if (typeof draft === "string") {
						const value = coerce(spec, draft);
						if (value === void 0) {
							nextErrors[spec.key] = "填一个不小于下限的数字";
							continue;
						}
						payload[spec.key] = value;
						continue;
					}
					const current = numericOf(values, spec.key, spec.fallback);
					payload[spec.key] = current;
				}
				setErrors(nextErrors);
				if (Object.keys(nextErrors).length > 0) {
					setMessage("有字段不合法，没有保存。");
					return;
				}
				setSaving(true);
				setMessage("");
				try {
					await remote.mutate({
						name: NAMESPACE,
						value: payload
					});
					setSaved(true);
					setMessage("已保存。重启 DSH 生效。");
				} catch (error) {
					setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					setSaving(false);
				}
			}, [
				coerce,
				remote,
				values
			]);
			if (status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { padding: "12px 0" },
				children: "正在读取配置…"
			});
			if (status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					padding: "12px 0",
					opacity: .8
				},
				children: message
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "14px",
					padding: "4px 0"
				},
				children: [FIELDS.map((spec) => {
					const draft = values[`${spec.key}.draft`];
					const current = numericOf(values, spec.key, spec.fallback);
					let display;
					let unit = "";
					if (typeof draft === "string") display = draft;
					else if (spec.kind === "bytes") display = toBytesInput(current).amount;
					else if (spec.kind === "duration") display = toHoursInput(current);
					else display = String(current);
					if (spec.kind === "bytes") unit = toBytesInput(current).unit;
					else if (spec.kind === "duration") unit = "小时";
					else if (spec.kind === "percent") unit = "%";
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: "4px"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									display: "flex",
									alignItems: "baseline",
									gap: "8px",
									flexWrap: "wrap"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { fontWeight: 500 },
										children: spec.label
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										"aria-label": spec.label,
										value: display,
										onChange: (event) => setField(spec.key, event.target.value),
										inputMode: "decimal",
										style: {
											width: "96px",
											padding: "4px 8px",
											borderRadius: "6px",
											border: `1px solid ${errors[spec.key] === void 0 ? "var(--dsw-alias-border-secondary, #c9d1e0)" : "var(--dsw-alias-state-error-primary, #d33)"}`,
											background: "transparent",
											color: "inherit",
											font: "inherit"
										}
									}),
									spec.kind === "bytes" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										"aria-label": `${spec.label}单位`,
										value: values[`${spec.key}.unit`] === "MB" ? "MB" : "GB",
										onChange: (event) => setField(`${spec.key}.unit`, event.target.value),
										style: {
											padding: "4px 6px",
											borderRadius: "6px",
											border: "1px solid var(--dsw-alias-border-secondary, #c9d1e0)",
											background: "transparent",
											color: "inherit",
											font: "inherit"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "GB",
											children: "GB"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "MB",
											children: "MB"
										})]
									}) : unit !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { opacity: .7 },
										children: unit
									}) : null
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: "12px",
									opacity: .65
								},
								children: spec.hint
							}),
							errors[spec.key] !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: "12px",
									color: "var(--dsw-alias-state-error-primary, #d33)"
								},
								children: errors[spec.key]
							}) : null
						]
					}, spec.key);
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: "12px",
						marginTop: "4px"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => void save(),
						disabled: saving,
						style: {
							padding: "6px 16px",
							borderRadius: "8px",
							border: "none",
							cursor: saving ? "default" : "pointer",
							background: "var(--dsw-alias-interactive-bg-primary, #3355ff)",
							color: "#fff",
							font: "inherit",
							opacity: saving ? .6 : 1
						},
						children: saving ? "保存中…" : "保存"
					}), message !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							fontSize: "12px",
							opacity: .8
						},
						"aria-live": "polite",
						children: [saved ? "✓ " : "", message]
					}) : null]
				})]
			});
		}
		/** 客户端插件入口。 */
		const inject = [
			"slots",
			"locale",
			"remote.settings"
		];
		/**
		* 注册表单到插件页。
		*
		* 每一步单独兜住：`apply` 里任何一处抛错都会让宿主把整个客户端包判为「激活失败」，
		* 表现是插件页里什么都没有、控制台只有一行。分开捕获后，失败的那一步会被指出来，
		* 其余照常。
		*/
		function apply(ctx) {
			try {
				globalThis.__dshSafeDeleteCtx = ctx;
			} catch {}
			try {
				ctx.slots?.inject?.("plugins.row.config", () => {
					ctx.slots?.register?.({
						name: "plugins.row.config",
						key: `${NAMESPACE}#safe-zone`,
						locale: NAMESPACE
					}, ({ view }) => view === "summary" ? "安全区设置" : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SafeZoneSettings, {}));
				});
			} catch (error) {
				console.warn("[dsh-safe-delete] 注册设置表单失败", error);
			}
		}
		//#endregion
		exports.SafeZoneSettings = SafeZoneSettings;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
