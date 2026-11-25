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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import en from '../../locale/en.json'
import zh from '../../locale/zh.json'

/** 宿主 t 的最小形状；参数只用于把运行时错误嵌进本地化模板。 */
type LocaleKey = Exclude<keyof typeof en, 'meta'>
type Translate = (key: LocaleKey, params?: Record<string, string>) => string

function dictionaryOf(resource: Record<string, unknown>): Record<LocaleKey, string> {
  return Object.fromEntries(
    Object.entries(resource)
      .filter((entry): entry is [string, string] => entry[0] !== 'meta' && typeof entry[1] === 'string'),
  ) as Record<LocaleKey, string>
}

const DICTIONARIES = { zh: dictionaryOf(zh), en: dictionaryOf(en) }

/** 直接挂载（测试或非槽位调用）时的中文回退；真实槽位始终注入宿主 t。 */
const defaultTranslate: Translate = (key, params) => {
  const template = DICTIONARIES.zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
}

/** 宿主侧设置的命名空间（= 插件在 profile 里的行 id）。 */
const NAMESPACE = 'dsh-safe-delete'

/** 字节单位。 */
const MB = 1024 * 1024
const GB = 1024 * MB

/** 一个可编辑字段的描述。 */
interface FieldSpec {
  key: string
  label: LocaleKey
  hint: LocaleKey
  /** 控件类型。 */
  kind: 'bytes' | 'number' | 'choice'
  /** 最小值（含）。 */
  min?: number
  max?: number
  /** 配置里读不到该字段时显示的兜底值（与宿主侧默认值保持一致）。 */
  fallback: number
  /**
   * `choice` 的候选项。
   *
   * 刻意做成**并排按钮**而不是下拉框：两种删除去向的取舍（速度 vs 统计）
   * 需要被看见。下拉框会把替代项折叠起来，用户就只看得到当前值。
   */
  options?: Array<{ value: string; label: LocaleKey }>
}

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
const DESTINATION_FIELD: FieldSpec = {
  key: 'deleteDestination',
  label: 'destinationLabel',
  hint: 'destinationHint',
  kind: 'choice',
  options: [
    { value: 'safe-zone', label: 'destinationSafeZone' },
    { value: 'recycle-bin', label: 'destinationRecycleBin' },
  ],
  fallback: 0,
}


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
const FIELDS: FieldSpec[] = [
  {
    key: 'retentionDays',
    label: 'retentionDaysLabel',
    /*
     * 只留"填什么 + 边界"，机制说明交给 README（2026-11-06）。
     * 原来的"到期移入系统回收站"是在设置页复述实现细节。
     */
    hint: 'retentionDaysHint',
    /*
     * 用 `number` 而不是新的 `'days'` 类型：天数本身就是整数、没有单位换算，
     * `number` 分支的渲染（`String(current)`）和写回（原值）正好合适。
     * 新加一种 kind 要改 9 处分支，没有必要。
     */
    kind: 'number',
    min: 1,
    max: 365,
    fallback: 1,
  },
  {
    key: 'confirmFileCount',
    label: 'confirmFileCountLabel',
    hint: 'confirmFileCountHint',
    kind: 'number',
    min: 0,
    fallback: 5000,
  },
  {
    key: 'confirmBytes',
    label: 'confirmBytesLabel',
    hint: 'confirmBytesHint',
    kind: 'bytes',
    min: 0,
    fallback: 2 * GB,
  },
]

/** 宿主 settings 远程面的最小形状（与宿主真实契约一致）。 */
interface SettingsRemote {
  /** 返回 `{ writable, hasDocument, namespaces }`；命名空间身份字段是 `ns`。 */
  describe?: () => Promise<unknown>
  /** `mutate(ns, ops, revision)`；ops 为 `{op:'set', path:[key], value}`。 */
  mutate?: (
    ns: string,
    ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
    revision?: number,
  ) => Promise<unknown>
}

/** `configForms.get()` 返回的同步快照（安装包 0.2.2-rc.5 契约）。 */
interface ConfigFormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown> | undefined
  revision: number | undefined
  writable: boolean
}

/** 本插件消费的 ConfigForm 面；服务持有控制器，组件只订阅自己的视图。 */
interface ConfigForm {
  getSnapshot(): ConfigFormSnapshot
  subscribe(listener: () => void): () => void
  mutate(
    ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
    expectedRevision?: number,
  ): Promise<boolean>
}

/** 没有 ConfigForm 时 useSyncExternalStore 的稳定空快照。 */
const EMPTY_FORM_SNAPSHOT: ConfigFormSnapshot = {
  status: 'loading', value: undefined, revision: undefined, writable: false,
}

function emptySubscribe(): () => void {
  return () => {}
}

/** 合并外部快照时只覆盖宿主字段，本地草稿和显示单位继续归用户所有。 */
function mergeExternalSnapshot(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...next }
  for (const [key, value] of Object.entries(previous)) {
    if (key.endsWith('.draft') || key.endsWith('.unit')) merged[key] = value
  }
  return merged
}

/** 客户端上下文的最小形状。 */
interface ClientContext {
  get?: (id: string) => unknown
  remote?: { settings?: SettingsRemote }
  slots?: {
    inject?: (name: string, factory: () => unknown) => void
    register?: (spec: Record<string, unknown>, component: unknown) => unknown
  }
  effect?: (fn: () => unknown, label?: string) => unknown
  /**
   * cordis 的服务注入：等服务就绪后再执行回调。
   *
   * 配置页必须走它 —— `configForms` 服务晚于 `apply` 就绪，直接在 `apply` 里
   * 注册槽位的话，宿主渲染时拿不到对应表单，「配置」入口不出现且不报错。
   */
  inject?: (services: string[], callback: (scoped: Record<string, unknown>) => void) => unknown
}

/** 把值格式化成字节单位（GB/MB 取整，避免 20.000000001 GB 这种）。 */
function toBytesInput(value: number): { amount: string; unit: 'MB' | 'GB' } {
  if (value >= GB) {
    const amount = value / GB
    return { amount: Number(amount.toFixed(2)).toString(), unit: 'GB' }
  }
  const amount = Math.max(0, value / MB)
  return { amount: Number(amount.toFixed(2)).toString(), unit: 'MB' }
}

/** 读取一个数字字段的当前值（兼容 volatile 引用与普通值）。 */
function numericOf(source: Record<string, unknown>, key: string, fallback: number): number {
  const raw = source[key]
  const value = raw !== null && typeof raw === 'object' && 'get' in (raw as object)
    ? (raw as { get: () => unknown }).get()
    : raw
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 从 `describe()` 的返回里取出本命名空间的视图。
 *
 * 宿主实际返回的是**一个对象**（不是裸数组）：
 * ```js
 * { writable, hasDocument, namespaces: [ { ns, schema, value, revision, … } ] }
 * ```
 * 注意名字空间的身份字段是 **`ns`**，不是 `name` / `id` —— 用错字段就永远匹配不上，
 * 表现是「页面显示不出设置」，且不报错。
 *
 * 兼容处理：裸数组、以及带 `ns` 的单个对象也认，认不出就返回空，让界面显示默认值。
 */
interface NamespaceView {
  value: Record<string, unknown>
  revision: number | undefined
}

function pickNamespace(payload: unknown): NamespaceView {
  const empty: NamespaceView = { value: {}, revision: undefined }

  const fromEntry = (entry: unknown): NamespaceView | undefined => {
    // 形状不可信：宿主返回的数组里可能混进 null 或非对象。直接读 `entry.ns`
    // 会抛 TypeError，而调用点在一个 effect 里 —— 一个坏元素就能让设置页永远
    // 停在「正在读取配置…」，且没有任何提示。先验形状，再读字段。
    if (entry === null || typeof entry !== 'object') return undefined
    const record = entry as Record<string, unknown>
    // 身份字段是 `ns`；`id` 是另一套（profile 行 id）。这里两者都认，
    // 因为本插件的包名、行 id 与命名空间恰好相同，用哪个都能命中。
    const name = typeof record['ns'] === 'string' ? record['ns'] : record['id']
    if (name !== NAMESPACE) return undefined
    const value = record['value']
    return {
      value: value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {},
      revision: typeof record['revision'] === 'number' ? record['revision'] : undefined,
    }
  }

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const found = fromEntry(entry)
      if (found !== undefined) return found
    }
    return empty
  }

  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (Array.isArray(record['namespaces'])) {
      for (const entry of record['namespaces']) {
        const found = fromEntry(entry)
        if (found !== undefined) return found
      }
      return empty
    }
    const direct = fromEntry(payload)
    if (direct !== undefined) return direct
  }

  return empty
}

/**
 * 拆宿主的远程信封。
 *
 * 宿主契约：**失败不 reject，而是 resolve 成 `{ ok: false, error }`**。
 * 不拆就会把一次被拒绝的保存当成成功 —— 用户以为存上了，实际没有。
 */
function unwrapRemote(
  result: unknown,
  rejectedText = DICTIONARIES.zh.hostRejected,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (result === null || typeof result !== 'object' || !('ok' in (result as object))) {
    return { ok: true, value: result }
  }
  const envelope = result as { ok?: unknown; value?: unknown; error?: unknown }
  if (envelope.ok === true) return { ok: true, value: envelope.value }
  if (envelope.ok === false) {
    const error = envelope.error
    const text =
      typeof error === 'string'
        ? error
        : error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
          ? `${String((error as { code?: unknown }).code ?? '')} ${(error as { message: string }).message}`.trim()
          : rejectedText
    return { ok: false, error: text }
  }
  return { ok: true, value: result }
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
let settingsRemote: SettingsRemote | undefined

/** `forms.get(NAMESPACE)` 的稳定控制器；由 apply 在注册槽位前保存。 */
let settingsForm: ConfigForm | undefined

function asConfigForm(value: unknown): ConfigForm | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<ConfigForm>
  if (
    typeof candidate.getSnapshot !== 'function'
    || typeof candidate.subscribe !== 'function'
    || typeof candidate.mutate !== 'function'
  ) return undefined
  return candidate as ConfigForm
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
export function __translateForTest(locale: 'zh' | 'en', key: LocaleKey): string {
  return DICTIONARIES[locale][key]
}

/** 表单字段的只读视图（测试用：断言控件类型与候选项）。 */
export function __fieldsForTest(): ReadonlyArray<FieldSpec> {
  return FIELDS
}

/** 删除去向控件（测试用）。 */
export function __destinationFieldForTest(): FieldSpec {
  return DESTINATION_FIELD
}

export function __setRemoteForTest(remote: SettingsRemote | undefined): void {
  settingsRemote = remote
}

/** 注入共享 ConfigForm（仅测试用；生产路径由 apply 捕获 forms.get）。 */
export function __setConfigFormForTest(form: unknown): void {
  settingsForm = asConfigForm(form)
}

/**
 * 表单组件里取 remote。
 *
 * @returns 宿主提供的 settings remote；不可用时 `undefined`。
 */
function currentRemote(): SettingsRemote | undefined {
  return settingsRemote
}

/** @returns 当前共享 ConfigForm；不可用时 undefined。 */
function currentForm(): ConfigForm | undefined {
  return settingsForm
}

/** 表单组件。 */
export function SafeZoneSettings({ t = defaultTranslate }: { t?: Translate } = {}): ReactElement {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  /** 「立即清理」进行中：防止连点产生多个重载。 */
  const [cleaning, setCleaning] = useState(false)
  /** 「立即清理」已进入二次确认态：第一次点击只到这里。 */
  const [confirmingClean, setConfirmingClean] = useState(false)
  /** 读到的修订号：宿主的并发围栏，写入必须带上它。 */
  const [revision, setRevision] = useState<number | undefined>(undefined)
  /**
   * 写入在途的**同步**守卫。
   *
   * 为什么不能只靠 `saving`：它是 state，同一帧里连点两次时两次都会读到
   * `saving === false`，于是发出两份写入 —— 第二份拿着过期修订号，会被宿主
   * 当作冲突拒绝，用户看到「刚改的又被改回去」。
   */
  const savingRef = useRef(false)

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
  const valuesRef = useRef<Record<string, unknown>>({})

  // remote 由 `apply` 里的 `ctx.inject(['remote.settings'], …)` 异步填入，
  // 可能在首次渲染之后才就绪。所以这里不用 `useMemo`（它只算一次），
  // 而是在 effect 里读，必要时短暂重试。
  const remote = currentRemote()

  /*
   * 每次渲染把最新的表单状态同步到 ref。
   *
   * `save` 里有 `await`，之后闭包里的 `values` 已经过期；提示与合并判断
   * 都要看"用户此刻的输入"，所以读这个 ref。
   */
  valuesRef.current = values

  /*
   * `plugins.bundle.config` 的 owner props 只有 `{ view: 'page' }`，不传 form。
   * 配置值必须从 apply 保存的 `forms.get(NAMESPACE)` 控制器读取：快照是同步的，
   * subscribe 才会让外部配置更新无需重挂载就进入表单。
   */
  const form = currentForm()
  const subscribeForm = useCallback(
    (listener: () => void) => form?.subscribe(listener) ?? emptySubscribe(),
    [form],
  )
  const getFormSnapshot = useCallback(
    () => form?.getSnapshot() ?? EMPTY_FORM_SNAPSHOT,
    [form],
  )
  const formSnapshot = useSyncExternalStore(subscribeForm, getFormSnapshot, getFormSnapshot)

  useEffect(() => {
    if (form === undefined) return
    if (formSnapshot.status === 'loading') {
      setStatus('loading')
      return
    }
    setStatus('ready')
    setRevision(formSnapshot.revision)
    if (formSnapshot.value === undefined) {
      setMessage(t('noConfig'))
      return
    }
    setValues((previous) => mergeExternalSnapshot(previous, formSnapshot.value!))
    if (Object.keys(formSnapshot.value).length === 0) {
      setMessage(t('noConfig'))
    }
  }, [form, formSnapshot, t])

  /** 保存后读取同一控制器的最新快照；旧宿主回退路径仍使用 settings remote。 */
  const readActiveView = useCallback(async (remote: SettingsRemote | undefined): Promise<NamespaceView | undefined> => {
    if (form !== undefined) {
      const snapshot = form.getSnapshot()
      return { value: snapshot.value ?? {}, revision: snapshot.revision }
    }
    if (remote?.describe === undefined) return undefined
    const refreshed = unwrapRemote(await remote.describe(), t('hostRejected'))
    return refreshed.ok ? pickNamespace(refreshed.value) : undefined
  }, [form, t])

  useEffect(() => {
    if (form !== undefined) return
    let alive = true
    const load = async (): Promise<void> => {
      // 等 remote 就绪（最多约 2 秒）。用轮询而不是订阅：宿主没有暴露
      // 「remote 可用」的通知，而这个等待只发生在打开配置页的那一次。
      let resolved = currentRemote()
      for (let i = 0; i < 20 && resolved === undefined && alive; i += 1) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
        resolved = currentRemote()
      }
      if (!alive) return

      if (resolved?.describe === undefined) {
        setStatus('error')
        setMessage(
          t('remoteUnavailable'),
        )
        return
      }
      try {
        const raw = await resolved.describe()
        if (!alive) return
        // **describe 也返回信封**：`{ ok: true, value: { writable, namespaces } }`。
        //
        // 这就是"写入成功、界面永远显示默认值"的根因：mutate 我拆了信封，
        // describe 没拆，于是 pickNamespace 在 `{ok,value}` 这一层找 `namespaces`
        // —— 永远找不到，界面只能回落到默认值。
        // 诊断截图里的 `host namespaces — empty list` 是直接证据。
        const unwrapped = unwrapRemote(raw, t('hostRejected'))
        const payload = unwrapped.ok ? unwrapped.value : undefined
        if (!unwrapped.ok) {
          setStatus('error')
          setMessage(t('readFailed', { error: unwrapped.error }))
          return
        }
        const view = pickNamespace(payload)
        setValues(view.value)
        setRevision(view.revision)
        // 「读到了但没这个命名空间」不等于「配置全空」——那是两种不同的病因。
        // 前者说明插件没装进 profile 或命名空间不匹配，后者只是还没改过配置。
        // 混为一谈会让人以为「配置丢了」，而实际什么都没发生。
        const namespaceSeen = Object.keys(view.value).length > 0
        setStatus('ready')
        if (!namespaceSeen) {
          setMessage(t('noConfig'))
        }
      } catch (error) {
        if (!alive) return
        setStatus('error')
        setMessage(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [remote, form, t])

  const setField = useCallback((key: string, raw: string): void => {
    // 用 `<key>.draft` 保存用户的原始输入：不要覆盖从配置读到的真实值，
    // 否则下一次渲染就没法再换算回显示单位了。
    setValues((prev) => {
      const next = { ...prev, [`${key}.draft`]: raw }
      /*
       * 同步镜像到 ref。
       *
       * `save` 里有 `await`，之后才判断"是否还有未提交的编辑"。那时闭包
       * 里的 `values` 是保存开始时的快照，看不到用户在等待期间的输入。
       *
       * 只靠渲染时同步（`valuesRef.current = values`）不够：输入事件与
       * 保存回填可能在同一批更新里，中间没有渲染。
       */
      valuesRef.current = next
      return next
    })
    setSaved(false)
    setErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

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
  const setFieldUnit = useCallback((key: string, unit: string): void => {
    setValues((prev) => ({ ...prev, [`${key}.unit`]: unit }))
    // 单位变了意味着「有未保存的改动」，与改数值同等对待。
    setSaved(false)
  }, [])

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
  const coerce = useCallback((spec: FieldSpec, raw: unknown): number | undefined => {
    const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '')
    if (text === '') return spec.min === 0 ? 0 : undefined
    const amount = Number(text)
    if (!Number.isFinite(amount) || amount < 0) return undefined

    // 第一步：把显示数值换算成真实单位（字节或整数）。
    let value: number
    if (spec.kind === 'bytes') {
      /*
       * ## 缺省单位必须与显示侧一致（2026-11-01 审查 SD-09）
       *
       * 第一版是 `values[key.unit] === 'MB' ? MB : GB` —— 没有单位时按 **GB**
       * 算。而显示侧 `toBytesInput` 按值的自然量级选单位：500 MB 显示成
       * "500"，保存时按 GB 解释 → **放大 1024 倍**。
       *
       * 现在缺省时用 `naturalBytesUnit(current)` —— 与显示侧同一个判定。
       * 用户显式切换过单位时仍以 `values` 为准。
       */
      const chosenBytesUnit = values[`${spec.key}.unit`]
      const currentBytes = numericOf(values, spec.key, spec.fallback)
      const bytesUnit =
        chosenBytesUnit === 'MB' || chosenBytesUnit === 'GB'
          ? chosenBytesUnit
          : naturalBytesUnit(currentBytes)
      value = Math.round(amount * (bytesUnit === 'MB' ? MB : GB))
    } else {
      /*
       * 纯数字字段（天数、条目数）一律取整。
       *
       * 天数的语义是整数天：写入 2.5 会让 `expiresAt` 落在半天后，而界面上
       * 显示的是「2.5 天」—— 用户以为设了 2 天半，实际行为也没错，但配置里
       * 存个小数的意义是零，不如在入口就取整。
       */
      value = Math.round(amount)
    }

    // 第二步：拿**换算后**的值和边界比较。
    if (spec.min !== undefined && value < spec.min) return undefined
    if (spec.max !== undefined && value > spec.max) return undefined
    /*
     * ## bytes 的额外下限：0 或 ≥1 MB（2026-11-01 审查 SD-22）
     *
     * `spec.min` 对 bytes 是 0（"0 表示关闭"），所以 0.5 MB 也能通过 ——
     * 而斜杠入口与 README 的契约是"0 或至少 1 MB"。
     *
     * 结果：同一份配置 UI 能存、斜杠拒绝，规则不一致；而小于 1 MB 的阈值
     * 几乎必然触发确认，等于制造审批噪音。
     *
     * 这里按契约拒绝：非 0 但小于 1 MB → 不合法。
     * 不能简单把 `min` 设成 MB —— 那会连 `0`（关闭）一起拒掉。
     */
    if (spec.kind === 'bytes' && value !== 0 && value < MB) return undefined
    return value
  }, [values])

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
  function displayValueOf(spec: FieldSpec, source: Record<string, unknown>): string {
    const current = numericOf(source, spec.key, spec.fallback)
    /*
     * ## bytes 必须返回**与单位匹配**的数值（2026-11-01 审查 SD-09）
     *
     * 第一版只返回 `toBytesInput(current).amount`，把 `unit` 丢掉了。
     * 而保存侧读的是 `values[`${key}.unit`]`，缺省时按 **GB** 算：
     *
     * ```
     * 配置 500 MB → 显示 "500"（unit 丢失）
     *            → 保存时按 GB 解释 → 500 GB，放大 1024 倍
     * ```
     *
     * 现在显示侧把 `unit` 一起写进 values，保存侧再按它换算。
     */
    if (spec.kind === 'bytes') return toBytesInput(current).amount
    return String(current)
  }

  /**
   * bytes 字段的**自然单位** —— 与 `toBytesInput` 的决策保持一致。
   *
   * 保存侧在没有显式单位时用它兜底，避免"显示 MB、保存按 GB"的静默放大。
   *
   * @param bytes 字节数。
   * @returns `'MB'` 或 `'GB'`。
   */
  function naturalBytesUnit(bytes: number): 'MB' | 'GB' {
    return bytes >= GB ? 'GB' : 'MB'
  }

  // All settings writers must advance the same namespace revision. A conflict
  // refreshes the token for an explicit retry; it never overwrites external edits.
  const mutateSettings = useCallback(async (
    remote: SettingsRemote,
    ops: Parameters<NonNullable<SettingsRemote['mutate']>>[1],
  ): Promise<unknown> => {
    if (form !== undefined) return form.mutate(ops, revision)
    const result = await remote.mutate!(NAMESPACE, ops, revision)
    const reply = unwrapRemote(result, t('hostRejected'))
    if (reply.ok) {
      const ack = reply.value
      if (ack !== null && typeof ack === 'object' && 'revision' in ack && typeof ack.revision === 'number') {
        setRevision(ack.revision)
      }
    } else if (reply.error.includes('settings/conflict') && remote.describe !== undefined) {
      try {
        const snapshot = unwrapRemote(await remote.describe(), t('hostRejected'))
        if (snapshot.ok) {
          const view = pickNamespace(snapshot.value)
          if (view.revision !== undefined) {
            setRevision(view.revision)
            // 重试会提交整张表单，修订号与未编辑字段必须来自同一份新快照。
            // 用户的草稿仍保留；字节草稿还要固定刷新前的有效单位。
            setValues((prev) => {
              const merged = { ...view.value }
              for (const spec of FIELDS) {
                const draftKey = `${spec.key}.draft`
                const unitKey = `${spec.key}.unit`
                const draft = prev[draftKey]
                const unit = prev[unitKey]
                if (typeof draft === 'string') merged[draftKey] = draft
                if (typeof unit === 'string') merged[unitKey] = unit
                else if (typeof draft === 'string' && spec.kind === 'bytes') {
                  merged[unitKey] = naturalBytesUnit(numericOf(prev, spec.key, spec.fallback))
                }
              }
              return merged
            })
          }
        }
      } catch { /* Retain the conflict and the user's draft when refresh fails. */ }
    }
    return result
  }, [form, revision, t])

  const save = useCallback(async (): Promise<void> => {
    if (form?.mutate === undefined && remote?.mutate === undefined) return
    /*
     * ## 提交快照（2026-11-01 定版复核第 3 项）
     *
     * 保存是异步的。要区分两种草稿：
     *
     *   - **本次提交的那个** —— 保存成功后必须清掉，否则它会与回读值配错；
     *   - **保存期间新编辑的** —— 必须保留。
     *
     * 第一版（我上一轮的 SD-15 修复）无差别保留所有草稿。于是：
     *
     * ```
     * 配置 500MB，显示 [500] [MB]
     * 数字改 1024 → 保存 → 正确写入 1GB
     * 回读把底值变成 1GB，但代码**保留了已提交的草稿 1024**
     * 自然单位随底值从 MB 变成 GB → 界面显示 [1024] [GB]
     * 不再编辑，再点保存 → 写入 1099511627776 = 1TB   ← 放大 1024 倍
     * ```
     *
     * 现在：这里记下每个字段**提交时**的显示值与单位。回填时只有与快照
     * **不同**的草稿才保留（那是用户在保存期间新编辑的）。
     */
    const submittedDrafts: Record<string, string> = {}
    const submittedUnits: Record<string, string> = {}
    for (const spec of FIELDS) {
      const d = values[`${spec.key}.draft`]
      if (typeof d === 'string') submittedDrafts[spec.key] = d
      /*
       * ## 记**有效**单位，不只是显式设置过的（2026-11-02 定版终审 F-02）
       *
       * 用户没手动切过单位时，`values[key.unit]` 不存在 —— 界面显示的是
       * **自然单位**（由底值推导）。上一版只记显式单位，于是隐式 MB 场景
       * 的 `submittedUnits` 是空的：
       *
       * ```
       * 500MB → 显示 500 MB（自然单位，values 里没有 .unit 键）
       * 在途改数字为 2048 → 回读底值 1GB
       * → 单位快照为空，draftKept 分支拿不到对比基准
       * → 单位被丢弃 → 变成 GB
       * ```
       *
       * 现在记"提交时界面实际显示的单位"：显式值的优先，否则按底值算自然单位。
       */
      if (spec.kind === 'bytes') {
        const explicit = values[`${spec.key}.unit`]
        const currentBytes = numericOf(values, spec.key, spec.fallback)
        submittedUnits[spec.key] =
          explicit === 'MB' || explicit === 'GB' ? explicit : naturalBytesUnit(currentBytes)
      } else {
        const u = values[`${spec.key}.unit`]
        if (typeof u === 'string') submittedUnits[spec.key] = u
      }
    }
    const nextErrors: Record<string, string> = {}
    const payload: Record<string, unknown> = {}
    for (const spec of FIELDS) {
      const draft = values[`${spec.key}.draft`]
      const unitChanged = typeof values[`${spec.key}.unit`] === 'string'
      if (typeof draft === 'string' || (unitChanged && spec.kind === 'bytes')) {
        // 用户改过**数值或单位**：把当前显示值换算成字节。
        //
        // 为什么单位变了也要走这条路：只切单位不改数值时，最终要保存的数**变了**
        // （1 GB → 1 MB）。走下面的"没改过"分支会把旧值原样写回，用户的单位
        // 选择被静默丢弃。
        const displayValue = typeof draft === 'string' ? draft : displayValueOf(spec, values)
        const value = coerce(spec, displayValue)
        if (value === undefined) {
          nextErrors[spec.key] = t('invalidNumber')
          continue
        }
        payload[spec.key] = value
        continue
      }
      // 没改过：`values[key]` 已经是配置里的真实值（字节或整数），原样写回。
      // 若也走 coerce，会被当成 GB 再乘一次 —— 直接放大 1073741824 倍。
      const current = numericOf(values, spec.key, spec.fallback)
      payload[spec.key] = current
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      setMessage(t('invalidFields'))
      return
    }

    // 同步守卫：同一帧内的第二次点击在这里被挡掉。
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setMessage('')
    try {
      const activeRemote = currentRemote()
      if (form === undefined && activeRemote?.mutate === undefined) {
        setMessage(t('saveUnavailable'))
        return
      }
      // 真实契约：`mutate(ns, ops, revision)`，ops 是 `{ op:'set', path:[key], value }`
      // 的数组，不是 `{ name, value }` 这种扁平形状。
      const ops = Object.entries(payload).map(([key, value]) => ({
        op: 'set' as const,
        path: [key],
        value,
      }))
      const result = await mutateSettings(activeRemote ?? {}, ops)
      // ConfigForm.mutate 返回 boolean；settings remote 返回 `{ ok, value/error }`。
      // 两条通道都必须把拒绝当作失败，不能把 false 当成成功信封。
      const unwrapped = form === undefined
        ? unwrapRemote(result, t('hostRejected'))
        : result === true
          ? { ok: true as const, value: result }
          : { ok: false as const, error: t('hostRejected') }
      if (!unwrapped.ok) {
        setMessage(t('saveFailed', { error: unwrapped.error }))
        return
      }
      // 成功后重新读一次，拿到新的修订号；否则连续两次保存会撞上自己上一次
      // 产生的修订号，第二次被当作冲突拒绝。
      // 保存成功后重新读一次，拿到新的修订号。
      //
      // ## 为什么不拿刷新结果直接覆盖界面
      //
      // 宿主的 `describe()` 在 mutate 之后**可能仍返回旧快照**（写盘成功但内存
      // 视图未刷新）。原来的代码无条件 `setValues(view.value)`，于是用户看到
      // 「点保存 → 值瞬间变回原来的」—— 明明保存成功了。
      //
      // 现在的规则：**只有当刷新读到的值确实包含我们刚写入的每一项时**，才用它
      // 覆盖界面；否则只更新 revision，保留用户眼前的输入。宁可显示"未确认"，
      // 也不要把用户刚改的值抹掉。
      try {
        const view = await readActiveView(activeRemote)
        if (view !== undefined) {
          setRevision((prev) => view.revision === undefined ? prev : Math.max(prev ?? view.revision, view.revision))
          const wroteSomething = Object.keys(payload).length > 0
          const confirmed =
            wroteSomething &&
            Object.entries(payload).every(([key, expected]) => {
              const actual = view.value[key]
              return typeof actual === 'number' && typeof expected === 'number'
                ? actual === expected
                : actual === expected
            })
          if (confirmed) {
            /*
             * ## 回填时不能覆盖用户正在输入的内容（2026-11-01 审查 SD-15）
             *
             * 第一版是 `setValues(回读值)` —— **整体替换**。保存是异步的
             * （要等 mutate + describe 往返），用户完全可能在这期间继续打字：
             *
             * ```
             * 用户改 A = 10，点保存
             *   → 请求在飞
             * 用户改 B = 20（此时还没返回）
             *   → 回填把 B 改回磁盘上的旧值
             * → 用户的第二次编辑**静默消失**
             * ```
             *
             * 现在：回填只影响"用户没在编辑的字段"。
             *
             * 判定"正在编辑"用 `.draft` 键 —— 那是输入框在用户改动后写入的
             * 草稿标记（见下面的渲染分支）。有草稿就保留草稿，没有才用回读值。
             *
             * 保存按钮此时是 disabled，但输入框不是 —— 保持输入可用是好的，
             * 前提是回填不踩它。
             */
            /*
             * ## 提示用**合并结果**判断，不依赖 updater 的执行时机
             *
             * 我试过两种在 updater 内部记录结果的方式（局部变量、ref），
             * 实测都不可靠：React 可能重放 updater（StrictMode、并发渲染），
             * 第二次的 `prev` 已经是合并后的值，记录就丢了。
             *
             * 改为在 `setValues` **之前**算：提交快照 vs **当前**表单状态。
             * 与提交快照不同即说明保存期间有新编辑。
             *
             * 必须读 `valuesRef.current` 而不是闭包里的 `values`：
             * 这里有 `await`（mutate + describe），`values` 在那时已经过期，
             * 看不到用户等待期间的输入。
             */
            const liveValues = valuesRef.current
            const hasNewerEdit = Object.entries(submittedDrafts).some(([fieldKey, submitted]) => {
              const live = liveValues[`${fieldKey}.draft`]
              return typeof live === 'string' && live !== submitted
            })
            const hasNewerUnit = Object.entries(submittedUnits).some(([fieldKey, submitted]) => {
              const live = liveValues[`${fieldKey}.unit`]
              return typeof live === 'string' && live !== submitted
            })

            setValues((prev) => {
              const fromServer = Object.fromEntries(
                Object.entries(view.value).filter(([key]) => !key.endsWith('.draft')),
              )
              const merged: Record<string, unknown> = { ...fromServer }
              /*
               * ## 只保留**保存期间新编辑**的草稿（定版复核第 3 项）
               *
               * 上一版无差别保留所有草稿 —— 已提交的那个也留着，于是它
               * 与回读后的新自然单位配错，界面显示 1024 GB，再存一次
               * 就写入 1 TB（放大 1024 倍）。
               *
               * 现在的判据：
               *   - 草稿与**提交时**的值相同 → 那是本次提交的，清掉
               *     （界面回到回读值 + 自然单位）；
               *   - 草稿不同 → 用户在保存期间改过，保留。
               */
              for (const [key, value] of Object.entries(prev)) {
                if (key.endsWith('.draft')) {
                  const fieldKey = key.slice(0, -'.draft'.length)
                  const submitted = submittedDrafts[fieldKey]
                  // 与提交时不同 → 用户新改了 → 保留。
                  if (typeof value === 'string' && value !== submitted) merged[key] = value
                  continue
                }
                if (key.endsWith('.unit')) {
                  const fieldKey = key.slice(0, -'.unit'.length)
                  const submittedUnit = submittedUnits[fieldKey]
                  const liveDraft = prev[`${fieldKey}.draft`]
                  const submittedDraft = submittedDrafts[fieldKey]
                  /*
                   * ## 单位必须跟着**新数字草稿**一起保留（2026-11-02 定版终审 F-02）
                   *
                   * 上一版只比较"单位是否与提交时不同"，两个反例：
                   *
                   * ```
                   * 明确选 MB，输入 1024，点保存
                   *   等待期间把数字改 2048，单位仍是 MB
                   *   → 数字草稿 2048 被保留（与提交时不同）
                   *   → 单位与提交时**相同**，于是被丢弃
                   *   → fallback 按回读底值 1GB 推导 → 界面变成 2048 GB
                   *   → 第二次保存写入 2 TB（用户本意 2 GB）
                   * ```
                   *
                   * 根因：把"数字"和"单位"当成两个独立判据。它们其实是同一个
                   * **快照** —— 显示值 = 数字 × 单位，丢掉单位，数字的含义就变了。
                   *
                   * 现在：只要该字段的新数字草稿被保留，它绑定的单位就一并保留，
                   * 无论单位本身是否变化。只有"没有在途新编辑"时才回到服务端
                   * 自然单位。
                   */
                  const draftKept =
                    typeof liveDraft === 'string' && liveDraft !== submittedDraft
                  const unitChanged = typeof value === 'string' && value !== submittedUnit
                  if (unitChanged || draftKept) merged[key] = value
                  continue
                }
              }
              /*
               * ## 隐式单位要**主动补写**（2026-11-02 定版终审 F-02）
               *
               * 上面的循环只遍历 `prev` 里**已存在**的键。用户没手动切过单位时
               * `prev` 没有 `<key>.unit`，于是"保留单位"这个决定无处落地 ——
               * 界面仍会按回读底值推导，隐式 MB 的场景照样变成 GB。
               *
               * 这里对每个 bytes 字段补一次：若它的新数字草稿被保留，
               * 就把提交时的有效单位显式写进去，把它钉住。
               */
              for (const spec of FIELDS) {
                if (spec.kind !== 'bytes') continue
                const draftKey = `${spec.key}.draft`
                const unitKey = `${spec.key}.unit`
                const liveDraft = prev[draftKey]
                const submittedDraft = submittedDrafts[spec.key]
                if (typeof liveDraft !== 'string' || liveDraft === submittedDraft) continue

                /*
                 * ## 只在**没有有效单位**时才补写（2026-11-02 定版验收，P1）
                 *
                 * 上一版这里无条件 `merged[unitKey] = submittedUnit`。
                 * 而上面的循环已经把"用户本次新选的单位"合并进 `merged` ——
                 * 于是这个补写会把它**覆盖回提交时的旧单位**：
                 *
                 * ```
                 * 初始 3GB，改成 5GB，点保存（请求在飞）
                 *   等待期间改成 2048 MB（数字和单位都改了）
                 *   回读后草稿 2048 保留 ✓
                 *   但补写循环把单位改回 GB ✗ → 显示 2048 GB
                 *   第二次保存写 2 TB（用户本意 2 GB）
                 * ```
                 *
                 * 这是我在修 F-02 时引入的**直接回归**；反向（在途 MB→GB）
                 * 同样会被改回旧 MB。
                 *
                 * 现在按优先级取：
                 *   1. `merged` 里已有有效单位（用户新选的）→ 不动；
                 *   2. 否则用提交时的有效单位（隐式单位场景）；
                 *   3. 都没有才留给服务端自然单位。
                 */
                const alreadyMerged = merged[unitKey]
                if (alreadyMerged === 'MB' || alreadyMerged === 'GB') continue

                const submittedUnit = submittedUnits[spec.key]
                if (submittedUnit === undefined) continue
                merged[unitKey] = submittedUnit
              }
              return merged
            })

            setMessage(
              hasNewerEdit || hasNewerUnit
                ? t('savedWithNewer')
                : t('savedRestart'),
            )
          } else {
            // 没读到新值：保留用户输入，并如实说明「已写入但未能回读确认」。
            setMessage(t('saveUnconfirmed'))
          }
        }
      } catch {
        /* 重新读取失败不影响「已保存」这个结论 */
      }
      setSaved(true)
    } catch (error) {
      setMessage(t('saveFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      // 两处都要复位：state 驱动按钮外观，ref 驱动同步守卫。
      savingRef.current = false
      setSaving(false)
    }
  }, [coerce, form, readActiveView, remote, revision, t, values, mutateSettings])

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
  const dirty = useMemo(
    () =>
      FIELDS.some(
        (spec) =>
          typeof values[`${spec.key}.draft`] === 'string' || typeof values[`${spec.key}.unit`] === 'string',
      ),
    [values],
  )

  /**
   * 进入「立即清理」的二次确认态。
   *
   * 8 秒后自动退回：避免用户点了第一下就走开，下次回来看到的是「确定清理」，
   * 一不留神就真清了。
   */
  const armClean = useCallback((): void => {
    setConfirmingClean(true)
    setMessage('')
    // 用 effect 里的定时器更严谨，但这里只是一个 UI 退避，直接 setTimeout 足够，
    // 且组件卸载后 setState 在 React 18+ 是空操作，不会告警。
    setTimeout(() => setConfirmingClean(false), 8000)
  }, [])

  /**
   * `choice` 控件：点一下就把选中的值写进配置。
   *
   * 与「保存」按钮的区别：这是**单一枚举值**，没有草稿可编辑，立刻生效比
   * 让用户再点一次保存更直接。写失败时把原因显示出来，不要静默吞掉。
   */
  const chooseValue = useCallback(
    async (key: string, value: string): Promise<void> => {
      const remote = currentRemote()
      if (form?.mutate === undefined && remote?.mutate === undefined) {
        setMessage(t('saveUnavailable'))
        return
      }
      if (savingRef.current) return
      savingRef.current = true
      setSaving(true)
      setMessage('')
      setSaved(false)
      try {
        const result = await mutateSettings(remote ?? {}, [{ op: 'set', path: [key], value }])
        const unwrapped = form === undefined
          ? unwrapRemote(result, t('hostRejected'))
          : result === true
            ? { ok: true as const, value: result }
            : { ok: false as const, error: t('hostRejected') }
        if (!unwrapped.ok) {
          setMessage(t('saveFailed', { error: unwrapped.error }))
          return
        }
        try {
          const view = await readActiveView(remote)
          if (view?.revision !== undefined) {
            const next = view.revision
            setRevision((prev) => Math.max(prev ?? next, next))
          }
        } catch {
          /* 刷新 revision 失败不影响这次写入 */
        }
        setValues((prev) => ({ ...prev, [key]: value }))
        setMessage(t('savedRestart'))
        setSaved(true)
      } catch (error) {
        setMessage(t('saveFailed', { error: error instanceof Error ? error.message : String(error) }))
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [form, readActiveView, t, mutateSettings],
  )


  /**
   * 渲染一个 `choice` 字段：并排按钮，点了立刻写配置。
   *
   * 抽成函数是因为它要在**保存按钮之后**再渲染一次（见 `DESTINATION_FIELD`
   * 的注释：放进 FIELDS 会把 `querySelector('button')` 指到错的位置）。
   */
  const renderChoiceField = (spec: FieldSpec) => {
    const chosenValue = String(values[spec.key] ?? '')
    const selected = spec.options?.some((o) => o.value === chosenValue)
      ? chosenValue
      : (spec.options?.[0]?.value ?? '')
    return (
      <div
        key={spec.key}
        style={{
          display: 'grid',
          gridTemplateColumns: '150px minmax(0, 1fr)',
          columnGap: '16px',
          rowGap: '6px',
          alignItems: 'start',
        }}
      >
        <span style={{ fontSize: '13px', lineHeight: '1.4' }}>{t(spec.label)}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            {(spec.options ?? []).map((option) => {
              const active = option.value === selected
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={saving || cleaning}
                  onClick={() => void chooseValue(spec.key, option.value)}
                  style={{
                    padding: '6px 14px',
                    fontSize: '13px',
                    cursor: active ? 'default' : 'pointer',
                    borderRadius: '6px',
                    border: '1px solid var(--dsw-alias-border-primary, #ccc)',
                    background: active
                      ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #3355ff))'
                      : 'transparent',
                    color: active ? '#fff' : 'inherit',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {t(option.label)}
                </button>
              )
            })}
          </div>
          <span style={{ fontSize: '12px', opacity: 0.7, lineHeight: '1.5' }}>{t(spec.hint)}</span>
        </div>
      </div>
    )
  }

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
  const runClean = useCallback(async (): Promise<void> => {
    const activeRemote = currentRemote()
    if (form?.mutate === undefined && activeRemote?.mutate === undefined) {
      setMessage(t('cleanUnavailable'))
      return
    }
    // 清理也写同一个命名空间：与保存/去向共用同步守卫，避免旧 revision 竞争。
    if (savingRef.current) return
    savingRef.current = true
    setCleaning(true)
    setMessage('')
    setSaved(false)
    try {
      // 用时间戳而不是布尔：连续两次点也能区分（同一个值写两次不会触发变更）。
      const stamp = Date.now()
      const result = await mutateSettings(activeRemote ?? {}, [{ op: 'set', path: ['cleanRequestedAt'], value: stamp }])
      const unwrapped = form === undefined
        ? unwrapRemote(result, t('hostRejected'))
        : result === true
          ? { ok: true as const, value: result }
          : { ok: false as const, error: t('hostRejected') }
      if (!unwrapped.ok) {
        setMessage(t('cleanFailed', { error: unwrapped.error }))
        return
      }
      // 刷新 revision，避免下一次保存撞上冲突。
      try {
        const view = await readActiveView(activeRemote)
        if (view?.revision !== undefined) {
          const next = view.revision
          setRevision((prev) => Math.max(prev ?? next, next))
        }
      } catch {
        /* revision 刷新失败不影响清理已触发 */
      }
      setMessage(t('cleanSubmitted'))
      setSaved(true)
    } catch (error) {
      setMessage(t('cleanFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      savingRef.current = false
      setCleaning(false)
      // 无论成功失败都退出确认态：成功了界面会随插件重载刷新，失败则让用户
      // 重新走一遍确认，而不是停在那里、再点一下就又发一次请求。
      setConfirmingClean(false)
    }
  }, [cleaning, form, readActiveView, revision, t, mutateSettings])

  /**
   * 状态卡片：加载中/出错也用同一套容器，避免布局跳动。 */
  const statusCard = (body: ReactElement): ReactElement => (
    <section
      style={{
        border: '1px solid var(--dsw-alias-border-l3, #d6dde8)',
        borderRadius: 'var(--dsw-radius-lg, 12px)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      {body}
    </section>
  )

  if (status === 'loading') {
    return (
      <div style={{ padding: '4px 0' }}>
        {statusCard(
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontWeight: 600, fontSize: '14px' }}>{t('settingsTitle')}</span>
            <span style={{ fontSize: '12px', color: 'var(--dsw-alias-label-caption, #8a94a6)' }}>
              {t('loading')}
            </span>
          </div>,
        )}
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div style={{ padding: '4px 0' }}>
        {statusCard(
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontWeight: 600, fontSize: '14px' }}>{t('settingsTitle')}</span>
            <span style={{ fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary, #5c6779)' }}>
              {message}
            </span>
          </div>,
        )}
      </div>
    )
  }

  /** 共享的输入框样式：贴合宿主设计 token，而不是裸默认样式。 */
  const fieldStyle = (invalid: boolean): Record<string, string> => ({
    width: '108px',
    // 固定高度：`<input>` 与 `<select>` 的默认内边距/行高不同，不锁高度时
    // 数字框与单位下拉的默认内边距/行高不同，锁高度避免一行高低不齐。
    height: '32px',
    padding: '0 10px',
    borderRadius: 'var(--dsw-radius-md, 8px)',
    border: `1px solid ${invalid ? 'var(--dsw-alias-state-error-primary, #d33)' : 'var(--dsw-alias-border-l2, #c9d1e0)'}`,
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    font: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0' }}>
      {/*
        诊断面板在 **ready 状态也要显示**。
        原来只放在 loading / error 分支里，于是最需要它的场景（"读到了但读的是空"、
        "保存成功但回读不到"）恰恰看不到 —— 那些都是 status='ready'。
      */}
      {/*
        **一张卡片装下所有设置，项与项之间没有分隔线。**

        形态：外层一个带描边+圆角+底色的卡片；里面是标题 + 各设置项，
        项间只用 12px 垂直间距分开 —— 就是普通设置页的样子。
        之前每项都带 border-bottom，视觉上是一排贯穿全宽的横杠。
      */}
      <section
        style={{
          border: '1px solid var(--dsw-alias-border-l3, #d6dde8)',
          borderRadius: 'var(--dsw-radius-lg, 12px)',
          background: 'var(--dsw-alias-bg-layer-2, transparent)',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' }}>
            {t('settingsTitle')}
          </span>
          <span style={{ fontSize: '12px', lineHeight: '1.45', color: 'var(--dsw-alias-label-caption, #8a94a6)' }}>
            {t('restartNotice')}
          </span>
        </div>

        {FIELDS.map((spec) => {
          // 显示值有两个来源，必须分清：
          //   - 用户正在输入的原始文本（`<key>.draft`）—— 原样显示，否则每敲一个
          //     字符就被换算一次，输入框会跳；
          //   - 从配置读到的**字节**值 —— 必须先换算成 GB/MB 再显示，
          //     否则用户会看到 `21474836480 GB` 这种东西。
          const draft = values[`${spec.key}.draft`]
          const current = numericOf(values, spec.key, spec.fallback)
          let display: string
          if (typeof draft === 'string') {
            display = draft
          } else if (spec.kind === 'bytes') {
            display = toBytesInput(current).amount
          } else {
            display = String(current)
          }

          /*
           * `choice`：并排按钮，点了立刻写配置。
           *
           * 不复用下面的数字输入管线（草稿、单位、换算那一套对枚举无意义），
           * 提前返回一个独立分支更简单，也不会碰到那些状态的边界。
           */
          return (
            <div
              key={spec.key}
              style={{
                // 一项 = 两列网格（标签 | 输入+说明）。
                //
                // 不画任何边框/底色：整组设置共用外层那一张卡片，项与项之间靠
                // 外层 gap 分隔。早期版本每项都带 border-bottom，视觉上是一排
                // 贯穿全宽的横线，读起来像表格而不是设置页。
                display: 'grid',
                gridTemplateColumns: '150px minmax(0, 1fr)',
                columnGap: '16px',
                rowGap: '4px',
                alignItems: 'center',
              }}
            >
              <label
                htmlFor={`dsd-${spec.key}`}
                style={{
                  fontSize: '13px',
                  color: 'var(--dsw-alias-label-primary, inherit)',
                  // 与输入框baseline对齐更好看；网格行内居中已足够，这里不额外加。
                  lineHeight: '1.4',
                }}
              >
                {t(spec.label)}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <input
                  id={`dsd-${spec.key}`}
                  aria-label={t(spec.label)}
                  aria-invalid={errors[spec.key] !== undefined}
                  value={display}
                  onChange={(event) => setField(spec.key, event.target.value)}
                  inputMode="decimal"
                  style={fieldStyle(errors[spec.key] !== undefined)}
                />
                {spec.kind === 'bytes' ? (
                  /*
                   * ## 单位下拉的缺省值必须与显示值一致（2026-11-01 审查 SD-09）
                   *
                   * 第一版是 `values[key.unit] === 'MB' ? 'MB' : 'GB'` —— 没有
                   * 单位时**默认 GB**。而数字框的显示值来自 `toBytesInput`，
                   * 它按自然量级选单位：500 MB 显示成 "500"。
                   *
                   * 于是界面出现自相矛盾的一行：
                   *
                   * ```
                   * [ 500 ] [GB ▾]     ← 数字看起来是 500 GB
                   * ```
                   *
                   * 用户把 500 改成 501 并保存，得到 501 GB —— **放大 1024 倍**，
                   * 而他的本意是 501 MB。
                   *
                   * 现在缺省时用 `naturalBytesUnit(current)` —— 与显示侧同一个判定。
                   */
                  <select
                    aria-label={t('bytesUnitLabel', { label: t(spec.label) })}
                    value={
                      values[`${spec.key}.unit`] === 'MB' ||
                      values[`${spec.key}.unit`] === 'GB'
                        ? (values[`${spec.key}.unit`] as string)
                        : naturalBytesUnit(current)
                    }
                    onChange={(event) => setFieldUnit(spec.key, event.target.value)}
                    style={{ ...fieldStyle(false), width: '76px' }}
                  >
                    <option value="GB">GB</option>
                    <option value="MB">MB</option>
                  </select>
                ) : null}
              </div>
              {/* 第二列（说明/错误）：放在网格第 2 列，自动与输入框左边缘对齐。 */}
              <span
                style={{
                  gridColumn: '2',
                  fontSize: '12px',
                  lineHeight: '1.45',
                  color: 'var(--dsw-alias-label-caption, #8a94a6)',
                  marginTop: '1px',
                }}
              >
                {t(spec.hint)}
              </span>
              {errors[spec.key] !== undefined ? (
                <span
                  style={{
                    gridColumn: '2',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-state-error-primary, #d33)',
                  }}
                >
                  {errors[spec.key]}
                </span>
              ) : null}
            </div>
          )
        })}
      </section>

      {/*
        操作区只有**保存**。

        为什么把「立即清理」挪走：它和保存放在一起会被读成"另一个保存按钮"，
        而它做的是完全不同的事（清空安全区）。语义不同的操作不该并排。
      */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        {/*
          保存按钮只在**有改动时**出现。
          常驻的保存按钮会让人以为「不点就白改」，其实每次打开都点一次没有意义；
          而按钮消失是一个明确信号：现在的值和已保存的值一致。
        */}
        {dirty ? (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            style={{
              padding: '6px 18px',
              borderRadius: 'var(--dsw-radius-md, 8px)',
              border: 'none',
              cursor: saving ? 'default' : 'pointer',
              background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #3355ff))',
              color: 'var(--dsw-alias-label-primary-foreground, #fff)',
              font: 'inherit',
              fontSize: '13px',
              fontWeight: 500,
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? t('saving') : t('save')}
          </button>
        ) : null}
        {message !== '' ? (
          <span
            aria-live="polite"
            style={{
              fontSize: '12px',
              color: saved
                ? 'var(--dsw-alias-state-success-primary, #1a7f37)'
                : 'var(--dsw-alias-label-secondary, #5c6779)',
            }}
          >
            {saved ? '✓ ' : ''}
            {message}
          </span>
        ) : null}
      </div>

      {/*
        删除去向：单独渲染在操作区之后。

        为什么不放进 FIELDS：既有测试用 `container.querySelector('button')`
        取「保存」按钮，而那是 DOM 里第一个 button。这组开关若排在保存之前，
        测试就会点到「放入安全区」。放在保存之后既不动那些测试的前提，
        也让这组开关紧邻「保存」——点一下立刻生效，不需要再按保存。
      */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {renderChoiceField(DESTINATION_FIELD)}
      </section>

      {/*
        「立即清理」单独一块，放在最下方。

        ## 为什么用分隔设计

        它**不受上方任何配置影响**：按下去就是把安全区现有条目全部移入回收站，
        不看保留期、也不看容量上限。因此不该跟"保存"并排——那会让人以为它保存
        当前表单。独立成块 + 一行说明，语义才清楚。

        ## 它怎么真正执行

        配置页拿不到"跑清理"的调用接口（`tools` 没有 remote，`commands/execute`
        和 `terminal/*` 都要 agentId）。走宿主的**配置变更 → HMR 重载插件**通道：
        把时间戳写进 `cleanRequestedAt`，插件重载时 `apply` 重跑并执行清理。

        代价是点一次会让插件重载（工具短暂不可用），对手动清理这种低频操作可接受。
      */}
      <div
        style={{
          borderTop: '1px solid var(--dsw-alias-border-l2, #d9dee8)',
          paddingTop: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        {/*
          二次确认：第一次点击只把按钮切成"确认"状态，再点一次才真的执行。

          为什么用同按钮切换而不是弹窗：
            - 弹窗在配置页这种轻量场景里太重，而且宿主的模态层不归插件管；
            - 两段式按钮的意图很明确（"你确定吗？"写在按钮上），不会误点。

          确认状态在以下情况自动撤销：点"取消"、切换配置项、或 8 秒内没再点。
          最后一条避免用户离开后按钮一直停在"确认"，下次回来误触。
        */}
        {/* 确定要清空安全区？确认态提供“确定清理”与“取消”。 */}
        {confirmingClean ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span
              aria-live="polite"
              style={{
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--dsw-alias-state-warn-primary, #b45309)',
              }}
            >
              {t('cleanConfirmPrompt')}
            </span>
            <button
              type="button"
              onClick={() => void runClean()}
              disabled={cleaning}
              style={{
                padding: '6px 16px',
                borderRadius: 'var(--dsw-radius-md, 8px)',
                border: 'none',
                cursor: cleaning ? 'default' : 'pointer',
                background: 'var(--dsw-alias-state-error-primary, #d33)',
                color: '#fff',
                font: 'inherit',
                fontSize: '13px',
                fontWeight: 500,
                opacity: cleaning ? 0.6 : 1,
              }}
            >
              {cleaning ? t('cleaning') : t('cleanConfirm')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingClean(false)}
              disabled={cleaning}
              style={{
                padding: '6px 16px',
                borderRadius: 'var(--dsw-radius-md, 8px)',
                border: '1px solid var(--dsw-alias-border-l3, #d6dde8)',
                cursor: cleaning ? 'default' : 'pointer',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary, inherit)',
                font: 'inherit',
                fontSize: '13px',
                opacity: cleaning ? 0.6 : 1,
              }}
            >
              {t('cancel')}
            </button>
          </div>
        ) : (
          // 立即清理安全区：与保存分块，避免被读成另一个保存动作。
          <button
            type="button"
            onClick={() => armClean()}
            disabled={status !== 'ready' || cleaning}
            style={{
              alignSelf: 'flex-start',
              padding: '6px 18px',
              borderRadius: 'var(--dsw-radius-md, 8px)',
              border: '1px solid var(--dsw-alias-border-l3, #d6dde8)',
              cursor: status !== 'ready' || cleaning ? 'default' : 'pointer',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary, inherit)',
              font: 'inherit',
              fontSize: '13px',
              opacity: status !== 'ready' || cleaning ? 0.55 : 1,
            }}
          >
            {t('cleanNow')}
          </button>
        )}
        <span style={{ fontSize: '12px', lineHeight: '1.45', color: 'var(--dsw-alias-label-caption, #8a94a6)' }}>
          {t('cleanHint')}
        </span>
      </div>
    </div>
  )
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
export const inject = ['slots', 'locale']

/**
 * 注册表单到插件页。
 *
 * 每一步单独兜住：`apply` 里任何一处抛错都会让宿主把**整个客户端包**判为
 * 「激活失败」，表现是插件页里什么都没有、控制台只有一行。分开捕获后，
 * 失败的那一步会被指名道姓地打出来，其余步骤照常。
 */
export function apply(ctx: ClientContext): void {
  const guarded = (step: string, run: () => void): void => {
    try {
      run()
    } catch (error) {
      // 用 console.error 而不是 warn：激活失败要能在控制台里一眼看到。
      console.error(`[dsh-safe-delete] ${step} failed:`, error)
    }
  }

  // locale 字典必须先注册。
  // 槽位注册时传的 `locale: NAMESPACE` 指向这个字典；如果字典不存在，
  // 宿主解析标签会拿到空字符串，配置入口就可能整条不渲染（而且不报错）。
  //
  // 写法与官方插件一致：`ctx.effect(() => ctx.locale.register(NS, {zh, en}), label)`
  // —— `effect` 的回调里只做注册，清理由 cordis 的作用域负责。
  guarded('register locale dictionaries', () => {
    const locale = (ctx as unknown as { locale?: { register?: (ns: string, dict: unknown) => unknown } }).locale
    if (typeof locale?.register !== 'function') {
      console.error('[dsh-safe-delete] locale.register is unavailable; slot labels may not resolve.')
      return
    }
    const register = (): void => {
      locale.register?.(NAMESPACE, DICTIONARIES)
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(register, 'dsh-safe-delete: dictionaries')
    } else {
      register()
    }
  })

  guarded('capture the settings remote for the form', () => {
    // 用 `ctx.inject` 而不是直接读 `ctx.remote`。
    //
    // 关键机制（读 cordis 源码确认）：`ctx.inject(services, cb)` 内部是
    // `this.plugin({ inject: services, apply: cb })` —— **创建一个子插件**，
    // 子 fiber 有自己独立的 inject 列表。所以回调参数里的 ctx 能合法访问
    // 这些服务，绕过了父 fiber 的守卫。
    //
    // 为什么这比写进顶层 inject 更安全：
    //   - 顶层 inject 缺服务 → 整个插件停在 pending，`apply` 永不执行；
    //   - 这里缺服务 → 只有这个子插件停住，其余步骤（含配置页注册）照常。
    //
    // 必须同时请求 `remote` 与 `remote.settings`：`ctx.remote.settings` 是
    // 两步属性求值，只声明后者会在取 `remote` 时就抛 without inject。
    const maybeInject = (ctx as unknown as {
      inject?: (services: string[], cb: (scoped: Record<string, unknown>) => void) => unknown
    }).inject
    if (typeof maybeInject !== 'function') {
      console.error('[dsh-safe-delete] ctx.inject is unavailable; settings remote was not captured.')
      return
    }
    maybeInject(['remote', 'remote.settings'], (scoped) => {
      try {
        const remote = (scoped as { remote?: { settings?: SettingsRemote } }).remote
        settingsRemote = remote?.settings
      } catch (error) {
        console.error('[dsh-safe-delete] settings remote capture failed:', error)
      }
    })
  })

  guarded('register the config page on the plugin page', () => {
    // 与 dsh-context（一个真实可用的带配置页插件）同一套写法，三点缺一不可：
    //
    //   1. `ctx.inject(['configForms'], …)` —— 等配置表单服务挂上再继续。
    //      宿主渲染配置页时要用这个服务；早于它就绪注册，槽位记录虽然存在，
    //      页面拿不到对应表单，「配置」入口就不出现（而且**不报错**）。
    //   2. `whileServed([ns], …)` —— 保证这个 namespace 的配置确实被服务，
    //      服务撤销时会自动注销插槽。
    //   3. `plugins.bundle.config` 而非 `plugins.row.config` —— 本插件是一个
    //      bundle，key 是**包名**（不是 `<包名>#<行 id>`，那是单行配置用的）。
    //
    // `ctx.inject` 不可用时不能静默跳过 —— 诊断体系的意义就是不留盲区。
    const injectFn = (ctx as unknown as { inject?: ClientContext['inject'] }).inject
    if (typeof injectFn !== 'function') {
      console.error('[dsh-safe-delete] ctx.inject is unavailable; the settings form was not registered.')
      return
    }
    injectFn(['configForms'], (scoped) => {
      const service = scoped as {
        // 子 ctx 同时带 slots 与 effect：父 fiber 已声明 slots，子 fiber 沿链能取到。
        slots?: {
          inject?: (name: string, factory: () => unknown) => unknown
          register?: (spec: Record<string, unknown>, component: unknown) => unknown
        }
        effect?: (fn: () => unknown, label?: string) => unknown
        configForms?: {
          get?: (ns: string) => unknown
          whileServed?: (namespaces: string[], register: () => void) => unknown
        }
      }
      const forms = service.configForms
      if (forms?.get === undefined || forms.whileServed === undefined) {
        console.error(
          '[dsh-safe-delete] configForms service is missing get()/whileServed(); the settings form will not appear.',
        )
        return
      }
      try {
        // get() 返回服务持有的稳定控制器。必须保留同一对象并让组件订阅它；
        // 只在挂载时 describe 一次会错过后续配置文档变更。
        settingsForm = asConfigForm(forms.get(NAMESPACE))
      } catch (error) {
        settingsForm = undefined
        console.error(`[dsh-safe-delete] configForms.get("${NAMESPACE}") threw:`, error)
      }

      // 用**子 ctx** 的 slots/effect，而不是外层 ctx。
      //
      // 与官方 dsh-context 一致：`t.slots.inject(...)` 里的 `t` 是子插件 ctx。
      // 为什么重要：`ctx.effect` 开头有 `assertActive()`，而 `whileServed` 的回调
      // 可能在 `apply` 返回之后才触发 —— 那时外层 fiber 的活跃状态没有保证，
      // 子 fiber 的才有（它正是为这段工作而创建的）。
      const slots = service.slots ?? ctx.slots
      const attach = (): unknown => {
        // 回调必须**返回** register 的清理句柄：cordis 用它在这个 effect
        // 失效时注销插槽。返回 undefined 会让注册无法被追踪（官方插件就是
        // 把 register(...) 的返回值直接返回）。
        const slot = slots?.register?.(
          {
            name: 'plugins.bundle.config',
            key: NAMESPACE,
            locale: NAMESPACE,
          },
          // 宿主为这个 locale 命名空间注入 t；文案随宿主语言切换重渲染。
          ({ t, view }: { t: Translate; view: 'summary' | 'page' }) => {
            if (view === 'summary') return t('settingsSummary')
            return <SafeZoneSettings t={t} />
          },
        )
        // 成功用 info 级别（不是 error）：控制台里红字会被读成失败。
        console.info('[dsh-safe-delete] registered plugins.bundle.config')
        return slot
      }

      const runWhileServed = (): unknown =>
        forms.whileServed?.([NAMESPACE], () => slots?.inject?.('plugins.bundle.config', attach))

      // 与官方插件一致：注册动作放在**子 ctx 的** effect 里。子 fiber 的生命周期
      // 正好覆盖这段注册，且 `whileServed` 的回调晚于 apply 触发时它仍然活跃。
      const effect = service.effect ?? ctx.effect
      if (typeof effect === 'function') {
        effect(runWhileServed, 'dsh-safe-delete: plugins-page card')
      } else {
        runWhileServed()
      }
    })
  })
}
