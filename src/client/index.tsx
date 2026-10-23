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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

/** 宿主侧设置的命名空间（= 插件在 profile 里的行 id）。 */
const NAMESPACE = 'dsh-safe-delete'

/**
 * 启动诊断记录。
 *
 * 为什么要这个东西：配置页连续几版都不显示，而控制台里看不到任何线索 ——
 * 「apply 没执行」「注册被丢弃」「渲染条件不满足」三种情况在界面上长得一模一样。
 * 把每一步的结果留下来，并渲染到表单顶部，就能一眼区分它们，不必开控制台。
 *
 * 同时挂到 `globalThis` 上，方便在控制台里直接看 `__dshSafeDeleteDiag`。
 */
const diagnostics: Array<{ at: number; step: string; ok: boolean; detail?: string }> = []

function note(step: string, ok: boolean, detail?: string): void {
  diagnostics.push({ at: Date.now(), step, ok, ...(detail === undefined ? {} : { detail }) })
  if (typeof globalThis !== 'undefined') {
    ;(globalThis as { __dshSafeDeleteDiag?: unknown }).__dshSafeDeleteDiag = diagnostics
  }
}

/** 字节单位。 */
const MB = 1024 * 1024
const GB = 1024 * MB

/** 一个可编辑字段的描述。 */
interface FieldSpec {
  key: string
  label: string
  hint: string
  /** 控件类型。 */
  kind: 'bytes' | 'number' | 'percent' | 'boolean' | 'duration'
  /** 最小值（含）。 */
  min?: number
  max?: number
  /** 配置里读不到该字段时显示的兜底值（与宿主侧默认值保持一致）。 */
  fallback: number
}

/** 1 GB 的字节数。 */
const GIGABYTE = 1024 * 1024 * 1024

/**
 * 表单字段。
 *
 * ## 只剩两项：都是「单次删除要不要额外确认」的阈值
 *
 * 容量相关的三个参数（`maxBytes` / `pruneAtPercent` / `autoPruneIntervalMs`）
 * 已经**从产品和配置里移除**：安全区只按保留期（固定 1 天）清理，到点把条目交给
 * 系统回收站。不留容量管理，语义才可预测——删进去的东西不会因为"超上限"被立刻
 * 推走，而界面却还说能恢复。
 *
 * `stateDir`、`blockShellDeletes` 这类也不放表单：前者改动风险高（换目录等于让
 * 现有安全区「消失」），后者属于核心安全语义（关掉拦截）。
 */
const FIELDS: FieldSpec[] = [
  {
    key: 'confirmFileCount',
    label: '单次删除条目数确认',
    hint: '一次删除超过这么多条就额外问一次。0 表示关闭。',
    kind: 'number',
    min: 0,
    fallback: 5000,
  },
  {
    key: 'confirmBytes',
    label: '单次删除大小确认',
    hint: '一次删除超过这么大就额外问一次。0 表示关闭。',
    kind: 'bytes',
    min: 0,
    fallback: 2 * GIGABYTE,
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

/**
 * 把毫秒换算成「天或小时」的显示值。
 *
 * 为什么给两个单位：清理间隔短则几分钟、长则几天。只给小时的话「1 天」显示成
 * `24`、「30 天」显示成 `720`，用户要在脑子里换算，也容易填错数量级。
 *
 * @param ms 毫秒。
 * @param unit 期望单位。
 * @returns 该单位下的数值字符串（最多两位小数，去掉多余的 0）。
 */
function toDurationInput(ms: number, unit: 'day' | 'hour'): string {
  const divisor = unit === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000
  return Number((ms / divisor).toFixed(2)).toString()
}

/**
 * 选一个读起来最自然的单位：整天的用天，否则用小时。
 *
 * @param ms 毫秒。
 * @returns `'day'` 或 `'hour'`。
 */
function naturalDurationUnit(ms: number): 'day' | 'hour' {
  const day = 24 * 60 * 60 * 1000
  return ms >= day && ms % day === 0 ? 'day' : 'hour'
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
function unwrapRemote(result: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
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
          : '宿主拒绝了这次保存'
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

/**
 * 注入 remote（**仅测试用**）。
 *
 * 为什么需要它：组件通过模块变量拿 remote，`apply` 才能在真实宿主里填这个值。
 * 但测试里没有宿主，没有这个入口就无法把组件挂到真实 DOM 上驱动交互 ——
 * 而「只测纯函数、不测交互」正是「单位选了存不进去」连续两版没被发现的原因。
 *
 * @param remote 假的 settings remote。
 */
export function __setRemoteForTest(remote: SettingsRemote | undefined): void {
  settingsRemote = remote
}

/**
 * 表单组件里取 remote。
 *
 * @returns 宿主提供的 settings remote；不可用时 `undefined`。
 */
function currentRemote(): SettingsRemote | undefined {
  return settingsRemote
}

/** 表单组件。 */
export function SafeZoneSettings(): ReactElement {
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

  // remote 由 `apply` 里的 `ctx.inject(['remote.settings'], …)` 异步填入，
  // 可能在首次渲染之后才就绪。所以这里不用 `useMemo`（它只算一次），
  // 而是在 effect 里读，必要时短暂重试。
  const remote = currentRemote()

  useEffect(() => {
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
          '这个宿主没有暴露设置接口（remote.settings 不可用），配置请改用 cordis.patch.yml。',
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
        const unwrapped = unwrapRemote(raw)
        const payload = unwrapped.ok ? unwrapped.value : undefined
        if (!unwrapped.ok) {
          setStatus('error')
          setMessage(`读取配置失败：${unwrapped.error}`)
          note('describe() envelope', false, unwrapped.error)
          return
        }
        note('describe() envelope', true, 'unwrapped')
        const view = pickNamespace(payload)
        setValues(view.value)
        setRevision(view.revision)
        // 「读到了但没这个命名空间」不等于「配置全空」——那是两种不同的病因。
        // 前者说明插件没装进 profile 或命名空间不匹配，后者只是还没改过配置。
        // 混为一谈会让人以为「配置丢了」，而实际什么都没发生。
        const namespaceSeen = Object.keys(view.value).length > 0
        setStatus('ready')
        // 诊断：把宿主**实际返回**的命名空间列表记下来。
        // 「磁盘上有值但界面显示默认值」这种病，靠读源码推断过两轮都没定位，
        // 只有把宿主真实返回的形状摆出来才能判断是"没这个 ns"还是"ns 里没值"。
        const seen: string[] = []
        const list = Array.isArray(payload)
          ? payload
          : (payload as { namespaces?: unknown } | undefined)?.namespaces
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item === null || typeof item !== 'object') continue
            const rec = item as Record<string, unknown>
            const name = typeof rec['ns'] === 'string' ? rec['ns'] : rec['id']
            const value = rec['value']
            const keys = value !== null && typeof value === 'object' ? Object.keys(value as object) : []
            seen.push(`${String(name)}(${keys.length} keys)`)
          }
        }
        note('host namespaces', namespaceSeen, seen.length === 0 ? 'empty list' : seen.join(', '))
        // 原始形状（截断）：如果宿主返回的字段名不是 ns/id、或者 value 被投影剥离，
        // 只有看原始 JSON 才能知道。这一步是为了结束"读源码推断"。
        try {
          const raw = JSON.stringify(payload)
          note('describe() raw', true, raw.length > 400 ? `${raw.slice(0, 400)}…` : raw)
        } catch {
          note('describe() raw', false, 'not serializable')
        }
        note(
          'picked namespace value',
          namespaceSeen,
          `${Object.keys(view.value).length} keys, revision=${String(view.revision)}`,
        )
        if (!namespaceSeen) {
          setMessage('没有读到本插件的配置（显示的是默认值）。若刚安装，重启 DSH 后再看。')
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
  }, [remote])

  const setField = useCallback((key: string, raw: string): void => {
    // 用 `<key>.draft` 保存用户的原始输入：不要覆盖从配置读到的真实值，
    // 否则下一次渲染就没法再换算回显示单位了。
    setValues((prev) => ({ ...prev, [`${key}.draft`]: raw }))
    setSaved(false)
    setErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  /**
   * 设置某个字段的单位（`MB`/`GB` 或 `hour`/`day`）。
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
   * @returns 换算后的字节/毫秒；不合法时 undefined。
   */
  const coerce = useCallback((spec: FieldSpec, raw: unknown): number | undefined => {
    const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '')
    if (text === '') return spec.min === 0 ? 0 : undefined
    const amount = Number(text)
    if (!Number.isFinite(amount) || amount < 0) return undefined

    // 第一步：把显示数值换算成真实单位（字节 / 毫秒）。
    let value: number
    if (spec.kind === 'bytes') {
      // 单位跟着输入框一起存在 values 里（`<key>.unit`），由用户切换。
      const unit = values[`${spec.key}.unit`] === 'MB' ? MB : GB
      value = Math.round(amount * unit)
    } else if (spec.kind === 'duration') {
      // 单位来自独立的 `.unit` 键（用户在下拉里选）。
      //
      // 兜底必须与**显示侧**用同一个判定，否则会出现「显示 24 小时、保存成 24 天」
      // 这种静默错位。显示侧用 `naturalDurationUnit(current)`，即"当前值能被整天
      // 整除就用天"；输入框里没有当前值时按小时（更保守：小时不会放大 24 倍）。
      const chosen = values[`${spec.key}.unit`]
      const day = 24 * 60 * 60 * 1000
      const unit =
        chosen === 'day'
          ? day
          : chosen === 'hour'
            ? 60 * 60 * 1000
            : naturalDurationUnit(numericOf(values, spec.key, 0)) === 'day'
              ? day
              : 60 * 60 * 1000
      value = Math.round(amount * unit)
    } else {
      value = amount
    }

    // 第二步：拿**换算后**的值和边界比较。
    if (spec.min !== undefined && value < spec.min) return undefined
    if (spec.max !== undefined && value > spec.max) return undefined
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
    if (spec.kind === 'bytes') return toBytesInput(current).amount
    if (spec.kind === 'duration') {
      const chosen = source[`${spec.key}.unit`]
      const unit = chosen === 'day' || chosen === 'hour' ? chosen : naturalDurationUnit(current)
      return toDurationInput(current, unit)
    }
    return String(current)
  }

  const save = useCallback(async (): Promise<void> => {
    if (remote?.mutate === undefined) return
    const nextErrors: Record<string, string> = {}
    const payload: Record<string, unknown> = {}
    for (const spec of FIELDS) {
      const draft = values[`${spec.key}.draft`]
      const unitChanged = typeof values[`${spec.key}.unit`] === 'string'
      if (typeof draft === 'string' || (unitChanged && (spec.kind === 'bytes' || spec.kind === 'duration'))) {
        // 用户改过**数值或单位**：把当前显示值（单位下的数字）换算成字节/毫秒。
        //
        // 为什么单位变了也要走这条路：只切单位不改数值时，最终要保存的数**变了**
        // （1 小时 → 1 天）。走下面的"没改过"分支会把旧值原样写回，用户的单位
        // 选择被静默丢弃。
        const displayValue = typeof draft === 'string' ? draft : displayValueOf(spec, values)
        const value = coerce(spec, displayValue)
        if (value === undefined) {
          nextErrors[spec.key] = '填一个不小于下限的数字'
          continue
        }
        payload[spec.key] = value
        continue
      }
      // 没改过：`values[key]` 已经是配置里的真实值（字节/毫秒），原样写回。
      // 若也走 coerce，会被当成 GB 再乘一次 —— 直接放大 1073741824 倍。
      const current = numericOf(values, spec.key, spec.fallback)
      payload[spec.key] = current
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      setMessage('有字段不合法，没有保存。')
      return
    }

    // 同步守卫：同一帧内的第二次点击在这里被挡掉。
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setMessage('')
    try {
      const activeRemote = currentRemote()
      if (activeRemote?.mutate === undefined) {
        setMessage('这个宿主没有暴露设置接口，无法保存。配置请改用 cordis.patch.yml。')
        return
      }
      // 真实契约：`mutate(ns, ops, revision)`，ops 是 `{ op:'set', path:[key], value }`
      // 的数组，不是 `{ name, value }` 这种扁平形状。
      const ops = Object.entries(payload).map(([key, value]) => ({
        op: 'set' as const,
        path: [key],
        value,
      }))
      const result = await activeRemote.mutate(NAMESPACE, ops, revision)
      // 宿主契约：失败**不 reject**，而是 resolve 成 `{ ok:false, error }`。
      // 不拆信封就会把被拒绝的保存当成成功。
      const unwrapped = unwrapRemote(result)
      if (!unwrapped.ok) {
        setMessage(`保存失败：${unwrapped.error}`)
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
        const refreshed = activeRemote.describe === undefined ? undefined : await activeRemote.describe()
        if (refreshed !== undefined) {
          // 同样要拆信封（见上方 describe 的说明）。
          const refreshedUnwrapped = unwrapRemote(refreshed)
          const view = pickNamespace(refreshedUnwrapped.ok ? refreshedUnwrapped.value : undefined)
          setRevision(view.revision)
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
            // 读到了新值：清掉草稿，界面与磁盘一致。
            setValues(Object.fromEntries(Object.entries(view.value).filter(([key]) => !key.endsWith('.draft'))))
            setMessage('已保存。重启 DSH 生效。')
          } else {
            // 没读到新值：保留用户输入，并如实说明「已写入但未能回读确认」。
            setMessage('已提交保存，但宿主回读到的仍是旧值。重启 DSH 后再确认。')
          }
        }
      } catch {
        /* 重新读取失败不影响「已保存」这个结论 */
      }
      setSaved(true)
    } catch (error) {
      setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // 两处都要复位：state 驱动按钮外观，ref 驱动同步守卫。
      savingRef.current = false
      setSaving(false)
    }
  }, [coerce, remote, revision, values])

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
    if (activeRemote?.mutate === undefined) {
      setMessage('这个宿主没有暴露设置接口，无法触发清理。')
      return
    }
    if (cleaning) return
    setCleaning(true)
    setMessage('')
    setSaved(false)
    try {
      // 用时间戳而不是布尔：连续两次点也能区分（同一个值写两次不会触发变更）。
      const stamp = Date.now()
      const result = await activeRemote.mutate(
        NAMESPACE,
        [{ op: 'set', path: ['cleanRequestedAt'], value: stamp }],
        revision,
      )
      const unwrapped = unwrapRemote(result)
      if (!unwrapped.ok) {
        setMessage(`清理请求失败：${unwrapped.error}`)
        return
      }
      // 刷新 revision，避免下一次保存撞上冲突。
      try {
        const refreshed = activeRemote.describe === undefined ? undefined : await activeRemote.describe()
        if (refreshed !== undefined) {
          const unwrappedRefresh = unwrapRemote(refreshed)
          const view = pickNamespace(unwrappedRefresh.ok ? unwrappedRefresh.value : undefined)
          setRevision(view.revision)
        }
      } catch {
        /* revision 刷新失败不影响清理已触发 */
      }
      setMessage('已提交清理请求：安全区条目正在移入系统回收站。插件会重载一次，稍后刷新即可看到结果。')
      setSaved(true)
    } catch (error) {
      setMessage(`清理请求失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setCleaning(false)
      // 无论成功失败都退出确认态：成功了界面会随插件重载刷新，失败则让用户
      // 重新走一遍确认，而不是停在那里、再点一下就又发一次请求。
      setConfirmingClean(false)
    }
  }, [cleaning, revision])

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
            <span style={{ fontWeight: 600, fontSize: '14px' }}>安全区设置</span>
            <span style={{ fontSize: '12px', color: 'var(--dsw-alias-label-caption, #8a94a6)' }}>
              正在读取配置…
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
            <span style={{ fontWeight: 600, fontSize: '14px' }}>安全区设置</span>
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
    // 「定时清理间隔」那一行的数字框和单位下拉会一高一低，看上去像行距错乱。
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
            安全区设置
          </span>
          <span style={{ fontSize: '12px', lineHeight: '1.45', color: 'var(--dsw-alias-label-caption, #8a94a6)' }}>
            保存后需重启 DSH 生效。删除的文件先进安全区，可在保留期内取回。
          </span>
        </div>

        {FIELDS.map((spec) => {
          // 显示值有两个来源，必须分清：
          //   - 用户正在输入的原始文本（`<key>.draft`）—— 原样显示，否则每敲一个
          //     字符就被换算一次，输入框会跳；
          //   - 从配置读到的**字节/毫秒**值 —— 必须先换算成 GB/小时再显示，
          //     否则用户会看到 `21474836480 GB` 这种东西。
          const draft = values[`${spec.key}.draft`]
          const current = numericOf(values, spec.key, spec.fallback)
          let display: string
          let unit = ''
          if (typeof draft === 'string') {
            display = draft
          } else if (spec.kind === 'bytes') {
            display = toBytesInput(current).amount
          } else if (spec.kind === 'duration') {
            const chosen = values[`${spec.key}.unit`]
            const durationUnit = chosen === 'day' || chosen === 'hour' ? chosen : naturalDurationUnit(current)
            display = toDurationInput(current, durationUnit)
          } else {
            display = String(current)
          }
          if (spec.kind === 'bytes') {
            unit = toBytesInput(current).unit
          } else if (spec.kind === 'duration') {
            // 这里**只决定单位后缀**，绝不能再赋值 `display`。
            //
            // 之前这里重复算了一遍 `display = toDurationInput(...)`，把上面
            // "用户正在输入就原样显示"的那个分支覆盖掉了 —— 表现就是
            // 「定时清理间隔输入时不显示，保存后才出现」：每敲一个字符都被
            // 换回配置里的旧值，输入框看起来像只读。
            const chosen = values[`${spec.key}.unit`]
            const durationUnit = chosen === 'day' || chosen === 'hour' ? chosen : naturalDurationUnit(current)
            unit = durationUnit === 'day' ? '天' : '小时'
          } else if (spec.kind === 'percent') {
            unit = '%'
          }

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
                {spec.label}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <input
                  id={`dsd-${spec.key}`}
                  aria-label={spec.label}
                  aria-invalid={errors[spec.key] !== undefined}
                  value={display}
                  onChange={(event) => setField(spec.key, event.target.value)}
                  inputMode="decimal"
                  style={fieldStyle(errors[spec.key] !== undefined)}
                />
                {spec.kind === 'bytes' ? (
                  <select
                    aria-label={`${spec.label}单位`}
                    value={values[`${spec.key}.unit`] === 'MB' ? 'MB' : 'GB'}
                    onChange={(event) => setFieldUnit(spec.key, event.target.value)}
                    style={{ ...fieldStyle(false), width: '76px' }}
                  >
                    <option value="GB">GB</option>
                    <option value="MB">MB</option>
                  </select>
                ) : spec.kind === 'duration' ? (
                  // 天/小时自选：只给小时的话「30 天」要写成 720，容易填错数量级。
                  <select
                    aria-label={`${spec.label}单位`}
                    value={
                      values[`${spec.key}.unit`] === 'day'
                        ? 'day'
                        : values[`${spec.key}.unit`] === 'hour'
                          ? 'hour'
                          : naturalDurationUnit(current)
                    }
                    onChange={(event) => setFieldUnit(spec.key, event.target.value)}
                    style={{ ...fieldStyle(false), width: '86px' }}
                  >
                    <option value="hour">小时</option>
                    <option value="day">天</option>
                  </select>
                ) : unit !== '' ? (
                  <span style={{ fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6779)' }}>{unit}</span>
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
                {spec.hint}
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
            {saving ? '保存中…' : '保存'}
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
              确定要清空安全区？
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
              {cleaning ? '清理中…' : '确定清理'}
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
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => armClean()}
            disabled={status !== 'ready' || cleaning}
            title="把安全区里的条目全部移入系统回收站（会在清空回收站之前可还原）"
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
            立即清理安全区
          </button>
        )}
        <span style={{ fontSize: '12px', lineHeight: '1.45', color: 'var(--dsw-alias-label-caption, #8a94a6)' }}>
          把安全区现有条目全部移入系统回收站，不受保留期与容量上限限制。
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
  note('apply() entered', true, `inject=[${inject.join(',')}]`)

  const guarded = (step: string, run: () => void): void => {
    try {
      run()
      note(step, true)
    } catch (error) {
      // 用 console.error 而不是 warn：激活失败要能在控制台里一眼看到。
      console.error(`[dsh-safe-delete] ${step} failed:`, error)
      note(step, false, error instanceof Error ? error.message : String(error))
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
      note('locale.register', false, `locale=${typeof locale}, register=${typeof locale?.register}`)
      return
    }
    const dictionaries = {
      zh: { settings: '安全区设置', title: '安全区' },
      en: { settings: 'Safe-zone settings', title: 'Safe zone' },
    }
    const register = (): void => {
      locale.register?.(NAMESPACE, dictionaries)
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
      note('capture settings remote', false, 'ctx.inject is unavailable')
      return
    }
    maybeInject(['remote', 'remote.settings'], (scoped) => {
      try {
        const remote = (scoped as { remote?: { settings?: SettingsRemote } }).remote
        settingsRemote = remote?.settings
        note(
          'capture settings remote',
          settingsRemote !== undefined,
          settingsRemote === undefined ? 'remote.settings is empty' : 'ok',
        )
      } catch (error) {
        note('capture settings remote', false, error instanceof Error ? error.message : String(error))
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
      note('register the config page on the plugin page', false, 'ctx.inject is unavailable')
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
        note('configForms service', false, `get=${typeof forms?.get}, whileServed=${typeof forms?.whileServed}`)
        return
      }
      note('configForms service', true)
      try {
        forms.get(NAMESPACE)
      } catch (error) {
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
          // 第二个参数必须是**组件函数**，签名 `({ t, view }) => element`。
          ({ view }: { view?: string }) => {
            if (view === 'summary') return '安全区设置'
            return <SafeZoneSettings />
          },
        )
        // 成功用 info 级别（不是 error）：控制台里红字会被读成失败。
        // 诊断面板已经记了这一步，这行只是控制台里的方便标记。
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

  // 把诊断结果写进页面标题栏。
  //
  // 为什么不用表单：槽位没渲染时表单根本不存在，那就没有任何地方能看到这些记录。
  // 标题栏是宿主自己的，一定能碰 —— 这样即使注册被丢弃，也能确认 apply 跑过了。
  guarded('publish diagnostics to the document title', () => {
    const doc = (globalThis as { document?: Document }).document
    if (doc === undefined) {
      note('document unavailable', false)
      return
    }
    const okCount = diagnostics.filter((d) => d.ok).length
    const badCount = diagnostics.length - okCount
    const suffix = badCount === 0 ? `✓${okCount}` : `✓${okCount} ✗${badCount}`
    const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
    if (typeof timer === 'function') {
      // 延后一点：让宿主的标题更新先生效，再覆盖，避免被冲掉。
      timer(() => {
        doc.title = `${doc.title.replace(/\s*·\s*dsh-safe-delete.*$/, '')} · dsh-safe-delete ${suffix}`
      }, 1500)
    }
    note('publish diagnostics', true, suffix)
  })
}
