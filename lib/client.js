window.__ModuleLoader__.load({
	id: "dsh-safe-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region locale/en.json
		var en_default = {
			meta: {
				"title": "Safe delete (dsh-safe-delete)",
				"description": "Reversible deletion for DeepSeek Harness: the default safe-zone mode keeps entries until expiry, then hands them to the system recycle bin; recycle-bin mode sends them directly to the system recycle bin. Whether the second layer remains recoverable depends on system policy.",
				"detail": "docs/DETAIL.md"
			},
			settingsTitle: "Safe-zone settings",
			settingsSummary: "Safe-zone settings",
			restartNotice: "Restart DSH for changes to take effect.",
			loading: "Reading settings…",
			remoteUnavailable: "This host does not expose the settings API (remote.settings is unavailable). Configure the plugin in cordis.patch.yml instead.",
			readFailed: "Could not read settings: {error}",
			noConfig: "No settings were read for this plugin (defaults are shown). If you just installed it, restart DSH and check again.",
			save: "Save",
			saving: "Saving…",
			saveUnavailable: "This host does not expose the settings API, so changes cannot be saved. Configure the plugin in cordis.patch.yml instead.",
			saveFailed: "Save failed: {error}",
			hostRejected: "The host rejected this save",
			invalidFields: "Some fields are invalid. Nothing was saved.",
			invalidNumber: "Enter a number at or above the minimum",
			savedRestart: "Saved. Restart DSH for changes to take effect.",
			savedWithNewer: "Saved. Edits made during the save are still pending. Restart DSH for changes to take effect.",
			saveUnconfirmed: "The save was submitted, but the host still reads the old value. Restart DSH and check again.",
			retentionDaysLabel: "Safe-zone retention days",
			retentionDaysHint: "Expired entries move to the system recycle bin automatically. At least 1 day.",
			confirmFileCountLabel: "Confirm deletion item count",
			confirmFileCountHint: "Ask once when a deletion exceeds this count. 0 disables the check.",
			confirmBytesLabel: "Delete size confirmation",
			confirmBytesHint: "Ask once when a deletion exceeds this size. 0 disables the check.",
			bytesUnitLabel: "{label} unit",
			destinationLabel: "Delete destination",
			destinationHint: "Safe zone: restore inside the plugin (large directories are slower). Recycle Bin: faster, but oversized-deletion confirmation is skipped and recovery uses the system Recycle Bin.",
			destinationSafeZone: "Move to safe zone",
			destinationRecycleBin: "Send directly to Recycle Bin",
			cleanNow: "Clear safe zone now",
			cleanHint: "Move every safe-zone entry to the system recycle bin.",
			cleanConfirmPrompt: "Clear the entire safe zone?",
			cleanConfirm: "Confirm clear",
			cleaning: "Clearing…",
			cancel: "Cancel",
			cleanUnavailable: "This host does not expose the settings API, so cleanup cannot be triggered.",
			cleanFailed: "Cleanup request failed: {error}",
			cleanSubmitted: "Cleanup requested: safe-zone entries are moving to the system recycle bin. The plugin will reload once; refresh shortly to see the result."
		};
		//#endregion
		//#region locale/zh.json
		var zh_default = {
			meta: {
				"title": "安全删除 (dsh-safe-delete)",
				"description": "DSH 删除的撤销层：默认安全区模式保留到期后移入系统回收站，回收站模式则直接进入系统回收站；第二层能否取回取决于系统策略。",
				"detail": "docs/DETAIL.md"
			},
			settingsTitle: "安全区设置",
			settingsSummary: "安全区设置",
			restartNotice: "保存后需重启 DSH 生效。",
			loading: "正在读取配置…",
			remoteUnavailable: "这个宿主没有暴露设置接口（remote.settings 不可用），配置请改用 cordis.patch.yml。",
			readFailed: "读取配置失败：{error}",
			noConfig: "没有读到本插件的配置（显示的是默认值）。若刚安装，重启 DSH 后再看。",
			save: "保存",
			saving: "保存中…",
			saveUnavailable: "这个宿主没有暴露设置接口，无法保存。配置请改用 cordis.patch.yml。",
			saveFailed: "保存失败：{error}",
			hostRejected: "宿主拒绝了这次保存",
			invalidFields: "有字段不合法，没有保存。",
			invalidNumber: "填一个不小于下限的数字",
			savedRestart: "已保存。重启 DSH 生效。",
			savedWithNewer: "已保存。保存期间还有新的修改尚未提交。重启 DSH 生效。",
			saveUnconfirmed: "已提交保存，但宿主回读到的仍是旧值。重启 DSH 后再确认。",
			retentionDaysLabel: "安全区保留天数",
			retentionDaysHint: "到期后自动移入系统回收站。至少 1 天。",
			confirmFileCountLabel: "单次删除条目数确认",
			confirmFileCountHint: "超过这个数量就先问一次。0 = 关闭。",
			confirmBytesLabel: "单次删除大小确认",
			confirmBytesHint: "超过这个大小就先问一次。0 = 关闭。",
			bytesUnitLabel: "{label}单位",
			destinationLabel: "删除去向",
			destinationHint: "放入安全区：可在插件内取回（大目录较慢）。直接进回收站：更快，但不再额外确认超大删除，取回要去系统回收站。",
			destinationSafeZone: "放入安全区",
			destinationRecycleBin: "直接进回收站",
			cleanNow: "立即清理安全区",
			cleanHint: "把安全区里的条目全部移入系统回收站。",
			cleanConfirmPrompt: "确定要清空安全区？",
			cleanConfirm: "确定清理",
			cleaning: "清理中…",
			cancel: "取消",
			cleanUnavailable: "这个宿主没有暴露设置接口，无法触发清理。",
			cleanFailed: "清理请求失败：{error}",
			cleanSubmitted: "已提交清理请求：安全区条目正在移入系统回收站。插件会重载一次，稍后刷新即可看到结果。"
		};
		//#endregion
		//#region src/client/index.tsx
		/**
		* 插件页里的「安全区设置」表单。
		*
		* ## 为什么放在插件页而不是设置页
		*
		* DSH 的插件页声明了 `plugins.bundle.config` 槽位，插件可以把自己的配置渲染在
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
		function dictionaryOf(resource) {
			return Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "meta" && typeof entry[1] === "string"));
		}
		const DICTIONARIES = {
			zh: dictionaryOf(zh_default),
			en: dictionaryOf(en_default)
		};
		/** 直接挂载（测试或非槽位调用）时的中文回退；真实槽位始终注入宿主 t。 */
		const defaultTranslate = (key, params) => {
			const template = DICTIONARIES.zh[key];
			if (params === void 0) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match);
		};
		/** 宿主侧设置的命名空间（= 插件在 profile 里的行 id）。 */
		const NAMESPACE = "dsh-safe-delete";
		/** 字节单位。 */
		const MB = 1048576;
		const GB = 1024 * MB;
		/**
		* 删除去向的单独控件。
		*
		* ## 为什么不放进 FIELDS（2026-11-04）
		*
		* 既有测试用 container.querySelector('button') 取「保存」按钮 —— 那是 DOM 里
		* 的第一个 button。把两个去向按钮放进 FIELDS，它们会排在保存按钮之前，
		* 测试就会点到「放入安全区」而不是「保存」。
		*
		* 单独渲染在保存按钮之后，既不动那些测试的前提，也让这组开关在视觉上
		* 紧邻「保存」，符合「点了立刻生效」的语义。
		*
		* ## hint 只写"选了会怎样"，不写设计取舍（2026-11-06）
		*
		* 设置页不是设计文档。原来这段写了两句权衡（会统计大小、大目录慢、卡片不显示
		* 总大小、超大删除不再额外确认…），用户明确要求"主要保留操作说明"。
		*
		* 现在保留的只有**用户需要据此做选择**的信息：文件去哪儿、从哪儿取回。
		* 速度差异保留一句极短的括注，因为它会让用户看到可感知的行为差异；
		* 至于"为什么这样设计"，README 的删除去向一节有完整说明。
		*/
		const DESTINATION_FIELD = {
			key: "deleteDestination",
			label: "destinationLabel",
			hint: "destinationHint",
			kind: "choice",
			options: [{
				value: "safe-zone",
				label: "destinationSafeZone"
			}, {
				value: "recycle-bin",
				label: "destinationRecycleBin"
			}],
			fallback: 0
		};
		/**
		* 表单字段。
		*
		* ## 三项
		*
		* 1. 保留天数（整数天）
		* 2. 单次删除条目数确认
		* 3. 单次删除大小确认
		*
		* 容量相关的三个参数（`maxBytes` / `pruneAtPercent` / `autoPruneIntervalMs`）
		* 已经从产品和配置里移除：安全区只按保留期清理，到点把条目交给系统回收站。
		*
		* `stateDir`、`blockShellDeletes` 这类也不放表单：前者改动风险高（换目录等于让
		* 现有安全区「消失」），后者属于核心安全语义（关掉拦截）。
		*/
		const FIELDS = [
			{
				key: "retentionDays",
				label: "retentionDaysLabel",
				hint: "retentionDaysHint",
				kind: "number",
				min: 1,
				max: 365,
				fallback: 1
			},
			{
				key: "confirmFileCount",
				label: "confirmFileCountLabel",
				hint: "confirmFileCountHint",
				kind: "number",
				min: 0,
				fallback: 5e3
			},
			{
				key: "confirmBytes",
				label: "confirmBytesLabel",
				hint: "confirmBytesHint",
				kind: "bytes",
				min: 0,
				fallback: 2 * GB
			}
		];
		/** 没有 ConfigForm 时 useSyncExternalStore 的稳定空快照。 */
		const EMPTY_FORM_SNAPSHOT = {
			status: "loading",
			value: void 0,
			revision: void 0,
			writable: false
		};
		function emptySubscribe() {
			return () => {};
		}
		/** 合并外部快照时只覆盖宿主字段，本地草稿和显示单位继续归用户所有。 */
		function mergeExternalSnapshot(previous, next) {
			const merged = { ...next };
			for (const [key, value] of Object.entries(previous)) if (key.endsWith(".draft") || key.endsWith(".unit")) merged[key] = value;
			return merged;
		}
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
		function unwrapRemote(result, rejectedText = DICTIONARIES.zh.hostRejected) {
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
					error: typeof error === "string" ? error : error !== null && typeof error === "object" && typeof error.message === "string" ? `${String(error.code ?? "")} ${error.message}`.trim() : rejectedText
				};
			}
			return {
				ok: true,
				value: result
			};
		}
		/**
		* 宿主 settings remote 的持有者。
		*
		* ## 为什么不能直接读 `ctx.remote`
		*
		* cordis 对服务访问有守卫：`ctx.remote` 属于「需要 inject 声明才能访问」的路径，
		* 没有声明就抛 `cannot get property "remote" without inject`。而 `remote.*` 又
		* **不能**写进顶层 `inject`（那样会让整个客户端包停在 pending，apply 永不执行）——
		* 两头都是死路。
		*
		* 绕开守卫的正确做法：在 `apply` 阶段把 remote 取出来存进模块变量，
		* 组件从这里读。`apply` 里访问是安全的（那是插件的激活上下文），
		* 组件渲染时只是读一个普通变量。
		*/
		let settingsRemote;
		/** `forms.get(NAMESPACE)` 的稳定控制器；由 apply 在注册槽位前保存。 */
		let settingsForm;
		function asConfigForm(value) {
			if (value === null || typeof value !== "object") return void 0;
			const candidate = value;
			if (typeof candidate.getSnapshot !== "function" || typeof candidate.subscribe !== "function" || typeof candidate.mutate !== "function") return void 0;
			return candidate;
		}
		/**
		* 注入 remote（**仅测试用**）。
		*
		* 为什么需要它：组件通过模块变量拿 remote，`apply` 才能在真实宿主里填这个值。
		* 但测试里没有宿主，没有这个入口就无法把组件挂到真实 DOM 上驱动交互 ——
		* 而「只测纯函数、不测交互」正是「单位选了存不进去」连续两版没被发现的原因。
		*
		* @param remote 假的 settings remote。
		*/
		/** 测试与诊断用本地化读取；生产渲染使用宿主传入的 t。 */
		function __translateForTest(locale, key) {
			return DICTIONARIES[locale][key];
		}
		/** 表单字段的只读视图（测试用：断言控件类型与候选项）。 */
		function __fieldsForTest() {
			return FIELDS;
		}
		/** 删除去向控件（测试用）。 */
		function __destinationFieldForTest() {
			return DESTINATION_FIELD;
		}
		function __setRemoteForTest(remote) {
			settingsRemote = remote;
		}
		/** 注入共享 ConfigForm（仅测试用；生产路径由 apply 捕获 forms.get）。 */
		function __setConfigFormForTest(form) {
			settingsForm = asConfigForm(form);
		}
		/**
		* 表单组件里取 remote。
		*
		* @returns 宿主提供的 settings remote；不可用时 `undefined`。
		*/
		function currentRemote() {
			return settingsRemote;
		}
		/** @returns 当前共享 ConfigForm；不可用时 undefined。 */
		function currentForm() {
			return settingsForm;
		}
		/** 表单组件。 */
		function SafeZoneSettings({ t = defaultTranslate } = {}) {
			const [values, setValues] = (0, react.useState)({});
			const [status, setStatus] = (0, react.useState)("loading");
			const [message, setMessage] = (0, react.useState)("");
			const [saving, setSaving] = (0, react.useState)(false);
			const [saved, setSaved] = (0, react.useState)(false);
			const [errors, setErrors] = (0, react.useState)({});
			/** 「立即清理」进行中：防止连点产生多个重载。 */
			const [cleaning, setCleaning] = (0, react.useState)(false);
			/** 「立即清理」已进入二次确认态：第一次点击只到这里。 */
			const [confirmingClean, setConfirmingClean] = (0, react.useState)(false);
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
			/**
			* 最新的表单状态（`values` 的镜像）。
			*
			* ## 为什么需要它（定版复核第 3 项实测）
			*
			* `save` 里有 `await`（mutate + describe 两次往返）。`await` 之后，
			* 闭包里的 `values` 仍是**保存开始时**的快照 —— 用户在这期间的输入
			* 不在里面。用它判断"是否还有未提交的编辑"永远得到 false。
			*
			* ref 每帧更新，`await` 之后读到的就是用户此刻的输入。
			*/
			const valuesRef = (0, react.useRef)({});
			const remote = currentRemote();
			valuesRef.current = values;
			const form = currentForm();
			const subscribeForm = (0, react.useCallback)((listener) => form?.subscribe(listener) ?? emptySubscribe(), [form]);
			const getFormSnapshot = (0, react.useCallback)(() => form?.getSnapshot() ?? EMPTY_FORM_SNAPSHOT, [form]);
			const formSnapshot = (0, react.useSyncExternalStore)(subscribeForm, getFormSnapshot, getFormSnapshot);
			(0, react.useEffect)(() => {
				if (form === void 0) return;
				if (formSnapshot.status === "loading") {
					setStatus("loading");
					return;
				}
				setStatus("ready");
				setRevision(formSnapshot.revision);
				if (formSnapshot.value === void 0) {
					setMessage(t("noConfig"));
					return;
				}
				setValues((previous) => mergeExternalSnapshot(previous, formSnapshot.value));
				if (Object.keys(formSnapshot.value).length === 0) setMessage(t("noConfig"));
			}, [
				form,
				formSnapshot,
				t
			]);
			/** 保存后读取同一控制器的最新快照；旧宿主回退路径仍使用 settings remote。 */
			const readActiveView = (0, react.useCallback)(async (remote) => {
				if (form !== void 0) {
					const snapshot = form.getSnapshot();
					return {
						value: snapshot.value ?? {},
						revision: snapshot.revision
					};
				}
				if (remote?.describe === void 0) return void 0;
				const refreshed = unwrapRemote(await remote.describe(), t("hostRejected"));
				return refreshed.ok ? pickNamespace(refreshed.value) : void 0;
			}, [form, t]);
			(0, react.useEffect)(() => {
				if (form !== void 0) return;
				let alive = true;
				const load = async () => {
					let resolved = currentRemote();
					for (let i = 0; i < 20 && resolved === void 0 && alive; i += 1) {
						await new Promise((resolve) => {
							setTimeout(resolve, 100);
						});
						resolved = currentRemote();
					}
					if (!alive) return;
					if (resolved?.describe === void 0) {
						setStatus("error");
						setMessage(t("remoteUnavailable"));
						return;
					}
					try {
						const raw = await resolved.describe();
						if (!alive) return;
						const unwrapped = unwrapRemote(raw, t("hostRejected"));
						const payload = unwrapped.ok ? unwrapped.value : void 0;
						if (!unwrapped.ok) {
							setStatus("error");
							setMessage(t("readFailed", { error: unwrapped.error }));
							return;
						}
						const view = pickNamespace(payload);
						setValues(view.value);
						setRevision(view.revision);
						const namespaceSeen = Object.keys(view.value).length > 0;
						setStatus("ready");
						if (!namespaceSeen) setMessage(t("noConfig"));
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
			}, [
				remote,
				form,
				t
			]);
			const setField = (0, react.useCallback)((key, raw) => {
				setValues((prev) => {
					const next = {
						...prev,
						[`${key}.draft`]: raw
					};
					valuesRef.current = next;
					return next;
				});
				setSaved(false);
				setErrors((prev) => {
					const next = { ...prev };
					delete next[key];
					return next;
				});
			}, []);
			/**
			* 设置某个字段的单位（`MB`/`GB`）。
			*
			* **不能复用 `setField`**：它会把 key 拼成 `<key>.draft`，于是写进去的是
			* `key.unit.draft`，而读取时查的是 `values[key.unit]` —— 单位选择永远读不到
			* 刚选的值，表现为「选了天、保存后还是小时」。
			*
			* @param key 字段名（不含单位后缀）。
			* @param unit 单位字面量。
			*/
			const setFieldUnit = (0, react.useCallback)((key, unit) => {
				setValues((prev) => ({
					...prev,
					[`${key}.unit`]: unit
				}));
				setSaved(false);
			}, []);
			/**
			* 校验并转成实际值；返回 undefined 表示不合法。
			*
			* ## 顺序至关重要
			*
			* 必须**先换算成字节/毫秒，再和 min/max 比较**。反过来的话，`min`/`max` 是
			* 以毫秒计的（如 60000），而用户填的是显示单位下的数字（如 2 天）——
			* 2 < 60000，于是任何正常输入都被判定非法，保存永远失败，界面只给一句
			* 「填一个不小于下限的数字」。这正是「定时清理间隔写不进去」的根因。
			*
			* @param spec 字段。
			* @param raw 输入框里的原始文本（显示单位下的数字）。
			* @returns 换算后的字节或整数；不合法时 undefined。
			*/
			const coerce = (0, react.useCallback)((spec, raw) => {
				const text = typeof raw === "string" ? raw.trim() : String(raw ?? "");
				if (text === "") return spec.min === 0 ? 0 : void 0;
				const amount = Number(text);
				if (!Number.isFinite(amount) || amount < 0) return void 0;
				let value;
				if (spec.kind === "bytes") {
					const chosenBytesUnit = values[`${spec.key}.unit`];
					const currentBytes = numericOf(values, spec.key, spec.fallback);
					const bytesUnit = chosenBytesUnit === "MB" || chosenBytesUnit === "GB" ? chosenBytesUnit : naturalBytesUnit(currentBytes);
					value = Math.round(amount * (bytesUnit === "MB" ? MB : GB));
				} else value = Math.round(amount);
				if (spec.min !== void 0 && value < spec.min) return void 0;
				if (spec.max !== void 0 && value > spec.max) return void 0;
				if (spec.kind === "bytes" && value !== 0 && value < MB) return void 0;
				return value;
			}, [values]);
			/**
			* 取某个字段**当前显示在输入框里的数值**（不含单位）。
			*
			* 用途：用户只切换了单位、没改数字时，保存要用「显示单位的数字」重新换算。
			* 直接拿 `values[key]`（字节/毫秒）会绕错方向。
			*
			* @param spec 字段。
			* @param source 当前 values。
			* @returns 输入框里应显示的数字字符串。
			*/
			function displayValueOf(spec, source) {
				const current = numericOf(source, spec.key, spec.fallback);
				if (spec.kind === "bytes") return toBytesInput(current).amount;
				return String(current);
			}
			/**
			* bytes 字段的**自然单位** —— 与 `toBytesInput` 的决策保持一致。
			*
			* 保存侧在没有显式单位时用它兜底，避免"显示 MB、保存按 GB"的静默放大。
			*
			* @param bytes 字节数。
			* @returns `'MB'` 或 `'GB'`。
			*/
			function naturalBytesUnit(bytes) {
				return bytes >= GB ? "GB" : "MB";
			}
			const mutateSettings = (0, react.useCallback)(async (remote, ops) => {
				if (form !== void 0) return form.mutate(ops, revision);
				const result = await remote.mutate(NAMESPACE, ops, revision);
				const reply = unwrapRemote(result, t("hostRejected"));
				if (reply.ok) {
					const ack = reply.value;
					if (ack !== null && typeof ack === "object" && "revision" in ack && typeof ack.revision === "number") setRevision(ack.revision);
				} else if (reply.error.includes("settings/conflict") && remote.describe !== void 0) try {
					const snapshot = unwrapRemote(await remote.describe(), t("hostRejected"));
					if (snapshot.ok) {
						const view = pickNamespace(snapshot.value);
						if (view.revision !== void 0) {
							setRevision(view.revision);
							setValues((prev) => {
								const merged = { ...view.value };
								for (const spec of FIELDS) {
									const draftKey = `${spec.key}.draft`;
									const unitKey = `${spec.key}.unit`;
									const draft = prev[draftKey];
									const unit = prev[unitKey];
									if (typeof draft === "string") merged[draftKey] = draft;
									if (typeof unit === "string") merged[unitKey] = unit;
									else if (typeof draft === "string" && spec.kind === "bytes") merged[unitKey] = naturalBytesUnit(numericOf(prev, spec.key, spec.fallback));
								}
								return merged;
							});
						}
					}
				} catch {}
				return result;
			}, [
				form,
				revision,
				t
			]);
			const save = (0, react.useCallback)(async () => {
				if (form?.mutate === void 0 && remote?.mutate === void 0) return;
				const submittedDrafts = {};
				const submittedUnits = {};
				for (const spec of FIELDS) {
					const d = values[`${spec.key}.draft`];
					if (typeof d === "string") submittedDrafts[spec.key] = d;
					if (spec.kind === "bytes") {
						const explicit = values[`${spec.key}.unit`];
						const currentBytes = numericOf(values, spec.key, spec.fallback);
						submittedUnits[spec.key] = explicit === "MB" || explicit === "GB" ? explicit : naturalBytesUnit(currentBytes);
					} else {
						const u = values[`${spec.key}.unit`];
						if (typeof u === "string") submittedUnits[spec.key] = u;
					}
				}
				const nextErrors = {};
				const payload = {};
				for (const spec of FIELDS) {
					const draft = values[`${spec.key}.draft`];
					const unitChanged = typeof values[`${spec.key}.unit`] === "string";
					if (typeof draft === "string" || unitChanged && spec.kind === "bytes") {
						const displayValue = typeof draft === "string" ? draft : displayValueOf(spec, values);
						const value = coerce(spec, displayValue);
						if (value === void 0) {
							nextErrors[spec.key] = t("invalidNumber");
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
					setMessage(t("invalidFields"));
					return;
				}
				if (savingRef.current) return;
				savingRef.current = true;
				setSaving(true);
				setMessage("");
				try {
					const activeRemote = currentRemote();
					if (form === void 0 && activeRemote?.mutate === void 0) {
						setMessage(t("saveUnavailable"));
						return;
					}
					const ops = Object.entries(payload).map(([key, value]) => ({
						op: "set",
						path: [key],
						value
					}));
					const result = await mutateSettings(activeRemote ?? {}, ops);
					const unwrapped = form === void 0 ? unwrapRemote(result, t("hostRejected")) : result === true ? {
						ok: true,
						value: result
					} : {
						ok: false,
						error: t("hostRejected")
					};
					if (!unwrapped.ok) {
						setMessage(t("saveFailed", { error: unwrapped.error }));
						return;
					}
					try {
						const view = await readActiveView(activeRemote);
						if (view !== void 0) {
							setRevision((prev) => view.revision === void 0 ? prev : Math.max(prev ?? view.revision, view.revision));
							if (Object.keys(payload).length > 0 && Object.entries(payload).every(([key, expected]) => {
								const actual = view.value[key];
								return typeof actual === "number" && typeof expected === "number" ? actual === expected : actual === expected;
							})) {
								const liveValues = valuesRef.current;
								const hasNewerEdit = Object.entries(submittedDrafts).some(([fieldKey, submitted]) => {
									const live = liveValues[`${fieldKey}.draft`];
									return typeof live === "string" && live !== submitted;
								});
								const hasNewerUnit = Object.entries(submittedUnits).some(([fieldKey, submitted]) => {
									const live = liveValues[`${fieldKey}.unit`];
									return typeof live === "string" && live !== submitted;
								});
								setValues((prev) => {
									const merged = { ...Object.fromEntries(Object.entries(view.value).filter(([key]) => !key.endsWith(".draft"))) };
									for (const [key, value] of Object.entries(prev)) {
										if (key.endsWith(".draft")) {
											const fieldKey = key.slice(0, -6);
											const submitted = submittedDrafts[fieldKey];
											if (typeof value === "string" && value !== submitted) merged[key] = value;
											continue;
										}
										if (key.endsWith(".unit")) {
											const fieldKey = key.slice(0, -5);
											const submittedUnit = submittedUnits[fieldKey];
											const liveDraft = prev[`${fieldKey}.draft`];
											const submittedDraft = submittedDrafts[fieldKey];
											if (typeof value === "string" && value !== submittedUnit || typeof liveDraft === "string" && liveDraft !== submittedDraft) merged[key] = value;
											continue;
										}
									}
									for (const spec of FIELDS) {
										if (spec.kind !== "bytes") continue;
										const draftKey = `${spec.key}.draft`;
										const unitKey = `${spec.key}.unit`;
										const liveDraft = prev[draftKey];
										const submittedDraft = submittedDrafts[spec.key];
										if (typeof liveDraft !== "string" || liveDraft === submittedDraft) continue;
										const alreadyMerged = merged[unitKey];
										if (alreadyMerged === "MB" || alreadyMerged === "GB") continue;
										const submittedUnit = submittedUnits[spec.key];
										if (submittedUnit === void 0) continue;
										merged[unitKey] = submittedUnit;
									}
									return merged;
								});
								setMessage(hasNewerEdit || hasNewerUnit ? t("savedWithNewer") : t("savedRestart"));
							} else setMessage(t("saveUnconfirmed"));
						}
					} catch {}
					setSaved(true);
				} catch (error) {
					setMessage(t("saveFailed", { error: error instanceof Error ? error.message : String(error) }));
				} finally {
					savingRef.current = false;
					setSaving(false);
				}
			}, [
				coerce,
				form,
				readActiveView,
				remote,
				revision,
				t,
				values,
				mutateSettings
			]);
			/**
			* 是否有未保存的改动。
			*
			* 判据是「有没有草稿」而不是「草稿和已存值是否相等」：草稿只在用户真的动过
			* 某个输入框时才存在（`setField` 才写它），敲进去又改回原值仍是"动过"——
			* 这时显示保存按钮无害，而漏显示会导致用户的修改没有入口提交。
			*
			* **也要看单位**：只把「小时」切成「天」、数值没动，同样是一次真实修改
			* （它改变了最终要保存的毫秒数）。只看数值草稿会漏掉这一类，表现是
			* 「改了单位但保存按钮不出现」。
			*/
			const dirty = (0, react.useMemo)(() => FIELDS.some((spec) => typeof values[`${spec.key}.draft`] === "string" || typeof values[`${spec.key}.unit`] === "string"), [values]);
			/**
			* 进入「立即清理」的二次确认态。
			*
			* 8 秒后自动退回：避免用户点了第一下就走开，下次回来看到的是「确定清理」，
			* 一不留神就真清了。
			*/
			const armClean = (0, react.useCallback)(() => {
				setConfirmingClean(true);
				setMessage("");
				setTimeout(() => setConfirmingClean(false), 8e3);
			}, []);
			/**
			* `choice` 控件：点一下就把选中的值写进配置。
			*
			* 与「保存」按钮的区别：这是**单一枚举值**，没有草稿可编辑，立刻生效比
			* 让用户再点一次保存更直接。写失败时把原因显示出来，不要静默吞掉。
			*/
			const chooseValue = (0, react.useCallback)(async (key, value) => {
				const remote = currentRemote();
				if (form?.mutate === void 0 && remote?.mutate === void 0) {
					setMessage(t("saveUnavailable"));
					return;
				}
				if (savingRef.current) return;
				savingRef.current = true;
				setSaving(true);
				setMessage("");
				setSaved(false);
				try {
					const result = await mutateSettings(remote ?? {}, [{
						op: "set",
						path: [key],
						value
					}]);
					const unwrapped = form === void 0 ? unwrapRemote(result, t("hostRejected")) : result === true ? {
						ok: true,
						value: result
					} : {
						ok: false,
						error: t("hostRejected")
					};
					if (!unwrapped.ok) {
						setMessage(t("saveFailed", { error: unwrapped.error }));
						return;
					}
					try {
						const view = await readActiveView(remote);
						if (view?.revision !== void 0) {
							const next = view.revision;
							setRevision((prev) => Math.max(prev ?? next, next));
						}
					} catch {}
					setValues((prev) => ({
						...prev,
						[key]: value
					}));
					setMessage(t("savedRestart"));
					setSaved(true);
				} catch (error) {
					setMessage(t("saveFailed", { error: error instanceof Error ? error.message : String(error) }));
				} finally {
					savingRef.current = false;
					setSaving(false);
				}
			}, [
				form,
				readActiveView,
				t,
				mutateSettings
			]);
			/**
			* 渲染一个 `choice` 字段：并排按钮，点了立刻写配置。
			*
			* 抽成函数是因为它要在**保存按钮之后**再渲染一次（见 `DESTINATION_FIELD`
			* 的注释：放进 FIELDS 会把 `querySelector('button')` 指到错的位置）。
			*/
			const renderChoiceField = (spec) => {
				const chosenValue = String(values[spec.key] ?? "");
				const selected = spec.options?.some((o) => o.value === chosenValue) ? chosenValue : spec.options?.[0]?.value ?? "";
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "grid",
						gridTemplateColumns: "150px minmax(0, 1fr)",
						columnGap: "16px",
						rowGap: "6px",
						alignItems: "start"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontSize: "13px",
							lineHeight: "1.4"
						},
						children: t(spec.label)
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: "6px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								display: "flex",
								gap: "8px"
							},
							children: (spec.options ?? []).map((option) => {
								const active = option.value === selected;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									disabled: saving || cleaning,
									onClick: () => void chooseValue(spec.key, option.value),
									style: {
										padding: "6px 14px",
										fontSize: "13px",
										cursor: active ? "default" : "pointer",
										borderRadius: "6px",
										border: "1px solid var(--dsw-alias-border-primary, #ccc)",
										background: active ? "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #3355ff))" : "transparent",
										color: active ? "#fff" : "inherit",
										fontWeight: active ? 600 : 400
									},
									children: t(option.label)
								}, option.value);
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: "12px",
								opacity: .7,
								lineHeight: "1.5"
							},
							children: t(spec.hint)
						})]
					})]
				}, spec.key);
			};
			/**
			* 「立即清理」：把安全区条目全部移入系统回收站。
			*
			* ## 实现方式
			*
			* 配置页没有"跑清理"的调用接口，所以借用宿主的**配置变更 → HMR 重载插件**通道：
			* 把当前时间戳写进 `cleanRequestedAt`，插件重载时 `apply` 重跑、发现新时间戳就清理。
			*
			* 因此这里要做的只是**写一个数字**，真正的清理在宿主侧发生。
			*/
			const runClean = (0, react.useCallback)(async () => {
				const activeRemote = currentRemote();
				if (form?.mutate === void 0 && activeRemote?.mutate === void 0) {
					setMessage(t("cleanUnavailable"));
					return;
				}
				if (savingRef.current) return;
				savingRef.current = true;
				setCleaning(true);
				setMessage("");
				setSaved(false);
				try {
					const result = await mutateSettings(activeRemote ?? {}, [{
						op: "set",
						path: ["cleanRequestedAt"],
						value: Date.now()
					}]);
					const unwrapped = form === void 0 ? unwrapRemote(result, t("hostRejected")) : result === true ? {
						ok: true,
						value: result
					} : {
						ok: false,
						error: t("hostRejected")
					};
					if (!unwrapped.ok) {
						setMessage(t("cleanFailed", { error: unwrapped.error }));
						return;
					}
					try {
						const view = await readActiveView(activeRemote);
						if (view?.revision !== void 0) {
							const next = view.revision;
							setRevision((prev) => Math.max(prev ?? next, next));
						}
					} catch {}
					setMessage(t("cleanSubmitted"));
					setSaved(true);
				} catch (error) {
					setMessage(t("cleanFailed", { error: error instanceof Error ? error.message : String(error) }));
				} finally {
					savingRef.current = false;
					setCleaning(false);
					setConfirmingClean(false);
				}
			}, [
				cleaning,
				form,
				readActiveView,
				revision,
				t,
				mutateSettings
			]);
			/**
			* 状态卡片：加载中/出错也用同一套容器，避免布局跳动。 */
			const statusCard = (body) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
				style: {
					border: "1px solid var(--dsw-alias-border-l3, #d6dde8)",
					borderRadius: "var(--dsw-radius-lg, 12px)",
					background: "var(--dsw-alias-bg-layer-2, transparent)",
					padding: "16px 18px",
					display: "flex",
					flexDirection: "column",
					gap: "10px"
				},
				children: body
			});
			if (status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { padding: "4px 0" },
				children: statusCard(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: "4px"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontWeight: 600,
							fontSize: "14px"
						},
						children: t("settingsTitle")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontSize: "12px",
							color: "var(--dsw-alias-label-caption, #8a94a6)"
						},
						children: t("loading")
					})]
				}))
			});
			if (status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { padding: "4px 0" },
				children: statusCard(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: "4px"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontWeight: 600,
							fontSize: "14px"
						},
						children: t("settingsTitle")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontSize: "12px",
							lineHeight: "1.6",
							color: "var(--dsw-alias-label-secondary, #5c6779)"
						},
						children: message
					})]
				}))
			});
			/** 共享的输入框样式：贴合宿主设计 token，而不是裸默认样式。 */
			const fieldStyle = (invalid) => ({
				width: "108px",
				height: "32px",
				padding: "0 10px",
				borderRadius: "var(--dsw-radius-md, 8px)",
				border: `1px solid ${invalid ? "var(--dsw-alias-state-error-primary, #d33)" : "var(--dsw-alias-border-l2, #c9d1e0)"}`,
				background: "var(--dsw-alias-bg-layer-1, transparent)",
				color: "var(--dsw-alias-label-primary, inherit)",
				font: "inherit",
				outline: "none",
				boxSizing: "border-box"
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "12px",
					padding: "4px 0"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: {
							border: "1px solid var(--dsw-alias-border-l3, #d6dde8)",
							borderRadius: "var(--dsw-radius-lg, 12px)",
							background: "var(--dsw-alias-bg-layer-2, transparent)",
							padding: "14px 16px",
							display: "flex",
							flexDirection: "column",
							gap: "12px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: "3px"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontWeight: 600,
									fontSize: "13px",
									color: "var(--dsw-alias-label-primary, inherit)"
								},
								children: t("settingsTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: "12px",
									lineHeight: "1.45",
									color: "var(--dsw-alias-label-caption, #8a94a6)"
								},
								children: t("restartNotice")
							})]
						}), FIELDS.map((spec) => {
							const draft = values[`${spec.key}.draft`];
							const current = numericOf(values, spec.key, spec.fallback);
							let display;
							if (typeof draft === "string") display = draft;
							else if (spec.kind === "bytes") display = toBytesInput(current).amount;
							else display = String(current);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "grid",
									gridTemplateColumns: "150px minmax(0, 1fr)",
									columnGap: "16px",
									rowGap: "4px",
									alignItems: "center"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: `dsd-${spec.key}`,
										style: {
											fontSize: "13px",
											color: "var(--dsw-alias-label-primary, inherit)",
											lineHeight: "1.4"
										},
										children: t(spec.label)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: "8px",
											flexWrap: "wrap"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											id: `dsd-${spec.key}`,
											"aria-label": t(spec.label),
											"aria-invalid": errors[spec.key] !== void 0,
											value: display,
											onChange: (event) => setField(spec.key, event.target.value),
											inputMode: "decimal",
											style: fieldStyle(errors[spec.key] !== void 0)
										}), spec.kind === "bytes" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											"aria-label": t("bytesUnitLabel", { label: t(spec.label) }),
											value: values[`${spec.key}.unit`] === "MB" || values[`${spec.key}.unit`] === "GB" ? values[`${spec.key}.unit`] : naturalBytesUnit(current),
											onChange: (event) => setFieldUnit(spec.key, event.target.value),
											style: {
												...fieldStyle(false),
												width: "76px"
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "GB",
												children: "GB"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "MB",
												children: "MB"
											})]
										}) : null]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											gridColumn: "2",
											fontSize: "12px",
											lineHeight: "1.45",
											color: "var(--dsw-alias-label-caption, #8a94a6)",
											marginTop: "1px"
										},
										children: t(spec.hint)
									}),
									errors[spec.key] !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											gridColumn: "2",
											fontSize: "12px",
											color: "var(--dsw-alias-state-error-primary, #d33)"
										},
										children: errors[spec.key]
									}) : null
								]
							}, spec.key);
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: "10px",
							flexWrap: "wrap"
						},
						children: [dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => void save(),
							disabled: saving,
							style: {
								padding: "6px 18px",
								borderRadius: "var(--dsw-radius-md, 8px)",
								border: "none",
								cursor: saving ? "default" : "pointer",
								background: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #3355ff))",
								color: "var(--dsw-alias-label-primary-foreground, #fff)",
								font: "inherit",
								fontSize: "13px",
								fontWeight: 500,
								opacity: saving ? .6 : 1
							},
							children: saving ? t("saving") : t("save")
						}) : null, message !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							"aria-live": "polite",
							style: {
								fontSize: "12px",
								color: saved ? "var(--dsw-alias-state-success-primary, #1a7f37)" : "var(--dsw-alias-label-secondary, #5c6779)"
							},
							children: [saved ? "✓ " : "", message]
						}) : null]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: "10px"
						},
						children: renderChoiceField(DESTINATION_FIELD)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							borderTop: "1px solid var(--dsw-alias-border-l2, #d9dee8)",
							paddingTop: "12px",
							display: "flex",
							flexDirection: "column",
							gap: "6px"
						},
						children: [confirmingClean ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: "8px",
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-live": "polite",
									style: {
										fontSize: "13px",
										fontWeight: 500,
										color: "var(--dsw-alias-state-warn-primary, #b45309)"
									},
									children: t("cleanConfirmPrompt")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => void runClean(),
									disabled: cleaning,
									style: {
										padding: "6px 16px",
										borderRadius: "var(--dsw-radius-md, 8px)",
										border: "none",
										cursor: cleaning ? "default" : "pointer",
										background: "var(--dsw-alias-state-error-primary, #d33)",
										color: "#fff",
										font: "inherit",
										fontSize: "13px",
										fontWeight: 500,
										opacity: cleaning ? .6 : 1
									},
									children: cleaning ? t("cleaning") : t("cleanConfirm")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => setConfirmingClean(false),
									disabled: cleaning,
									style: {
										padding: "6px 16px",
										borderRadius: "var(--dsw-radius-md, 8px)",
										border: "1px solid var(--dsw-alias-border-l3, #d6dde8)",
										cursor: cleaning ? "default" : "pointer",
										background: "transparent",
										color: "var(--dsw-alias-label-primary, inherit)",
										font: "inherit",
										fontSize: "13px",
										opacity: cleaning ? .6 : 1
									},
									children: t("cancel")
								})
							]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => armClean(),
							disabled: status !== "ready" || cleaning,
							style: {
								alignSelf: "flex-start",
								padding: "6px 18px",
								borderRadius: "var(--dsw-radius-md, 8px)",
								border: "1px solid var(--dsw-alias-border-l3, #d6dde8)",
								cursor: status !== "ready" || cleaning ? "default" : "pointer",
								background: "transparent",
								color: "var(--dsw-alias-label-primary, inherit)",
								font: "inherit",
								fontSize: "13px",
								opacity: status !== "ready" || cleaning ? .55 : 1
							},
							children: t("cleanNow")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: "12px",
								lineHeight: "1.45",
								color: "var(--dsw-alias-label-caption, #8a94a6)"
							},
							children: t("cleanHint")
						})]
					})
				]
			});
		}
		/** 客户端插件入口。 */
		/**
		* 客户端插件入口。
		*
		* ## inject 该写什么（这一条被误解过三次，代价很大）
		*
		* cordis 的服务访问有守卫（`ReflectService.handler.get`），规则是：
		*
		*   1. 属性在 ctx 代理目标上存在            → 直接返回；
		*   2. 否则沿 fiber 链找 `fiber.store[prop]`  → 找到则返回；
		*   3. `prop in fiber.inject` 且服务未就绪  → `cannot get required service "x" in inactive context`；
		*   4. 其余                                 → `cannot get property "x" without inject`。
		*
		* 第 3、4 条是两种不同的病：3 说明**声明了但服务没到**，4 说明**根本没声明**。
		* 而声明了宿主不提供的服务，会让 fiber 停在 `FIBER_PENDING`，`apply` 永不执行。
		*
		* ## remote 与 remote.settings 是两个独立服务
		*
		* 客户端 api-gateway 里：
		*   - `super(ctx, "remote")`                      —— 顶层 Remote 服务；
		*   - `super(ctx, remoteServiceKey(name))`        —— 每个命名空间一个，`remote.<ns>`。
		*
		* 所以 `ctx.remote.settings` 的求值要**先**通过 `remote` 的守卫，**再**取 `settings`。
		* 只声明 `remote.settings` 时，`ctx.remote` 这一步就抛 `without inject` —— 这正是
		* 0.2.12 的诊断里看到的那条。
		*
		* 官方 `dsh-client-ui-settings-general` 因此**两个都声明**：
		*   ['slots','locale','connection','remote','remote.settings','configForms',…]
		*
		* ## 为什么顶层只留 slots / locale
		*
		* 顶层 inject 缺一个服务，整个插件停在 `FIBER_PENDING`，`apply` 永不执行 ——
		* 代价是整个界面消失。而 `ctx.inject(services, cb)` 内部是
		* `this.plugin({ inject: services, apply: cb })`，创建的是**子插件**：
		* 子 fiber 有独立的 inject 列表，缺服务只让那个子插件停住，其余步骤照常。
		*
		* 所以能晚取的都晚取：`configForms` 与 `remote.settings` 都走 `ctx.inject`。
		* 顶层只留宿主一定提供的 `slots`、`locale`。
		*
		* ## 一处易错点：`remote` 与 `remote.settings` 是**两个服务**
		*
		* 客户端 api-gateway 里 `super(ctx, "remote")` 与
		* `super(ctx, remoteServiceKey(ns))` 各注册一个。`ctx.remote.settings` 是
		* 两步属性求值，所以 `ctx.inject` 必须**两个都请求**，只写后者会在第一步
		* 就抛 `cannot get property "remote" without inject`。
		*/
		const inject = ["slots", "locale"];
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
			guarded("register locale dictionaries", () => {
				const locale = ctx.locale;
				if (typeof locale?.register !== "function") {
					console.error("[dsh-safe-delete] locale.register is unavailable; slot labels may not resolve.");
					return;
				}
				const register = () => {
					locale.register?.(NAMESPACE, DICTIONARIES);
				};
				if (typeof ctx.effect === "function") ctx.effect(register, "dsh-safe-delete: dictionaries");
				else register();
			});
			guarded("capture the settings remote for the form", () => {
				const maybeInject = ctx.inject;
				if (typeof maybeInject !== "function") {
					console.error("[dsh-safe-delete] ctx.inject is unavailable; settings remote was not captured.");
					return;
				}
				maybeInject(["remote", "remote.settings"], (scoped) => {
					try {
						settingsRemote = scoped.remote?.settings;
					} catch (error) {
						console.error("[dsh-safe-delete] settings remote capture failed:", error);
					}
				});
			});
			guarded("register the config page on the plugin page", () => {
				const injectFn = ctx.inject;
				if (typeof injectFn !== "function") {
					console.error("[dsh-safe-delete] ctx.inject is unavailable; the settings form was not registered.");
					return;
				}
				injectFn(["configForms"], (scoped) => {
					const service = scoped;
					const forms = service.configForms;
					if (forms?.get === void 0 || forms.whileServed === void 0) {
						console.error("[dsh-safe-delete] configForms service is missing get()/whileServed(); the settings form will not appear.");
						return;
					}
					try {
						settingsForm = asConfigForm(forms.get(NAMESPACE));
					} catch (error) {
						settingsForm = void 0;
						console.error(`[dsh-safe-delete] configForms.get("${NAMESPACE}") threw:`, error);
					}
					const slots = service.slots ?? ctx.slots;
					const attach = () => {
						const slot = slots?.register?.({
							name: "plugins.bundle.config",
							key: NAMESPACE,
							locale: NAMESPACE
						}, ({ t, view }) => {
							if (view === "summary") return t("settingsSummary");
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SafeZoneSettings, { t });
						});
						console.info("[dsh-safe-delete] registered plugins.bundle.config");
						return slot;
					};
					const runWhileServed = () => forms.whileServed?.([NAMESPACE], () => slots?.inject?.("plugins.bundle.config", attach));
					const effect = service.effect ?? ctx.effect;
					if (typeof effect === "function") effect(runWhileServed, "dsh-safe-delete: plugins-page card");
					else runWhileServed();
				});
			});
		}
		//#endregion
		exports.SafeZoneSettings = SafeZoneSettings;
		exports.__destinationFieldForTest = __destinationFieldForTest;
		exports.__fieldsForTest = __fieldsForTest;
		exports.__setConfigFormForTest = __setConfigFormForTest;
		exports.__setRemoteForTest = __setRemoteForTest;
		exports.__translateForTest = __translateForTest;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
