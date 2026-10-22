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
 * 刻意只放**用户真正会调**的项：`stateDir`、`blockShellDeletes` 这类要么改动风险高
 * （换目录会让现有安全区「消失」）、要么属于核心安全语义（关掉拦截），不放进表单。
 */
const FIELDS: FieldSpec[] = [
  {
    key: 'maxBytes',
    label: '最大安全区容量',
    hint: '超过这个大小就开始清理最旧的条目。',
    kind: 'bytes',
    min: 1,
    fallback: 20 * GIGABYTE,
  },
  {
    key: 'pruneAtPercent',
    label: '提前清理阈值',
    hint: '占用达到该百分比就开始清理，为新删除腾出空间。0 表示只在超过容量上限时才清。',
    kind: 'percent',
    min: 0,
    max: 100,
    fallback: 90,
  },
  {
    key: 'autoPruneIntervalMs',
    label: '定时清理间隔',
    hint: '每次工具调用时顺路检查，超过这个间隔才真正清理一次。',
    kind: 'duration',
    min: 60 * 1000,
    fallback: 60 * 60 * 1000,
  },
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

/** 把毫秒格式化成小时（最小 1 分钟）。 */
function toHoursInput(ms: number): string {
  return Number((ms / (60 * 60 * 1000)).toFixed(2)).toString()
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

/** 表单组件。 */
export function SafeZoneSettings(): ReactElement {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
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

  const remote = useMemo<SettingsRemote | undefined>(() => {
    const ctx = (globalThis as { __dshSafeDeleteCtx?: ClientContext }).__dshSafeDeleteCtx
    return ctx?.remote?.settings
  }, [])

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      if (remote?.describe === undefined) {
        if (alive) {
          setStatus('error')
          setMessage('这个宿主没有暴露设置接口，配置请改用 cordis.patch.yml。')
        }
        return
      }
      try {
        const payload = await remote.describe()
        if (!alive) return
        const view = pickNamespace(payload)
        setValues(view.value)
        setRevision(view.revision)
        // 「读到了但没这个命名空间」不等于「配置全空」——那是两种不同的病因。
        // 前者说明插件没装进 profile 或命名空间不匹配，后者只是还没改过配置。
        // 混为一谈会让人以为「配置丢了」，而实际什么都没发生。
        const namespaceSeen = Object.keys(view.value).length > 0
        setStatus('ready')
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

  /** 校验并转成实际值；返回 undefined 表示不合法。 */
  const coerce = useCallback((spec: FieldSpec, raw: unknown): number | undefined => {
    const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '')
    if (text === '') return spec.min === 0 ? 0 : undefined
    const amount = Number(text)
    if (!Number.isFinite(amount) || amount < 0) return undefined
    if (spec.min !== undefined && amount < spec.min) return undefined
    if (spec.max !== undefined && amount > spec.max) return undefined
    if (spec.kind === 'bytes') {
      // 单位跟着输入框一起存在 values 里（`<key>.unit`），由用户切换。
      const unit = values[`${spec.key}.unit`] === 'MB' ? MB : GB
      return Math.round(amount * unit)
    }
    if (spec.kind === 'duration') return Math.round(amount * 60 * 60 * 1000)
    return amount
  }, [values])

  const save = useCallback(async (): Promise<void> => {
    if (remote?.mutate === undefined) return
    const nextErrors: Record<string, string> = {}
    const payload: Record<string, unknown> = {}
    for (const spec of FIELDS) {
      const draft = values[`${spec.key}.draft`]
      if (typeof draft === 'string') {
        // 用户改过：草稿是**显示单位**下的数字，需要换算成字节/毫秒。
        const value = coerce(spec, draft)
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
      // 真实契约：`mutate(ns, ops, revision)`，ops 是 `{ op:'set', path:[key], value }`
      // 的数组，不是 `{ name, value }` 这种扁平形状。
      const ops = Object.entries(payload).map(([key, value]) => ({
        op: 'set' as const,
        path: [key],
        value,
      }))
      const result = await remote.mutate(NAMESPACE, ops, revision)
      // 宿主契约：失败**不 reject**，而是 resolve 成 `{ ok:false, error }`。
      // 不拆信封就会把被拒绝的保存当成成功。
      const unwrapped = unwrapRemote(result)
      if (!unwrapped.ok) {
        setMessage(`保存失败：${unwrapped.error}`)
        return
      }
      // 成功后重新读一次，拿到新的修订号；否则连续两次保存会撞上自己上一次
      // 产生的修订号，第二次被当作冲突拒绝。
      try {
        const refreshed = remote.describe === undefined ? undefined : await remote.describe()
        if (refreshed !== undefined) {
          const view = pickNamespace(refreshed)
          setRevision(view.revision)
          // 清掉草稿：现在它们已经和磁盘一致了。
          setValues(
            Object.fromEntries(Object.entries(view.value).filter(([key]) => !key.endsWith('.draft'))),
          )
        }
      } catch {
        /* 重新读取失败不影响「已保存」这个结论 */
      }
      setSaved(true)
      setMessage('已保存。重启 DSH 生效。')
    } catch (error) {
      setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // 两处都要复位：state 驱动按钮外观，ref 驱动同步守卫。
      savingRef.current = false
      setSaving(false)
    }
  }, [coerce, remote, revision, values])

  if (status === 'loading') return <div style={{ padding: '12px 0' }}>正在读取配置…</div>
  if (status === 'error') {
    return <div style={{ padding: '12px 0', opacity: 0.8 }}>{message}</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0' }}>
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
          display = toHoursInput(current)
        } else {
          display = String(current)
        }
        if (spec.kind === 'bytes') {
          unit = toBytesInput(current).unit
        } else if (spec.kind === 'duration') {
          unit = '小时'
        } else if (spec.kind === 'percent') {
          unit = '%'
        }

        return (
          <label key={spec.key} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 500 }}>{spec.label}</span>
              <input
                aria-label={spec.label}
                value={display}
                onChange={(event) => setField(spec.key, event.target.value)}
                inputMode="decimal"
                style={{
                  width: '96px',
                  padding: '4px 8px',
                  borderRadius: '6px',
                  border: `1px solid ${errors[spec.key] === undefined ? 'var(--dsw-alias-border-secondary, #c9d1e0)' : 'var(--dsw-alias-state-error-primary, #d33)'}`,
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                }}
              />
              {spec.kind === 'bytes' ? (
                <select
                  aria-label={`${spec.label}单位`}
                  value={values[`${spec.key}.unit`] === 'MB' ? 'MB' : 'GB'}
                  onChange={(event) => setField(`${spec.key}.unit`, event.target.value)}
                  style={{
                    padding: '4px 6px',
                    borderRadius: '6px',
                    border: '1px solid var(--dsw-alias-border-secondary, #c9d1e0)',
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                  }}
                >
                  <option value="GB">GB</option>
                  <option value="MB">MB</option>
                </select>
              ) : unit !== '' ? (
                <span style={{ opacity: 0.7 }}>{unit}</span>
              ) : null}
            </span>
            <span style={{ fontSize: '12px', opacity: 0.65 }}>{spec.hint}</span>
            {errors[spec.key] !== undefined ? (
              <span style={{ fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #d33)' }}>
                {errors[spec.key]}
              </span>
            ) : null}
          </label>
        )
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          style={{
            padding: '6px 16px',
            borderRadius: '8px',
            border: 'none',
            cursor: saving ? 'default' : 'pointer',
            background: 'var(--dsw-alias-interactive-bg-primary, #3355ff)',
            color: '#fff',
            font: 'inherit',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {message !== '' ? (
          <span style={{ fontSize: '12px', opacity: 0.8 }} aria-live="polite">
            {saved ? '✓ ' : ''}
            {message}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** 客户端插件入口。 */
/**
 * 客户端插件入口。
 *
 * **只声明宿主一定会提供的服务**：`slots` 与 `locale`。
 *
 * ## 为什么这里不能多写
 *
 * 宿主用 `Object.keys(fiber.inject).filter((s) => ctx.get(s) === undefined)` 检查
 * 依赖，缺一个就把 fiber 停在 `FIBER_PENDING` —— **`apply` 永远不执行**。
 * 表现是：插件在宿主侧正常运行、界面元素一个都不出现、控制台没有明显错误。
 *
 * 之前这里写着 `remote.settings`（自 v0.2.0 起）和 `configForms`，两者都不是
 * 客户端启动必备：
 *   - `configForms` 是渲染配置页时才要的服务，应当用 `ctx.inject()` 现取；
 *   - `remote.settings` 在宿主里并未注册（宿主用的是 `remote.pluginManager`
 *     这类名字），声明它等于让整个客户端包一直等一个不会到来的服务。
 *
 * 对照 `dsh-context`（真实可用的带配置页插件）：它的顶层 inject 就是
 * `['slots', 'locale']`，其余服务一律 `ctx.inject()` 现取。
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
  //
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

  guarded('expose settings remote to the form', () => {
    // 表单组件要从模块作用域拿到 remote.settings，这里把它挂上去。
    ;(globalThis as { __dshSafeDeleteCtx?: ClientContext }).__dshSafeDeleteCtx = ctx
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
    ctx.inject?.(['configForms'], (scoped) => {
      const service = scoped as {
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
        forms.get(NAMESPACE)
      } catch (error) {
        console.error(`[dsh-safe-delete] configForms.get("${NAMESPACE}") threw:`, error)
      }
      const attach = (): unknown => {
        // 回调必须**返回** register 的清理句柄：cordis 用它在这个 effect
        // 失效时注销插槽。返回 undefined 会让注册无法被追踪（官方插件就是
        // 把 register(...) 的返回值直接返回）。
        const slot = ctx.slots?.register?.(
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
        console.error('[dsh-safe-delete] registered plugins.bundle.config') // 成功日志：定位用
        return slot
      }

      const runWhileServed = (): unknown => forms.whileServed?.([NAMESPACE], () => ctx.slots?.inject?.('plugins.bundle.config', attach))

      // 与官方插件一致：注册动作放在 effect 里，让 cordis 负责生命周期。
      if (typeof ctx.effect === 'function') {
        ctx.effect(runWhileServed, 'dsh-safe-delete: plugins-page card')
      } else {
        runWhileServed()
      }
    })
  })
}
