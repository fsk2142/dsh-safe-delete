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
  /**
   * 现在清理一次；`dryRun` 只报告。
   *
   * `failures` 是**移入回收站失败、因此仍留在安全区**的条目及原因。
   * 必须显示给用户：否则他会以为清理成功，而磁盘没释放、条目其实还在。
   */
  clean: (dryRun: boolean) => Promise<{
    removed: readonly string[]
    freedBytes: number
    failures?: readonly string[]
    /**
     * 后台清理的调度状态（2026-11-01 审查 SD-16）。
     *
     * 清理现在跑在独立进程里，所以"移除了几项"通常为 0 —— 但那**不等于**
     * "没有东西可清理"。三件事必须能区分：
     *
     *   - `started`：已派发后台任务；
     *   - `busy`：已有 worker 在跑，本轮没启动；
     *   - `failed`：派发失败（含原因）。
     *
     * 第一版没有这个字段，于是"已后台启动"和"worker 正忙"都回复
     * "没有需要清理的条目（都还在保留期内）" —— 用户以为无事可做，
     * 而清理其实正在进行或根本没开始。
     */
    scheduled?: {
      started: boolean
      reason?: string
    }
  }>
  /** 读当前配置。 */
  readConfig: () => Promise<Record<string, unknown>>
  /** 写一项配置。 */
  writeConfig: (key: string, value: number | boolean | string) => Promise<{ ok: boolean; error?: string }>
  /** 状态摘要。 */
  status: () => Promise<string>
}

/** 帮助文本。 */
const HELP = `安全删除 —— 把删除变成可撤销的操作

用法：
  /safe-delete <路径>              把文件或目录移入安全区（默认 1 天内可取回）
  /safe-delete <路径> --preview    只看会发生什么，不真的移动
  /safe-delete list                列出安全区里的条目
  /safe-delete restore <id>        把某个条目取回原位
  /safe-delete clean               立即清空安全区（不看保留期）
  /safe-delete clean --dry-run     只报告会清理什么，不动手
  /safe-delete config              查看所有可配置项、当前值、含义与范围
  /safe-delete config <项> <值>     修改一项配置（例如 config confirmBytes 512MB）
  /safe-delete status              安全区概况

提示：这里的删除**不是永久删除** —— 东西先进安全区（默认 1 天），到期后移入
系统回收站，你仍能在那里取回，直到自己清空回收站。`

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
  lines.push('  /safe-delete config confirmBytes 512MB  超过 512 MB 的删除要确认')
  lines.push('  /safe-delete config confirmFileCount 100 超过 100 条的删除要确认')
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
 * 从原文里删掉**恰好独立成段**的某个 flag，保留其余字节一一对应。
 *
 * ## 为什么不能用"分词 → 过滤 → join"（2026-11-01 定版复核第 4 项）
 *
 * 那条路径会把连续空格压成一个：`C:\My  Files\x` 变成 `C:\My Files\x`。
 * 若两个目录都存在，被操作的是用户**没有指定**的那个 —— 这是"路径保真"
 * 问题，不是格式化问题。
 *
 * ## 做法
 *
 * 扫描原文，记录引号外的空白分段边界。只有当某一段**完全等于** flag 时，
 * 才把它连同**一侧**的空白删掉（选它前面那段，避免影响后续偏移）。
 * 其余所有字节（含重复空格、制表符、引号）原样保留。
 *
 * @param text 原始参数串。
 * @param flag 要移除的 flag（如 `--preview`）。
 * @returns 处理后的文本与是否移除过。
 */
function stripStandaloneFlag(text: string, flag: string): { text: string; removed: boolean } {
  /** 每一段的 [start, end) —— 只记录引号外的空白切分。 */
  const spans: Array<{ start: number; end: number }> = []
  let quote: "'" | '"' | null = null
  let segStart = -1

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      if (segStart === -1) segStart = i
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (segStart !== -1) {
        spans.push({ start: segStart, end: i })
        segStart = -1
      }
      continue
    }
    if (segStart === -1) segStart = i
  }
  if (segStart !== -1) spans.push({ start: segStart, end: text.length })

  // 从后往前删，避免偏移失效。
  let out = text
  let removed = false
  for (let k = spans.length - 1; k >= 0; k -= 1) {
    const span = spans[k] as { start: number; end: number }
    if (out.slice(span.start, span.end) !== flag) continue
    /*
     * 连同**前面**的空白一起删（若有），否则删后面的。
     *
     * 只删一侧：路径内部的重复空格在另一侧，不受影响。
     */
    let cutFrom = span.start
    while (cutFrom > 0 && /\s/.test(out[cutFrom - 1] as string)) cutFrom -= 1
    let cutTo = span.end
    if (cutFrom === span.start) {
      // 前面没有空白（flag 在开头）—— 删后面的空白。
      while (cutTo < out.length && /\s/.test(out[cutTo] as string)) cutTo += 1
    }
    out = out.slice(0, cutFrom) + out.slice(cutTo)
    removed = true
  }

  return { text: out, removed }
}

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
    const failures = result.failures ?? []
    const scheduled = result.scheduled

    /*
     * ## 后台调度状态优先（2026-11-01 审查 SD-16）
     *
     * 清理跑在独立进程里，所以 `removed` 通常是空 —— 那不表示"无事可做"。
     * 必须先看 `scheduled`：
     *
     *   - 已启动 → 告诉用户后台在跑，并说明结果怎么看；
     *   - 没启动 → 说明原因（worker 忙、锁被占、派发失败）。
     *
     * 第一版把这两种都和"真的没有过期条目"混成一件事，用户会以为
     * 清理成功了（或无事可做），而实际状态完全不同。
     */
    if (scheduled !== undefined) {
      if (scheduled.started) {
        return {
          kind: 'success',
          text:
            '已在后台开始清理。\n' +
            '清理在独立进程里跑，所以本命令立即返回；用 `/safe-delete status` 查看进度与结果。',
        }
      }
      /*
       * 没启动：说明原因，并区分"真的没有可清理的"与"这次没能启动"。
       */
      const reason = scheduled.reason ?? 'unknown'
      if (result.removed.length === 0 && failures.length === 0) {
        return {
          kind: 'error',
          text:
            `清理**没有启动**：${reason}\n` +
            '这不等于"没有需要清理的条目" —— 后台任务未运行，安全区未被改动。\n' +
            '稍后重试，或用 `/safe-delete status` 查看当前状态。',
        }
      }
    }

    if (result.removed.length === 0 && failures.length === 0) {
      // 走到这里说明没有调度信息（旧路径），或调度已启动但还没结果 ——
      // 前者是"真的没有可清理的条目"，后者上面的分支已经返回了。
      return { kind: 'success', text: '没有需要清理的条目（都还在保留期内）。' }
    }

    const lines: string[] = []
    if (result.removed.length > 0) {
      const head = dryRun
        ? `将移入回收站 ${result.removed.length} 项（dry run，什么都没动）：`
        : `已移入回收站 ${result.removed.length} 项：`
      lines.push(head, ...result.removed.map((item) => `  ${item}`))
    }

    // 失败必须显式列出：否则用户以为清完了，而磁盘没释放、条目还在安全区。
    if (failures.length > 0) {
      lines.push('', `⚠ ${failures.length} 项未能移入回收站，已**留在安全区**（不会永久删除）：`)
      lines.push(...failures.map((item) => `  ${item}`))
      return { kind: 'error', text: lines.join('\n') }
    }

    if (!dryRun) lines.push('', '回收站里在你清空之前都能还原。')
    return { kind: 'success', text: lines.join('\n') }
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

  /*
   * 其余一律当作路径。
   *
   * ## 只移除**独立的** `--preview` token（2026-11-01 审查 SD-12）
   *
   * 第一版是 `rest.replace(/--preview/g, '')` —— **全局字符串替换**，
   * 于是文件名里的同样子串也被抹掉：
   *
   * ```
   * /safe-delete C:\Work\foo--previewbar
   *   → 路径变成 C:\Work\foobar
   *   → 删掉的是用户**没有指定**的对象
   * ```
   *
   * 这比"没生效"严重得多：目标是错的，而且用户看到的输入是对的。
   *
   * 现在按空白分词，只丢弃**恰好等于** `--preview` 的那一段，
   * 其余字节原样拼回。带引号的路径也不会被破坏（引号内的空格不切分）。
   */
  /*
   * ## 路径必须按**原文位置**保留（2026-11-01 定版复核第 4 项）
   *
   * 第一版是 `tokens.filter(t => t !== '--preview').join(' ')` —— 分词再拼回。
   * 那个 `join(' ')` 把**连续空格压成一个**：
   *
   * ```
   * 输入  C:\My  Files\x     （My 后两个空格）
   * 实际  C:\My Files\x      （一个空格）
   * ```
   *
   * 若两个目录都存在，被移走的是用户**没有指定**的那个。
   *
   * 现在：扫描原文，只把"恰好是 `--preview` 的那一段"连同它一侧多余空白
   * 删掉，其余字节原样保留。没有选项时 `rest` 原样使用（`trim` 只去首尾）。
   */
  const stripped = stripStandaloneFlag(rest, '--preview')
  const preview = stripped.removed
  const pathText = stripped.text.trim()
  if (pathText === '') {
    return {
      kind: 'error',
      text: `要删除什么？用法：/safe-delete <路径>\n例如：/safe-delete C:\\Work\\proj\\build`,
    }
  }
  const result = await deps.delete(pathText, { preview })
  return { kind: result.ok ? 'success' : 'error', text: result.text }
}
