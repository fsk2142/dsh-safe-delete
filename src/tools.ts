/**
 * 工具定义：`safe_delete`、四个安全区管理工具，以及审计流水。
 *
 * 这里刻意**手写 JSON Schema 子集**而不 import `defineTool` —— 以 `link:` 裸装的
 * bundle 没有自带 node_modules，import `@deepseek-ai/*` 会在 DSH 启动时解析失败。
 *
 * `safe_delete` 是整个插件里唯一会移动用户数据的入口。它的执行顺序就是它的
 * 正确性：先证明目标存在且不是禁区，再描述，再（必要时）问人，最后才移动。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { appendAudit, appendAuditBatch, readAudit, type AuditRecord } from './audit'
import type { ClassifyEnv } from './classify'
import {
  decideGate,
  deletePath,
  describeMoved,
  describePreview,
  humanBytes,
  type DeleteContext,
  type DeleteRequest,
} from './delete-core'
import { describeTarget } from './describe'
import { matchInTree, parseDuration } from './match'
import { selectForPrune, safeZoneBytes } from './prune'
import type { Recycler } from './recycle'
import { canRecycle } from './recycle'
import { discardEntryContent, destroyEntry, isEmptySafeZone, listSafeZone, moveManyToSafeZone, moveToSafeZone, restoreFromSafeZone, writeIndexFiltered } from './store'
import type { TrashEntry } from './types'

/** 审批结果词汇（与 DSH `ApprovalOutcome` 一致）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 工具执行结果。 */
export interface ToolResult {
  ok: boolean
  text: string
  error?: string
}

/** 单个属性的 schema（参数与输出通用）。 */
export interface JsonSchemaProperty {
  type: string
  description?: string
  enum?: string[]
  /** 仅 `type: 'array'` 时有意义：元素 schema。 */
  items?: { type: string; description?: string }
}

/** 手写的 JSON Schema 子集。 */
export interface JsonSchemaSubset {
  type: 'object'
  properties: Record<string, JsonSchemaProperty>
  required: string[]
  additionalProperties: false
}

/** 一个工具定义。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchemaSubset
  output: {
    schema: JsonSchemaSubset
    render: (args: Record<string, unknown>, value: ToolResult) => Array<{ type: 'text'; text: string }>
  }
  execute(args: Record<string, unknown>): Promise<ToolResult>
}

/** 工具依赖（由插件入口注入，便于测试）。 */
export interface ToolDeps {
  stateDir: string
  env: ClassifyEnv
  /** 请求用户授权；无审批通道时返回 `'unavailable'`。 */
  requestApproval: (reason: string) => Promise<ApprovalOutcome>
  retentionDays: number
  /**
   * 是否按保留期自动清理（默认 true）。
   *
   * 关掉后安全区只增不减，需要手动清理。
   */
  autoPrune?: boolean
  /**
   * 单次删除的条目数阈值：超过就额外要一次人工确认。
   *
   * `0` 表示不启用。与路径分级相互独立 —— 两者任一命中都要确认。
   */
  confirmFileCount?: number
  /** 单次删除的字节数阈值：超过就额外要一次人工确认。`0` 表示不启用。 */
  confirmBytes?: number
  /**
   * 跨卷时是否允许「复制 + 删源」。
   *
   * 从配置透传到删除核心 —— 不透传的话这个开关只在 schema 与 README 里存在，
   * 用户打开它毫无效果。
   */
  crossVolumeCopy?: boolean
  /**
   * 可替换的「移入回收站」实现（仅测试用）。
   *
   * 真实实现要起 PowerShell / osascript 子进程，测试里跑它既慢又会污染系统回收站。
   * 生产路径不传，默认走 `moveToSystemRecycleBin`。
   */
  recycler?: Recycler
  /** 当前时间（测试可注入）。 */
  now?: () => number
}

/** 参数 spec → JSON Schema 子集。 */
function toJsonSchema(spec: Record<string, JsonSchemaProperty & { required?: boolean }>): JsonSchemaSubset {
  const properties: JsonSchemaSubset['properties'] = {}
  const required: string[] = []
  for (const [key, meta] of Object.entries(spec)) {
    const prop: JsonSchemaProperty = { type: meta.type }
    if (meta.description !== undefined) prop.description = meta.description
    if (meta.enum !== undefined) prop.enum = meta.enum
    // `items` 必须一起带过去：丢了它，数组参数在线上的 schema 里只剩
    // `{ type: 'array' }`，模型不知道该传什么元素类型，很可能干脆不用这个参数。
    if (meta.items !== undefined) prop.items = meta.items
    properties[key] = prop
    if (meta.required === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** 输出 schema：所有工具统一返回 ok/text/error。 */
const OUTPUT_SCHEMA: JsonSchemaSubset = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['ok', 'text'],
  additionalProperties: false,
}

/** 构造一个工具，统一异常转换（绝不把异常抛进工具管线）。 */
function makeTool(spec: {
  name: string
  description: string
  parameters: Record<string, JsonSchemaProperty & { required?: boolean }>
  execute: (args: Record<string, unknown>) => Promise<ToolResult>
  /** 每次执行前的钩子（用于按间隔触发清理）。钩子失败不影响工具本身。 */
  beforeExecute?: () => Promise<void>
}): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: toJsonSchema(spec.parameters),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text !== '' ? value.text : (value.error ?? '(empty)') }],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      if (spec.beforeExecute !== undefined) {
        try {
          await spec.beforeExecute()
        } catch {
          /* 钩子失败不阻断工具调用 */
        }
      }
      try {
        return await spec.execute(args)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, text: '', error: `[dsh-safe-delete] ${message}` }
      }
    },
  }
}

/** 描述单次删除的确认阈值。 */
function describeThresholds(deps: ToolDeps): string {
  const count = deps.confirmFileCount ?? 0
  const bytes = deps.confirmBytes ?? 0
  if (count <= 0 && bytes <= 0) return 'disabled'
  const parts: string[] = []
  if (count > 0) parts.push(`${count} entries`)
  if (bytes > 0) parts.push(humanBytes(bytes))
  return parts.join(' or ')
}

/**
 * 把工具参数统一成「待删除路径列表」。
 *
 * 三种输入形态，**互斥**：
 *
 * | 形态 | 参数 | 用途 |
 * |---|---|---|
 * | 单个 | `path` | 一个字面路径（可以是目录） |
 * | 多个 | `paths` | 若干字面路径 |
 * | 模式 | `root` (+ `match` / `olderThan` / `exclude`) | 在目录树里挑 |
 *
 * 为什么不做「两者都给就合并」：那会让调用方以为可以随便混用，实际行为取决于
 * 顺序，是模糊语义。明确互斥，出错时给出清楚的提示，比"聪明地合并"更可靠。
 *
 * ## 模式形态**不做枚举**
 *
 * 这个函数被 `pre-execute` 钩子在**每次工具调用前**调用。如果在这里扫盘，
 * 一次 `root: <node_modules>, match: **\/*.json` 要 529 ms —— 而钩子对所有
 * 工具调用都跑，等于让整个 DSH 变慢。
 *
 * 所以模式形态只返回 `root` 本身，让钩子做**保守的路径分类判定**（纯字符串
 * 运算，0 ms）。真正的枚举发生在工具执行体里（`resolveMatchedTargets`），
 * 那时已经确定用户就是要执行这次删除。
 *
 * @param args 工具原始参数。
 * @returns 路径列表，或一条错误信息。
 */
export function normaliseDeleteTargets(
  args: Record<string, unknown>,
): { paths: string[]; error?: undefined } | { paths?: undefined; error: string } {
  const single = typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined
  const list = Array.isArray(args.paths)
    ? args.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim())
    : undefined
  const root = typeof args.root === 'string' && args.root.trim() !== '' ? args.root.trim() : undefined
  const pattern = typeof args.match === 'string' && args.match.trim() !== '' ? args.match.trim() : undefined
  const olderThanRaw = typeof args.olderThan === 'string' && args.olderThan.trim() !== '' ? args.olderThan.trim() : undefined

  /*
   * `exclude` 必须是字符串数组；**传了非数组要报错，不能静默当空**。
   *
   * 静默忽略的后果是删得比用户预期多：他写了排除规则，以为某些目录会被保留，
   * 实际全部命中、全部移走。宁可让他重传一次。
   */
  if (args.exclude !== undefined && !Array.isArray(args.exclude)) {
    return { error: '`exclude` must be an array of glob strings, e.g. ["keep/**"]' }
  }
  const excludeRaw = Array.isArray(args.exclude)
    ? args.exclude.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim())
    : []
  // 数组里混了非字符串（数字、null）同样报错，别静默丢掉。
  if (Array.isArray(args.exclude) && excludeRaw.length !== args.exclude.length) {
    return { error: '`exclude` entries must be non-empty glob strings' }
  }

  const usesPatternForm = root !== undefined || pattern !== undefined || olderThanRaw !== undefined || excludeRaw.length > 0

  if (single !== undefined && list !== undefined && list.length > 0) {
    return { error: 'pass either `path` (one item) or `paths` (several), not both' }
  }
  if ((single !== undefined || (list !== undefined && list.length > 0)) && usesPatternForm) {
    return { error: '`root`/`match`/`olderThan`/`exclude` cannot be combined with `path` or `paths`' }
  }

  // 模式形态：只校验参数完备性，**不接触磁盘**。
  if (usesPatternForm) {
    if (root === undefined) {
      return { error: '`match`/`olderThan`/`exclude` need `root` (the directory to search in)' }
    }
    if (olderThanRaw !== undefined && parseDuration(olderThanRaw) === undefined) {
      return { error: `cannot parse \`olderThan\` "${olderThanRaw}"; use forms like 30m, 6h, 7d` }
    }
    /*
     * 返回 root 本身。
     *
     * 钩子据此做路径分类（root 在保护区/家目录 → ask），**不会**误以为要删
     * root 本身 —— 执行体在 `resolveMatchedTargets` 里会重新取值，那时才枚举，
     * 且枚举结果不含 root。
     */
    return { paths: [root] }
  }

  if (single !== undefined) return { paths: [single] }
  if (list !== undefined && list.length > 0) {
    // 去重：同一个路径传两次会让第二个变成 "not found"，是噪音而不是错误。
    return { paths: [...new Set(list)] }
  }
  return { error: 'pass `path` (one item), `paths` (an array), or `root` with `match`' }
}

/**
 * 把模式形态展开成真正要删的路径列表。
 *
 * **只在工具执行体里调用** —— 会真的扫盘（`node_modules` 量级约 500 ms）。
 *
 * @param args 工具原始参数。
 * @returns 命中路径；空数组表示没有匹配。
 */
export function resolveMatchedTargets(args: Record<string, unknown>): { paths: string[]; scanned: number; truncated: boolean } {
  const root = typeof args.root === 'string' ? args.root.trim() : ''
  const pattern = typeof args.match === 'string' && args.match.trim() !== '' ? args.match.trim() : undefined
  const olderThanRaw = typeof args.olderThan === 'string' && args.olderThan.trim() !== '' ? args.olderThan.trim() : undefined
  const exclude = Array.isArray(args.exclude)
    ? args.exclude.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim())
    : []
  const olderThanMs = olderThanRaw === undefined ? undefined : parseDuration(olderThanRaw)

  const r = matchInTree({
    root,
    ...(pattern === undefined ? {} : { pattern }),
    ...(olderThanMs === undefined ? {} : { olderThanMs }),
    ...(exclude.length === 0 ? {} : { exclude }),
  })
  return { paths: r.paths, scanned: r.scanned, truncated: r.truncated }
}

/**
 * 批量删除：**一次审批覆盖整批**，逐条执行，汇总结果。
 *
 * ## 为什么合并审批
 *
 * 每删除一个文件弹一次确认，删 20 个就要点 20 次 —— 用户会开始无脑点"允许"，
 * 确认就失去了意义。合并成一次、并在文案里写清"共 N 项、合计 X 字节、其中哪些
 * 需要你确认"，人才能真正判断。
 *
 * ## 逐条执行而不是打包
 *
 * 每条独立走 `deletePath`，所以：单条失败不影响其他条；每条都有自己的审计记录；
 * 单条的保护区/安全区自检照常生效。批量的意义是省调用次数与确认次数，不是绕过检查。
 *
 * @param paths 待删除路径。
 * @param base 公共请求参数（preview / reason）。
 * @param ctx 删除上下文；审批调用会被替换成"合并版"。
 * @returns 工具结果。
 */
async function deleteMany(
  paths: string[],
  base: Pick<DeleteRequest, 'preview' | 'reason'>,
  ctx: DeleteContext,
): Promise<{ ok: boolean; text: string; error?: string }> {
  // 1. 先给每一条做描述与门禁判定（只读，不动任何东西）。
  interface Plan {
    target: string
    description: ReturnType<typeof describeTarget>
    gate: ReturnType<typeof decideGate>
  }
  const plans: Plan[] = []
  const immediatelyRejected: Array<{ target: string; error: string }> = []

  for (const target of paths) {
    const resolved = path.resolve(target)
    if (!existsSync(resolved)) {
      immediatelyRejected.push({ target: resolved, error: 'not found' })
      continue
    }
    const description = describeTarget(resolved)
    plans.push({ target: resolved, description, gate: decideGate(resolved, description, ctx) })
  }

  // 2. 预览：只列出会移动什么、哪些需要确认。
  if (base.preview === true) {
    const lines: string[] = [`PREVIEW (nothing moved): ${plans.length} item(s)`]
    let totalBytes = 0
    for (const plan of plans) {
      totalBytes += plan.description.bytes
      const size = plan.description.isDirectory
        ? `dir, ${plan.description.fileCount} entries, ${humanBytes(plan.description.bytes)}`
        : `file, ${humanBytes(plan.description.bytes)}`
      const needs = plan.gate.needsApproval ? ` — needs your OK (${plan.gate.reasons.join('; ')})` : ''
      lines.push(`  ${plan.target}  [${size}]${needs}`)
    }
    if (immediatelyRejected.length > 0) {
      lines.push('', `Skipped (${immediatelyRejected.length}):`)
      for (const item of immediatelyRejected) lines.push(`  ${item.target} — ${item.error}`)
    }
    const needing = plans.filter((p) => p.gate.needsApproval).length
    lines.push(
      '',
      `total: ${humanBytes(totalBytes)}${needing > 0 ? `; ${needing} item(s) would need one confirmation` : ''}`,
    )
    return { ok: true, text: lines.join('\n') }
  }

  // 3. 需要确认的项：合并成**一次**审批。
  const needing = plans.filter((p) => p.gate.needsApproval)
  if (needing.length > 0) {
    const totalBytes = needing.reduce((sum, p) => sum + p.description.bytes, 0)
    const totalFiles = needing.reduce((sum, p) => sum + p.description.fileCount, 0)
    const reasons = [...new Set(needing.flatMap((p) => p.gate.reasons))]
    const sample = needing.slice(0, 5).map((p) => p.target)
    const more = needing.length > sample.length ? `\n  …and ${needing.length - sample.length} more` : ''
    const text =
      `Delete ${needing.length} item(s) in one batch? ` +
      `Total ${totalFiles} entries, ${humanBytes(totalBytes)}.\n` +
      `Why this needs your OK: ${reasons.join('; ')}.\n` +
      `Items:\n  ${sample.join('\n  ')}${more}\n\n` +
      `Approving covers the whole batch. Everything goes into the safe zone and can be restored ` +
      `with safe_zone_restore for ${ctx.retentionDays} day(s).`

    const outcome = await ctx.requestApproval(text)
    if (outcome !== 'allowed-once') {
      return {
        ok: false,
        text: '',
        error:
          `batch delete of ${needing.length} item(s) was not approved (${outcome}); nothing was moved. ` +
          'Ask the user how they want to proceed.',
      }
    }
  }

  /*
   * 4. 批量执行：索引只在最后写一次。
   *
   * ## 为什么不再逐条调 `deletePath`
   *
   * `deletePath` 每成功一条就重写整个 `index.json`。删到第 N 条时索引已有 N-1
   * 条，累计重写量 O(N²) —— 1000 个文件实测在数秒级（4–6 秒），而删一个含 1000
   * 文件的目录只要 24 ms（一次 rename）。
   *
   * 这里改成 `moveManyToSafeZone`：分级判定、保护区、安全区自检、回滚策略全都不变
   * （共用 `stageInto`），只是把"写索引"提到循环外。
   *
   * ## 审批已经在上一步覆盖整批
   *
   * 所以这一步不再问任何人。
   */
  const moved: string[] = []
  const failed: Array<{ target: string; error: string }> = [...immediatelyRejected]

  const batch = await moveManyToSafeZone(
    ctx.stateDir,
    plans.map((p) => p.target),
    {
      retentionDays: ctx.retentionDays,
      now: ctx.now(),
      ...(ctx.crossVolumeCopy === true ? { crossVolumeCopy: true } : {}),
      ...(base.reason !== undefined && base.reason !== '' ? { reason: base.reason } : {}),
    },
  )

  // 逐条记账（审计要一条一条写，这是记录不是批处理）。
  /*
   * 记账：审计**一次批量写入**，不是逐条写。
   *
   * 实测 1000 条逐条 `appendAudit` 要 728 ms（每条 6 次系统调用做半行检查），
   * 比移动本身（347 ms）还贵。批量入口只需要在批首检查一次半行。
   */
  const auditRecords: Array<Omit<AuditRecord, 'at'>> = []
  for (const item of batch) {
    if (item.entry !== undefined) {
      moved.push(`${item.path}  →  id ${item.entry.id}`)
      auditRecords.push({
        event: 'delete',
        target: item.path,
        tool: 'safe_delete',
        detail: `id=${item.entry.id} batch`,
      })
    } else {
      failed.push({ target: item.path, error: item.error ?? 'unknown error' })
    }
  }
  appendAuditBatch(ctx.stateDir, auditRecords)

  // 清理：批量移动完成后按原逻辑触发一次（`afterMove` 是可选的）。
  if (ctx.afterMove !== undefined) await ctx.afterMove()

  /*
   * 输出按次计费，所以批量结果**不逐个列出成功项**。
   *
   * 删除 100 个文件时，逐条打印路径 + id 会产生几千 token，而模型接下来通常
   * 只会说一句"删好了"。真正需要知道的是：删了几个、失败的是哪几个、怎么取回。
   *
   * 失败项仍然逐条列出 —— 那些是需要处理的异常，模型必须看到。
   * 完整清单在 safe_zone_list 里，需要时再查。
   */
  const lines: string[] = [`Deleted ${moved.length} of ${paths.length} item(s) into the safe zone (${humanBytes(
    plans.reduce((sum, p) => sum + p.description.bytes, 0),
  )}).`]
  // 少量成功项时列出路径（方便用户核对）；多了就只给数量。
  if (moved.length <= 5) {
    lines.push(...moved.map((m) => `  ${m}`))
  } else {
    lines.push(...moved.slice(0, 3).map((m) => `  ${m}`), `  …and ${moved.length - 3} more`)
  }
  if (failed.length > 0) {
    lines.push('', `Failed (${failed.length}) — these were NOT moved:`)
    lines.push(...failed.map((f) => `  ${f.target} — ${f.error}`))
  }
  lines.push('', `Restorable with safe_zone_restore for ${ctx.retentionDays} day(s).`)
  return { ok: failed.length === 0, text: lines.join('\n') }
}

/** 创建全部工具。 */
export function createTools(deps: ToolDeps): ToolDefinition[] {
  const now = deps.now ?? (() => Date.now())

  /** 上次真正跑清理的时间；`null` 表示本进程还没跑过。 */
  let lastPruneAt: number | null = null

  /**
   * 按策略清理安全区；返回**真正移入回收站**的条目。
   *
   * ## 为什么不再逐条调 `destroyEntry`
   *
   * `destroyEntry` 每次**读全量索引 + 写全量索引**。N 条过期 → N 次全量读写，
   * 总成本 O(N²)。实测：
   *
   *     600 条   → 1.26 s  (2.1 ms/条)
   *     3000 条  → 12.93 s (4.3 ms/条)   ← 每条耗时翻倍，超线性
   *
   * 真实触发场景：用户外出数日、保留期 1 天，回来后索引里积累数千条过期条目；
   * 此后**每次**工具调用都会重跑这个循环，而它在串行队列里，会阻塞其他调用。
   *
   * ## 改法
   *
   * 读一次索引 → 逐条处理内容 → 收集幸存条目 → 写一次。与 `moveManyToSafeZone`
   * 同款模式。审计改为一次批量写（`appendAuditBatch`）。
   *
   * ## 行为不变
   *
   * - 回收失败的条目**留在安全区**（宁可占盘，也不能因为回收站不可用就永久删）
   * - 每条一条审计记录
   * - 返回值仍是"真正移入回收站"的那些
   */
  const pruneNow = async (): Promise<TrashEntry[]> => {
    if (deps.autoPrune === false) return []
    const entries = await listSafeZone(deps.stateDir)
    // 只看保留期：没有容量层，没有百分比阈值。
    const selected = selectForPrune(entries, { now: now() })
    if (selected.length === 0) return []

    const removed: TrashEntry[] = []
    const auditRecords: Array<Omit<AuditRecord, 'at'>> = []

    // 逐条**只处理内容**（回收站 / 丢弃），不碰索引。
    for (const entry of selected) {
      const result = await discardEntryContent(deps.stateDir, entry.id, {
        ...(deps.recycler === undefined ? {} : { recycler: deps.recycler }),
      })
      if (!result.ok) {
        auditRecords.push({
          event: 'prune',
          target: entry.originalPath,
          detail: `id=${entry.id} skipped: ${result.reason}`,
        })
        continue
      }
      removed.push(entry)
      auditRecords.push({
        event: 'prune',
        target: entry.originalPath,
        detail: `id=${entry.id} bytes=${entry.bytes} via=${result.via}`,
      })
    }

    /*
     * 索引只写一次：把成功清掉的那些移除。
     *
     * **不传 `entries`（那份快照）** —— `writeIndexFiltered` 会在锁内重读最新
     * 索引再过滤。传快照会让窗口期内并发移入的条目被整个覆盖掉（实测 4 个孤儿）。
     *
     * 失败的条目留在索引里 —— 下轮 prune 会再试（届时回收站若恢复就能清掉）。
     */
    if (removed.length > 0) {
      const gone = new Set(removed.map((e) => e.id))
      await writeIndexFiltered(deps.stateDir, (e) => !gone.has(e.id))
    }

    appendAuditBatch(deps.stateDir, auditRecords)
    return removed
  }

  /**
   * 按间隔调用 `pruneNow`。
   *
   * 为什么不是定时器：一个挂在事件循环上的 `setInterval` 会让插件在 DSH 空闲时
   * 也保有生命周期，而清理并不需要那种准时性。改为"每次工具调用顺路看一眼"，
   * 代价是插件彻底不用管定时器的清理与异常。
   */
  const pruneIfDue = async (): Promise<void> => {
    if (deps.autoPrune === false) return
    // 间隔参数已移除：现在每次工具调用都检查一次。
    //
    // 为什么不保留间隔：容量层去掉后，清理只是"扫一遍索引，挑出过期的"，
    // 开销从"可能搬上千个文件"降到"读一个 JSON"。再为此维护一个计时器
    // 和它的持久化，反而更复杂。
    const at = now()
    if (lastPruneAt !== null && at - lastPruneAt < 1000) return
    lastPruneAt = at
    try {
      await pruneNow()
    } catch {
      /* 清理失败不该让工具调用失败 */
    }
  }

  const safeDelete = makeTool({
    name: 'safe_delete',
    description:
      // 工具描述在每次请求里都会发给模型，是最该精简的地方。
      // 原来这里把「batch 更省」「危险路径要审批」「先 preview」各说了两遍
      // （描述里一遍、参数描述里一遍），压掉重复不损失任何信息。
      'Move files/directories into the safe zone (restorable via safe_zone_restore). This is the ONLY sanctioned way to delete in DSH; raw shell deletes are blocked. ' +
      'Pass `paths` to delete several in one call — one approval covers the batch. ' +
      'To clear generated output, prefer `root` + `match` (e.g. root a `.tmp` dir, match `**/*.log`) over enumerating files yourself: one call, one approval, and it stays O(n). ' +
      'Dangerous paths (home dir, plugin sources, profile manifests, node_modules) need user approval; ordinary workspace files move silently. ' +
      'Use `preview: true` to see what would move without moving it.',
    parameters: {
      path: { type: 'string', description: 'One absolute path (file or directory). Mutually exclusive with `paths` and `root`.' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Several absolute paths in one call. Mutually exclusive with `path` and `root`.',
      },
      root: {
        type: 'string',
        description:
          'Directory to search in. Required by match/olderThan/exclude. The root itself is never deleted, only matched items inside it.',
      },
      match: {
        type: 'string',
        description: 'Glob relative to `root`: `**` any depth, `*` one level, `?` one char, `{a,b}` alternatives. Omit to match every file.',
      },
      olderThan: {
        type: 'string',
        description: 'Only items modified longer ago than this: 30m, 6h, 7d. A bare number means days.',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns relative to `root` to skip, e.g. `keep/**`. Exclude wins over match.',
      },
      preview: { type: 'boolean', description: 'Describe only; change nothing.' },
      reason: { type: 'string', description: 'Why this is deleted (recorded in audit).' },
      force: { type: 'boolean', description: 'Ignored; a model-set flag is never user approval.' },
    },
    beforeExecute: pruneIfDue,
    async execute(args) {
      const targets = normaliseDeleteTargets(args)
      if (targets.error !== undefined) return { ok: false, text: '', error: targets.error }

      /*
       * 模式形态（`root` + `match`/`olderThan`/`exclude`）到这里才枚举。
       *
       * `normaliseDeleteTargets` 故意只返回 root —— 它在 pre-execute 钩子里
       * 每次工具调用都跑，不能扫盘（node_modules 量级要 529 ms）。
       * 到了执行体，说明用户确实要执行，枚举一次是必要的。
       */
      const usesPatternForm =
        typeof args.root === 'string' && args.root.trim() !== ''
      let resolvedPaths = targets.paths
      if (usesPatternForm) {
        const matched = resolveMatchedTargets(args)
        if (matched.paths.length === 0) {
          /*
           * 「没匹配到」必须报错，不能静默成功。
           *
           * 用户看到 ok 会以为删掉了；实际可能只是模式写错（`*.log` 写成
           * `*.1og`）或 root 指错目录。扫过多少条一并给出，便于判断是哪种。
           */
          const bits: string[] = []
          if (typeof args.match === 'string') bits.push(`pattern "${args.match}"`)
          if (typeof args.olderThan === 'string') bits.push(`older than ${args.olderThan}`)
          const excl = Array.isArray(args.exclude) && args.exclude.length > 0 ? ` (excluded ${args.exclude.length})` : ''
          return {
            ok: false,
            text: '',
            error:
              `no files matched in ${args.root}` +
              (bits.length > 0 ? ` for ${bits.join(' and ')}` : '') +
              excl +
              `; scanned ${matched.scanned} entries`,
          }
        }
        if (matched.truncated) {
          return {
            ok: false,
            text: '',
            error:
              `matched too many entries (stopped after ${matched.scanned}); ` +
              'narrow the pattern or use a deeper root to keep the batch reviewable',
          }
        }
        resolvedPaths = matched.paths
      }

      const deleteCtx = {
        stateDir: deps.stateDir,
        env: deps.env,
        retentionDays: deps.retentionDays,
        confirmFileCount: deps.confirmFileCount ?? 0,
        confirmBytes: deps.confirmBytes ?? 0,
        ...(deps.crossVolumeCopy === true ? { crossVolumeCopy: true } : {}),
        // 容量层已移除，所以没有容量相关的字段要传。
        // 空间预告现在只剩"跨盘复制会不会写不下"这一项。
        requestApproval: deps.requestApproval,
        now,
        afterMove: () => pruneNow(),
      }
      const base = {
        preview: args.preview === true,
        ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
      }

      // 单路径：保持原有行为不变。
      if (resolvedPaths.length === 1) {
        const result = await deletePath({ ...base, path: resolvedPaths[0] as string }, deleteCtx)
        if (!result.ok) return { ok: false, text: '', error: result.error }
        return result.kind === 'preview'
          ? { ok: true, text: describePreview(result, deps.retentionDays) }
          : { ok: true, text: describeMoved(result, deps.retentionDays) }
      }

      // 多路径：合并成一次审批，批量执行（索引只写一次），汇总结果。
      return deleteMany(resolvedPaths, base, deleteCtx)
    },
  })

  const safeZoneList = makeTool({
    name: 'safe_zone_list',
    description: 'List what is currently in the safe zone, newest last, with ids you can pass to safe_zone_restore.',
    parameters: {
      limit: { type: 'integer', description: 'Max entries to show (default 20).' },
    },
    beforeExecute: pruneIfDue,
    async execute(args) {
      const entries = await listSafeZone(deps.stateDir)
      if (entries.length === 0) return { ok: true, text: 'safe zone is empty' }
      /*
       * 默认只显示 20 条（原来是 50）。
       *
       * 输出按次计费：50 条 × 完整绝对路径 + ISO 日期 ≈ 700 token，而模型多数
       * 时候只想确认"有没有东西 / 最新的几个是什么"。真要看全部它会显式传 limit。
       *
       * 日期也从完整 ISO 截成 `MM-DD`：年份和毫秒对"哪天过期"没有信息量。
       */
      const limit = Math.max(1, Number(args.limit) || 20)
      const shown = entries.slice(-limit)
      const lines = shown.map(
        (e) =>
          `${e.id}  ${e.isDirectory ? '[dir] ' : '[file]'}  ${humanBytes(e.bytes)}  ` +
          `${new Date(e.expiresAt).toISOString().slice(5, 10)}  ${e.originalPath}`,
      )
      return {
        ok: true,
        text:
          `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in the safe zone` +
          ` (${humanBytes(safeZoneBytes(entries))}):\n` +
          lines.join('\n') +
          (entries.length > shown.length
            ? `\n… ${entries.length - shown.length} older entr(ies) not shown; pass limit to see more`
            : ''),
      }
    },
  })

  const safeZoneRestore = makeTool({
    name: 'safe_zone_restore',
    description:
      'Restore an item from the safe zone back to where it was deleted from. If that path is occupied, it restores next to it with a .restored-<timestamp> suffix instead of overwriting.',
    parameters: {
      id: { type: 'string', required: true, description: 'Safe-zone id (from safe_delete or safe_zone_list).' },
    },
    beforeExecute: pruneIfDue,
    async execute(args) {
      const id = String(args.id ?? '')
      if (id === '') return { ok: false, text: '', error: 'id is required' }
      const { restoredTo } = await restoreFromSafeZone(deps.stateDir, id)
      appendAudit(deps.stateDir, { event: 'restore', target: restoredTo, tool: 'safe_zone_restore', detail: `id=${id}` })
      return { ok: true, text: `restored to: ${restoredTo}` }
    },
  })

  const safeZoneStatus = makeTool({
    name: 'safe_zone_status',
    description: 'Show the safe zone state: entry count, total size, retention window, capacity cap, and when the next entries expire.',
    parameters: {},
    beforeExecute: pruneIfDue,
    async execute() {
      const entries = await listSafeZone(deps.stateDir)
      const total = safeZoneBytes(entries)
      const next = entries[0]
      // 输出按次计费，尽量用短标签。`state dir` 这类模型用不上的信息压成 dir。
      return {
        ok: true,
        text: [
          `dir: ${deps.stateDir}`,
          `entries: ${entries.length}  size: ${humanBytes(total)}`,
          `retention: ${deps.retentionDays}d (time-only, no capacity cap)`,
          `auto prune: ${deps.autoPrune === false ? 'off (manual only)' : 'on'}`,
          /*
           * 明确写出"什么时候才会真的清理"。
           *
           * 没有常驻定时器是刻意取舍（避免插件在 DSH 空闲时保有生命周期），
           * 代价是清理**不保证准点**：保留期到了，也要等下一次工具调用才动。
           * 不说清楚，用户会以为"1 天后自动进回收站"是准点的。
           */
          `prune runs: only when a safe_zone_* tool is called (no background timer)`,
          // 清理去哪是用户最该知道的一点：进回收站（可还原）还是永久删。
          `prune to: ${canRecycle() ? 'system recycle bin (restorable)' : `NOT SUPPORTED on ${process.platform} — entries stay put`}`,
          `confirm over: ${describeThresholds(deps)}`,
          next !== undefined ? `oldest expires in ${Math.max(0, Math.round((next.expiresAt - now()) / 86_400_000))}d` : 'safe zone is empty',
        ].join('\n'),
      }
    },
  })

  const safeZoneCheck = makeTool({
    name: 'safe_zone_check',
    description:
      'Read-only health check of the composition under $DSH_HOME: profile package.json parseable, cordis.patch.yml readable, ' +
      'row ids not duplicated across layers (duplicates break the next boot). Writes nothing.',
    parameters: {},
    beforeExecute: pruneIfDue,
    async execute() {
      return { ok: true, text: checkComposition(deps.env) }
    },
  })

  const safeZoneJournal = makeTool({
    name: 'safe_zone_journal',
    description:
      'Tail the audit trail: every blocked shell delete, blocked write to a boot-critical file, approval ask, deletion, restore and prune, newest first. ' +
      'Use it to answer "what happened" rather than "what is in the safe zone now".',
    parameters: {
      n: { type: 'integer', description: 'Number of records to show (default 20, max 200).' },
    },
    beforeExecute: pruneIfDue,
    async execute(args) {
      const limit = Math.min(200, Math.max(1, Number(args.n) || 20))
      const records = readAudit(deps.stateDir, limit)
      if (records.length === 0) return { ok: true, text: 'journal is empty' }
      return {
        ok: true,
        text: records
          .map((r) => {
            const when = r.at.slice(0, 19).replace('T', ' ')
            const parts = [when, r.event]
            if (r.tool !== undefined) parts.push(`tool=${r.tool}`)
            if (r.target !== undefined) parts.push(r.target)
            if (r.detail !== undefined) parts.push(`(${r.detail})`)
            return parts.join('  ')
          })
          .join('\n'),
      }
    },
  })

  return [safeDelete, safeZoneList, safeZoneRestore, safeZoneStatus, safeZoneCheck, safeZoneJournal]
}

/**
 * 只读体检：不写任何文件、不建快照。
 *
 * 检查项：profile 的 `package.json` 可解析、`cordis.patch.yml` 可读且非空、
 * 行 id 不跨层重复。
 */
export function checkComposition(env: ClassifyEnv): string {
  const dshHome = env.dshHome ?? path.join(env.home, '.dsh')
  const profilesRoot = path.join(dshHome, 'profiles')
  const lines: string[] = []
  let failed = false

  const profileDirs: string[] = []
  try {
    for (const name of readdirSync(profilesRoot)) {
      const dir = path.join(profilesRoot, name)
      if (existsSync(path.join(dir, 'package.json'))) profileDirs.push(dir)
    }
  } catch {
    /* 没有 profiles 目录时只是空检查 */
  }

  const rowIdsByFile = new Map<string, Map<string, string>>()

  for (const dir of profileDirs) {
    const manifest = path.join(dir, 'package.json')
    try {
      JSON.parse(readFileSync(manifest, 'utf8'))
      lines.push(`[ok] ${manifest}`)
    } catch (error) {
      failed = true
      lines.push(`[FAIL] ${manifest} — ${error instanceof Error ? error.message : String(error)}`)
    }

    const patch = path.join(dir, 'cordis.patch.yml')
    if (existsSync(patch)) {
      try {
        const text = readFileSync(patch, 'utf8')
        if (text.trim() === '') {
          failed = true
          lines.push(`[FAIL] ${patch} — empty patch file`)
        } else {
          lines.push(`[ok] ${patch}`)
          const ids = new Map<string, string>()
          let line = 0
          for (const raw of text.split(/\r?\n/)) {
            line += 1
            const match = /^\s*-\s+id:\s*(\S+)/.exec(raw)
            if (match !== null) ids.set(match[1]!, `${patch}:${line}`)
          }
          rowIdsByFile.set(patch, ids)
        }
      } catch (error) {
        failed = true
        lines.push(`[FAIL] ${patch} — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // 跨层重复行 id：「一行只能出现在一个层里」，重复会让下次启动失败。
  const seen = new Map<string, string>()
  for (const [, ids] of rowIdsByFile) {
    for (const [id, where] of ids) {
      const previous = seen.get(id)
      if (previous !== undefined) {
        failed = true
        lines.push(`[FAIL] duplicate row id "${id}": ${previous} and ${where}`)
      } else {
        seen.set(id, where)
      }
    }
  }

  if (profileDirs.length === 0) lines.push('no profiles found to check')

  lines.unshift(`safe_zone_check: ${failed ? 'FAIL' : 'PASS'}`)
  lines.push(failed ? 'Fix the FAIL items before restarting dsh.' : 'Composition looks safe to restart.')
  return lines.join('\n')
}

export { moveToSafeZone, restoreFromSafeZone, listSafeZone, destroyEntry, isEmptySafeZone }
