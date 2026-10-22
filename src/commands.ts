/**
 * 斜杠命令的处理逻辑。
 *
 * 四个命令：
 *   `/safe-delete <路径>`          把文件或目录移入安全区
 *   `/safe-delete clean`           立即清理安全区
 *   `/safe-delete config`          列出所有配置项与当前值、含义、范围
 *   `/safe-delete config <key> <值>` 改一项
 *
 * 这一层是**纯逻辑**：它接收已经解析好的输入、读写回调，返回要显示给用户的文本。
 * 把宿主 API 调用隔离在外面，是为了让「说明文案是否完整」「解析是否正确」可被单测。
 *
 * @module dsh-safe-delete/commands
 */

import {
  SETTING_GUIDES,
  formatSetting,
  guideOf,
  parseSetting,
  type SettingGuide,
} from './settings-guide'

/** 命令执行结果（与宿主 `commands` 契约一致）。 */
export type CommandReply = { kind: 'success' | 'error'; text: string }

/** 命令可用的依赖。 */
export interface CommandDeps {
  /** 执行一次删除（已绑定 stateDir / env / 审批）。 */
  delete: (path: string, options: { preview: boolean }) => Promise<{ ok: boolean; text: string }>
  /** 列出安全区条目（简版）。 */
  listSafeZone: () => Promise<readonly { id: string; originalPath: string; expiresAt: number }[]>
  /** 按 id 取回一项。 */
  restore: (id: string) => Promise<{ ok: true; restoredTo: string } | { ok: false; error: string }>
  /** 现在清理一次；`dryRun` 只报告。 */
  clean: (dryRun: boolean) => Promise<{ removed: readonly string[]; freedBytes: number }>
  /** 读当前配置。 */
  readConfig: () => Promise<Record<string, unknown>>
  /** 写一项配置。 */
  writeConfig: (key: string, value: number | boolean) => Promise<{ ok: boolean; error?: string }>
  /** 状态摘要。 */
  status: () => Promise<string>
}

/** 帮助文本。 */
const HELP = `安全删除 —— 把删除变成可撤销的操作

用法：
  /safe-delete <路径>              把文件或目录移入安全区（7 天内可取回）
  /safe-delete <路径> --preview    只看会发生什么，不真的移动
  /safe-delete list                列出安全区里的条目
  /safe-delete restore <id>        把某个条目取回原位
  /safe-delete clean               立即清理安全区（过期与超容量部分）
  /safe-delete clean --dry-run     只报告会清理什么，不动手
  /safe-delete config              查看所有可配置项、当前值、含义与范围
  /safe-delete config <项> <值>     修改一项配置（例如 config maxBytes 30GB）
  /safe-delete status              安全区概况

提示：这里的删除**不是永久删除** —— 东西会进安全区，保留期内随时能取回。`

/**
 * 渲染配置清单。
 *
 * 每一项都给出：当前值、它管什么、调大调小的影响、合法范围。
 * 这是「不要让用户在配置时产生疑问」的具体落实。
 */
export function renderConfigList(
  values: Record<string, unknown>,
  guides: readonly SettingGuide[] = SETTING_GUIDES,
): string {
  const lines: string[] = ['可配置项（改法：/safe-delete config <项> <值>）', '']
  for (const guide of guides) {
    const raw = values[guide.key]
    const value = raw === undefined ? guide.defaultValue : raw
    lines.push(`${guide.key}  =  ${formatSetting(guide, value)}`)
    lines.push(`  作用：${guide.summary}`)
    lines.push(`  影响：${guide.effect}`)
    lines.push(`  范围：${guide.range}`)
    lines.push('')
  }
  lines.push('示例：')
  lines.push('  /safe-delete config maxBytes 30GB       安全区上限改成 30 GB')
  lines.push('  /safe-delete config pruneAtPercent 80   用到 80% 就开始提前清理')
  lines.push('  /safe-delete config confirmBytes 512MB  超过 512 MB 的删除要确认')
  return lines.join('\n')
}

/** 渲染单个配置项的详情（用于 `config <key>` 无值时）。 */
export function renderConfigDetail(guide: SettingGuide, values: Record<string, unknown>): string {
  const raw = values[guide.key]
  const value = raw === undefined ? guide.defaultValue : raw
  return [
    `${guide.key} = ${formatSetting(guide, value)}（当前）`,
    '',
    `作用：${guide.summary}`,
    `影响：${guide.effect}`,
    `范围：${guide.range}`,
    `默认：${formatSetting(guide, guide.defaultValue)}`,
    '',
    `改法：/safe-delete config ${guide.key} <值>`,
  ].join('\n')
}

/** 已知的子命令。 */
const SUBCOMMANDS = new Set(['list', 'restore', 'clean', 'config', 'status', 'help', '--help', '-h'])

/**
 * 判断输入是子命令还是路径。
 *
 * 为什么不能简单取第一个词：路径本身可以带空格（`C:\My Files\x`），
 * 而第一个词 `C:\My` 不是已知子命令。只有**恰好命中**已知子命令时才按子命令解释，
 * 否则整串都是路径。
 */
function splitCommand(rawInput: string): { verb: string; rest: string } {
  const trimmed = rawInput.trim()
  if (trimmed === '') return { verb: '', rest: '' }
  const space = trimmed.search(/\s/)
  const first = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  if (!SUBCOMMANDS.has(first)) return { verb: '', rest: trimmed }
  return { verb: first, rest: space === -1 ? '' : trimmed.slice(space + 1).trim() }
}

/**
 * 执行一个命令。
 *
 * @param rawInput 斜杠后的全部输入。
 * @param deps 依赖。
 */
export async function runCommand(rawInput: string, deps: CommandDeps): Promise<CommandReply> {
  const { verb, rest } = splitCommand(rawInput)

  // 完全无输入：帮助。
  if (verb === '' && rest === '') return { kind: 'success', text: HELP }
  if (verb === 'help' || verb === '--help' || verb === '-h') return { kind: 'success', text: HELP }

  // 子命令。
  if (verb === 'list') {
    const entries = await deps.listSafeZone()
    if (entries.length === 0) return { kind: 'success', text: '安全区是空的。' }
    const lines = [`安全区里有 ${entries.length} 项：`]
    for (const entry of entries.slice(0, 30)) {
      const expires = new Date(entry.expiresAt).toISOString().slice(0, 10)
      lines.push(`  ${entry.id}  ${expires} 到期  ${entry.originalPath}`)
    }
    if (entries.length > 30) lines.push(`  … 另有 ${entries.length - 30} 项`)
    lines.push('', '取回：/safe-delete restore <id>')
    return { kind: 'success', text: lines.join('\n') }
  }

  if (verb === 'status') return { kind: 'success', text: await deps.status() }

  if (verb === 'restore') {
    const id = rest.trim()
    if (id === '') {
      return {
        kind: 'error',
        text: '要取回哪一项？用法：/safe-delete restore <id>\n先用 /safe-delete list 查看 id。',
      }
    }
    const restored = await deps.restore(id)
    if (!restored.ok) return { kind: 'error', text: restored.error }
    return { kind: 'success', text: `已取回：${restored.restoredTo}` }
  }

  if (verb === 'clean') {
    const dryRun = rest.includes('--dry-run')
    const result = await deps.clean(dryRun)
    if (result.removed.length === 0) {
      return { kind: 'success', text: '没有需要清理的条目（都还在保留期内，且未超容量）。' }
    }
    const head = dryRun
      ? `将清理 ${result.removed.length} 项（dry run，什么都没动）：`
      : `已清理 ${result.removed.length} 项：`
    return { kind: 'success', text: [head, ...result.removed.map((item) => `  ${item}`)].join('\n') }
  }

  if (verb === 'config') {
    const values = await deps.readConfig()
    if (rest === '') return { kind: 'success', text: renderConfigList(values) }

    const parts = rest.split(/\s+/)
    const key = parts[0] ?? ''
    const guide = guideOf(key)
    if (guide === undefined) {
      const known = SETTING_GUIDES.map((item) => item.key).join('、')
      return { kind: 'error', text: `没有 "${key}" 这一项。可配置项：${known}\n\n查看全部说明：/safe-delete config` }
    }

    // 只给了 key：显示这一项的详情。
    if (parts.length < 2) {
      return { kind: 'success', text: renderConfigDetail(guide, values) }
    }

    const valueText = parts.slice(1).join(' ')
    const parsed = parseSetting(guide, valueText)
    if (!parsed.ok) return { kind: 'error', text: parsed.error }

    const written = await deps.writeConfig(guide.key, parsed.value)
    if (!written.ok) {
      return { kind: 'error', text: `保存失败：${written.error ?? '未知原因'}（配置未改动）` }
    }
    return {
      kind: 'success',
      text:
        `已把 ${guide.key} 设为 ${formatSetting(guide, parsed.value)}。\n` +
        `重启 DSH 后生效。\n\n` +
        `作用：${guide.summary}`,
    }
  }

  // 其余一律当作路径。
  const preview = rest.split(/\s+/).includes('--preview')
  const pathText = rest.replace(/--preview/g, '').trim()
  if (pathText === '') {
    return {
      kind: 'error',
      text: `要删除什么？用法：/safe-delete <路径>\n例如：/safe-delete C:\\Work\\proj\\build`,
    }
  }
  const result = await deps.delete(pathText, { preview })
  return { kind: result.ok ? 'success' : 'error', text: result.text }
}
