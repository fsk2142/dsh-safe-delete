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
		function pickNamespace(payload) {
			const empty = {
				value: {},
				revision: void 0
			};
			const fromEntry = (entry) => {
				if (entry === null || typeof entry !== "object") return void 0;
				const record = entry;
				if ((typeof record["ns"] === "string" ? record["ns"] : record["id"]) !== NAMESPACE) return void 0;
				const value = record["value"];
				return {
					value: value !== null && typeof value === "object" ? value : {},
					revision: typeof record["revision"] === "number" ? record["revision"] : void 0
				};
			};
			if (Array.isArray(payload)) {
				for (const entry of payload) {
					const found = fromEntry(entry);
					if (found !== void 0) return found;
				}
				return empty;
			}
			if (payload !== null && typeof payload === "object") {
				const record = payload;
				if (Array.isArray(record["namespaces"])) {
					for (const entry of record["namespaces"]) {
						const found = fromEntry(entry);
						if (found !== void 0) return found;
					}
					return empty;
				}
				const direct = fromEntry(payload);
				if (direct !== void 0) return direct;
			}
			return empty;
		}
		/**
		* 拆宿主的远程信封。
		*
		* 宿主契约：**失败不 reject，而是 resolve 成 `{ ok: false, error }`**。
		* 不拆就会把一次被拒绝的保存当成成功 —— 用户以为存上了，实际没有。
		*/
		function unwrapRemote(result) {
			if (result === null || typeof result !== "object" || !("ok" in result)) return {
				ok: true,
				value: result
			};
			const envelope = result;
			if (envelope.ok === true) return {
				ok: true,
				value: envelope.value
			};
			if (envelope.ok === false) {
				const error = envelope.error;
				return {
					ok: false,
					error: typeof error === "string" ? error : error !== null && typeof error === "object" && typeof error.message === "string" ? `${String(error.code ?? "")} ${error.message}`.trim() : "宿主拒绝了这次保存"
				};
			}
			return {
				ok: true,
				value: result
			};
		}
		/** 表单组件。 */
		function SafeZoneSettings() {
			const [values, setValues] = (0, react.useState)({});
			const [status, setStatus] = (0, react.useState)("loading");
			const [message, setMessage] = (0, react.useState)("");
			const [saving, setSaving] = (0, react.useState)(false);
			const [saved, setSaved] = (0, react.useState)(false);
			const [errors, setErrors] = (0, react.useState)({});
			/** 读到的修订号：宿主的并发围栏，写入必须带上它。 */
			const [revision, setRevision] = (0, react.useState)(void 0);
			/**
			* 写入在途的**同步**守卫。
			*
			* 为什么不能只靠 `saving`：它是 state，同一帧里连点两次时两次都会读到
			* `saving === false`，于是发出两份写入 —— 第二份拿着过期修订号，会被宿主
			* 当作冲突拒绝，用户看到「刚改的又被改回去」。
			*/
			const savingRef = (0, react.useRef)(false);
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
						const view = pickNamespace(payload);
						setValues(view.value);
						setRevision(view.revision);
						const namespaceSeen = Object.keys(view.value).length > 0;
						setStatus("ready");
						if (!namespaceSeen) setMessage("没有读到本插件的配置（显示的是默认值）。若刚安装，重启 DSH 后再看。");
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
				if (savingRef.current) return;
				savingRef.current = true;
				setSaving(true);
				setMessage("");
				try {
					const ops = Object.entries(payload).map(([key, value]) => ({
						op: "set",
						path: [key],
						value
					}));
					const unwrapped = unwrapRemote(await remote.mutate(NAMESPACE, ops, revision));
					if (!unwrapped.ok) {
						setMessage(`保存失败：${unwrapped.error}`);
						return;
					}
					try {
						const refreshed = remote.describe === void 0 ? void 0 : await remote.describe();
						if (refreshed !== void 0) {
							const view = pickNamespace(refreshed);
							setRevision(view.revision);
							setValues(Object.fromEntries(Object.entries(view.value).filter(([key]) => !key.endsWith(".draft"))));
						}
					} catch {}
					setSaved(true);
					setMessage("已保存。重启 DSH 生效。");
				} catch (error) {
					setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					savingRef.current = false;
					setSaving(false);
				}
			}, [
				coerce,
				remote,
				revision,
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
			"remote.settings",
			"configForms"
		];
		/**
		* 注册表单到插件页。
		*
		* 每一步单独兜住：`apply` 里任何一处抛错都会让宿主把**整个客户端包**判为
		* 「激活失败」，表现是插件页里什么都没有、控制台只有一行。分开捕获后，
		* 失败的那一步会被指名道姓地打出来，其余步骤照常。
		*/
		function apply(ctx) {
			const guarded = (step, run) => {
				try {
					run();
				} catch (error) {
					console.error(`[dsh-safe-delete] ${step} failed:`, error);
				}
			};
			guarded("expose settings remote to the form", () => {
				globalThis.__dshSafeDeleteCtx = ctx;
			});
			guarded("register the config page on the plugin page", () => {
				ctx.inject?.(["configForms"], (scoped) => {
					const forms = scoped.configForms;
					if (forms?.get === void 0 || forms.whileServed === void 0) {
						console.error("[dsh-safe-delete] configForms service is missing get()/whileServed(); the settings form will not appear.");
						return;
					}
					try {
						forms.get(NAMESPACE);
					} catch (error) {
						console.error(`[dsh-safe-delete] configForms.get("${NAMESPACE}") threw:`, error);
					}
					forms.whileServed([NAMESPACE], () => {
						ctx.slots?.inject?.("plugins.bundle.config", () => {
							ctx.slots?.register?.({
								name: "plugins.bundle.config",
								key: NAMESPACE,
								locale: NAMESPACE
							}, ({ view }) => {
								if (view === "summary") return "安全区设置";
								return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SafeZoneSettings, {});
							});
						});
					});
				});
			});
		}
		//#endregion
		exports.SafeZoneSettings = SafeZoneSettings;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
