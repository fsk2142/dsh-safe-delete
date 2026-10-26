/**
 * 配置项的人话说明与解析。
 *
 * 为什么单独成模块：斜杠命令里 `config` 的每一项都要说清「它管什么、单位是什么、
 * 改成大一点或小一点会发生什么」。这些文案是产品的一部分，不该散落在命令处理里
 * —— 而且它需要被测试钉住（参数说明缺失 = 用户配置时只能靠猜）。
 *
 * @module dsh-safe-delete/settings-guide
 */

/** 一个可配置项的完整说明。 */
export interface SettingGuide {
  /** 配置键（与 `Config` 中的字段一致）。 */
  key: string
  /** 单位（用于显示与解析）。 */
  unit: 'bytes' | 'milliseconds' | 'percent' | 'count' | 'days' | 'boolean'
  /** 一句话：它管什么。 */
  summary: string
  /** 调大 / 调小分别会发生什么。 */
  effect: string
  /** 合法范围的人话描述。 */
  range: string
  /** 默认值（原始单位）。 */
  defaultValue: number | boolean
}

/** 1 GB 的字节数。 */
const GB = 1024 * 1024 * 1024

/**
 * 全部可配置项的说明。
 *
 * 顺序即 `/safe-delete config` 的展示顺序。
 */
export const SETTING_GUIDES: readonly SettingGuide[] = [
  {
    key: 'retentionDays',
    unit: 'days',
    summary: '删掉的东西在安全区里放多少天。到期后移入系统回收站，不是永久删除。',
    effect: '调大：安全区停留更久，占用磁盘更久。调小：更早交给回收站。',
    range: '至少 1 天；默认 1 天',
    defaultValue: 1,
  },
  {
    key: 'confirmFileCount',
    unit: 'count',
    summary: '一次删除的条目数超过多少时，额外要你确认一次。',
    effect: '调大：大批量删除更少被打断。调小：更容易被要求确认。0 表示不按条目数确认。',
    range: '0 或正整数；默认 5000',
    defaultValue: 5000,
  },
  {
    key: 'confirmBytes',
    unit: 'bytes',
    summary: '一次删除的总大小超过多少时，额外要你确认一次。',
    effect: '调大：删大文件更少被打断。调小：更容易被要求确认。0 表示不按大小确认。',
    range: '0 或至少 1 MB；默认 2 GB',
    defaultValue: 2 * GB,
  },
  {
    key: 'autoPrune',
    unit: 'boolean',
    summary: '是否自动清理。关掉后过期条目不会被自动移走，只能手动清理。',
    effect: '关掉：安全区会持续变大，需要自己执行 /safe-delete clean。',
    range: 'on / off；默认 on',
    defaultValue: true,
  },
  {
    key: 'blockShellDeletes',
    unit: 'boolean',
    summary: '是否拦截裸 shell 的删除命令（rm -rf、Remove-Item -Recurse 等）。',
    effect: '关掉：模型可直接用 shell 删文件，且不可恢复。',
    range: 'on / off；默认 on',
    defaultValue: true,
  },
  {
    key: 'blockProtectedWrites',
    unit: 'boolean',
    summary: '是否拦截对启动关键文件的写入（profile 清单、补丁层、lockfile、node_modules）。',
    effect: '关掉：这些文件可被改写，写坏会导致 DSH 起不来。',
    range: 'on / off；默认 on',
    defaultValue: true,
  },
]

/** 按 key 查说明。 */
export function guideOf(key: string): SettingGuide | undefined {
  return SETTING_GUIDES.find((guide) => guide.key === key)
}

/** 人类可读的体积。 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${Number(value.toFixed(2))} ${units[index]}`
}

/** 人类可读的时长。 */
export function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  const minutes = ms / 60_000
  if (minutes < 60) return `${Number(minutes.toFixed(1))} 分钟`
  const hours = minutes / 60
  if (hours < 24) return `${Number(hours.toFixed(2))} 小时`
  return `${Number((hours / 24).toFixed(2))} 天`
}

/**
 * 把配置值格式化成带单位的可读文本。
 */
export function formatSetting(guide: SettingGuide, value: unknown): string {
  if (guide.unit === 'boolean') return value === true ? 'on' : 'off'
  if (typeof value !== 'number' || !Number.isFinite(value)) return '(未设置)'
  switch (guide.unit) {
    case 'bytes':
      return humanBytes(value)
    case 'milliseconds':
      return humanDuration(value)
    case 'percent':
      return `${value}%`
    case 'days':
      return `${value} 天`
    case 'count':
      return value === 0 ? '0（不按条目数确认）' : `${value} 条`
    default:
      return String(value)
  }
}

/** 解析结果。 */
export type ParseSetting = { ok: true; value: number | boolean } | { ok: false; error: string }

/**
 * 解析用户输入的值。
 *
 * 支持带单位的写法（`20GB`、`500MB`、`2h`、`30min`），也支持纯数字
 * （按该字段的单位解释）。范围检查与说明里的 `range` 保持一致。
 */
export function parseSetting(guide: SettingGuide, raw: string): ParseSetting {
  const text = raw.trim()
  if (text === '') return { ok: false, error: `需要一个值。${guide.summary}（范围：${guide.range}）` }

  if (guide.unit === 'boolean') {
    const lowered = text.toLowerCase()
    if (['on', 'true', '1', 'yes', '开'].includes(lowered)) return { ok: true, value: true }
    if (['off', 'false', '0', 'no', '关'].includes(lowered)) return { ok: true, value: false }
    return { ok: false, error: `只接受 on 或 off。${guide.summary}` }
  }

  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z%]*)$/.exec(text)
  if (match === null) {
    return { ok: false, error: `无法解析 "${text}"。${guide.summary}（范围：${guide.range}）` }
  }
  const amount = Number(match[1])
  const suffix = (match[2] ?? '').toLowerCase()
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: `值必须是非负数。（范围：${guide.range}）` }
  }

  if (guide.unit === 'bytes') {
    const factor =
      suffix === '' || suffix === 'b' ? 1
      : suffix === 'kb' ? 1024
      : suffix === 'mb' ? 1024 ** 2
      : suffix === 'gb' ? 1024 ** 3
      : suffix === 'tb' ? 1024 ** 4
      : undefined
    if (factor === undefined) {
      return { ok: false, error: `体积单位只接受 KB / MB / GB / TB（例如 20GB）。范围：${guide.range}` }
    }
    const bytes = Math.round(amount * factor)
    if (bytes > 0 && bytes < 1024 * 1024) {
      return { ok: false, error: `太小了，至少 1MB。范围：${guide.range}` }
    }
    return { ok: true, value: bytes }
  }

  if (guide.unit === 'milliseconds') {
    const factor =
      suffix === '' || suffix === 'ms' ? 1
      : suffix === 's' ? 1000
      : suffix === 'min' ? 60_000
      : suffix === 'h' ? 3_600_000
      : suffix === 'd' ? 86_400_000
      : undefined
    if (factor === undefined) {
      return { ok: false, error: `时长单位只接受 ms / s / min / h / d（例如 2h）。范围：${guide.range}` }
    }
    const ms = Math.round(amount * factor)
    if (ms < 60_000) return { ok: false, error: `至少 1 分钟。范围：${guide.range}` }
    return { ok: true, value: ms }
  }

  if (guide.unit === 'days') {
    const days = Math.round(amount)
    if (days < 1) return { ok: false, error: `至少 1 天。范围：${guide.range}` }
    return { ok: true, value: days }
  }

  if (guide.unit === 'percent') {
    if (amount < 0 || amount > 100) {
      return { ok: false, error: `百分比必须在 0 到 100 之间。${guide.summary}` }
    }
    return { ok: true, value: Math.round(amount) }
  }

  // count
  const count = Math.round(amount)
  if (count < 0) return { ok: false, error: `不能是负数。范围：${guide.range}` }
  return { ok: true, value: count }
}
