/**
 * 删除的核心流程。
 *
 * 抽出来的理由：同一个删除动作有三个入口 —— 模型工具 `safe_delete`、DSH 里的
 * 斜杠命令、终端里的 `dsh-safe-delete delete`。如果各写一份，它们迟早会在
 * 「谁需要审批」「阈值怎么算」「禁区怎么判」上分叉，而这类分叉的代价是一次
 * 本该被拦的删除被放过去。
 *
 * 所以这里只放**一个**实现，三个入口都调它。入口之间的差别只有两处：
 *   - 谁来做审批（工具走宿主审批线，命令与 CLI 走交互式确认）；
 *   - 返回值怎么呈现（模型看文本，人看终端输出）。
 *
 * @module dsh-safe-delete/delete-core
 */

import { existsSync, statfsSync } from 'node:fs'
import path from 'node:path'

import { appendAudit } from './audit'
import { classifyPath, requiresApproval, type ClassifyEnv } from './classify'
import { describeTarget } from './describe'
import { moveToSafeZone } from './store'
import type { Classification, TargetDescription, TrashEntry } from './types'

/** 删除请求。 */
export interface DeleteRequest {
  /** 目标路径（会被 resolve）。 */
  path: string
  /** 只描述、不动手。 */
  preview?: boolean
  /** 删除原因（进审计与安全区记录）。 */
  reason?: string
}

/** 删除所需的运行环境。 */
export interface DeleteContext {
  stateDir: string
  env: ClassifyEnv
  retentionDays: number
  /** 单次删除的条目数阈值；`0` 表示关闭。 */
  confirmFileCount: number
  /** 单次删除的字节数阈值；`0` 表示关闭。 */
  confirmBytes: number
  /*
   * 注意：这里曾经有 `safeZoneCapBytes`（安全区容量上限）与
   * `readSafeZoneUsageBytes`（读取当前占用），用于"删除前预告会不会撑爆安全区"。
   *
   * 容量层移除后，**没有调用方再传这两个字段**，超容量判定永远休眠。
   * 留着它们是死代码，还会让人以为插件仍在管理容量。已删除。
   */

  /**
   * 跨卷时是否允许「复制 + 删源」。
   *
   * 必须从配置透传到 `moveToSafeZone`：不透传的话，用户在配置里打开这个开关
   * 毫无效果，跨卷删除永远以 different volumes 拒绝 —— 一个只在文档里存在的开关。
   */
  crossVolumeCopy?: boolean
  /** 需要人工确认时调用；返回是否放行。 */
  requestApproval: (reason: string) => Promise<ApprovalOutcome>
  /** 当前时间（测试可注入）。 */
  now: () => number
  /** 移入安全区之后的清理钩子（可选）。 */
  afterMove?: () => Promise<TrashEntry[]>
}

/** 审批结果。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 判定结论：需要哪些确认理由。 */
export interface GateDecision {
  classification: Classification
  needsApproval: boolean
  /** 触发确认的理由（人话）。 */
  reasons: string[]
}

/** 删除结果。 */
export type DeleteResult =
  | { ok: true; kind: 'preview'; target: string; description: TargetDescription; gate: GateDecision }
  | { ok: false; error: string; target?: string }
  | {
      ok: true
      kind: 'moved'
      target: string
      entry: TrashEntry
      description: TargetDescription
      gate: GateDecision
      pruned: TrashEntry[]
    }

/** 驱动盘根判定。 */
function isDriveRoot(p: string): boolean {
  const resolved = path.resolve(p)
  return path.parse(resolved).root === resolved
}

/** 判断目标是否落在安全区自己的状态目录里。 */
function isInsideStateDir(target: string, stateDir: string): boolean {
  const state = path.resolve(stateDir)
  return target === state || target.startsWith(state + path.sep)
}

/**
 * 判定这一步要不要人确认，以及为什么。
 *
 * 两个**相互独立**的理由，任一命中就问一次（不叠加问两次，那只是骚扰）：
 *   a) 路径危险（家目录、profile 清单、node_modules…）；
 *   b) 这一单太大量（条目数或字节数超阈值）。
 */
export function decideGate(
  target: string,
  description: TargetDescription,
  ctx: Pick<DeleteContext, 'env' | 'confirmFileCount' | 'confirmBytes'>,
): GateDecision {
  const classification = classifyPath(target, ctx.env)
  const reasons: string[] = []

  if (requiresApproval(classification)) reasons.push(`it is a ${classification} path`)

  const countLimit = ctx.confirmFileCount
  if (countLimit > 0 && description.fileCount > countLimit) {
    reasons.push(`${description.fileCount} entries exceeds the limit of ${countLimit}`)
  }
  const bytesLimit = ctx.confirmBytes
  if (bytesLimit > 0 && description.bytes > bytesLimit) {
    reasons.push(`${description.bytes} bytes exceeds the limit of ${bytesLimit}`)
  }

  return { classification, needsApproval: reasons.length > 0, reasons }
}

/**
 * 一次删除的「空间后果」预估。
 *
 * 为什么需要它：安全区的容量上限只决定**何时清理**，不阻止删除。于是会出现两种
 * 用户没预期的情况：
 *
 *   1. 删进去的条目超过上限 → 同一轮的 `afterMove` 立刻把它清到回收站，
 *      但输出仍写着「7 天可恢复」；
 *   2. 跨卷时（源在 D、安全区在 C）会**真实复制一份到 C 盘**，把系统盘吃掉
 *      同等大小的空间，而"清理到回收站"只是同卷 rename，**并不会还回来**。
 *
 * 所以动手之前就要把这两件事说清楚。
 */
export interface SpaceForecast {
  /** 源与安全区是否真的在不同卷上（按盘符/挂载点判断，不看开关）。 */
  crossesVolumes: boolean
  /** 跨卷时需要复制过去的字节数（同卷为 0，因为 rename 不占额外空间）。 */
  copyBytes: number
  /** 安全区所在卷的剩余空间；`undefined` 表示取不到。 */
  freeBytes?: number
  /** 跨卷复制会不会写不下。 */
  copyWillNotFit: boolean
  /** 跨卷但没开 crossVolumeCopy —— 这次删除会被策略直接拒绝。 */
  blockedByPolicy: boolean
}

/**
 * 估算这次删除的**跨卷**后果。
 *
 * 只关心一件事：跨盘复制会不会把安全区所在盘写满。容量上限已移除，
 * 所以这里不再有"会不会撑爆安全区"的判定。
 *
 * 任何一项取不到（磁盘信息不可用）都**不阻断删除** —— 预估只是用来提示，
 * 不是权限判定。宁可少提示一句，也不该因为读不到磁盘信息就拒绝删除。
 *
 * @param description 目标描述（大小）。
 * @param ctx 删除上下文。
 * @param target 源路径（用于判断卷）。
 * @returns 预估结果。
 */
export async function forecastSpace(
  description: TargetDescription,
  ctx: Pick<DeleteContext, 'stateDir' | 'crossVolumeCopy'>,
  target: string,
): Promise<SpaceForecast> {
  /*
   * 是否**真的**跨卷，要按两个路径的卷根判断，而不是看 `crossVolumeCopy` 开关。
   *
   * 开关只表示"允许在需要时复制"，不表示这次就需要：源和安全区同盘时，
   * 即使开关打开也是 rename，一个字节都不复制。按开关判断会误报
   * "将占用 X GB"，而实际根本没占用 —— 假警报比不报更糟。
   */
  const sourceRoot = path.parse(path.resolve(target)).root.toLowerCase()
  const stateRoot = path.parse(path.resolve(ctx.stateDir)).root.toLowerCase()
  const crossesVolumes = sourceRoot !== stateRoot

  const copyBytes = crossesVolumes ? description.bytes : 0
  let freeBytes: number | undefined
  if (crossesVolumes) {
    try {
      const stat = statfsSync(path.resolve(ctx.stateDir))
      freeBytes = stat.bavail * stat.bsize
    } catch {
      /* statfs 在某些文件系统/平台不可用，取不到就当作未知 */
    }
  }
  const copyWillNotFit = copyBytes > 0 && freeBytes !== undefined && copyBytes > freeBytes

  return {
    crossesVolumes,
    copyBytes,
    ...(freeBytes === undefined ? {} : { freeBytes }),
    copyWillNotFit,
    /** 跨盘但用户没开 crossVolumeCopy：这次删除会被直接拒绝。 */
    blockedByPolicy: crossesVolumes && ctx.crossVolumeCopy !== true,
  }
}

/**
 * 把跨卷风险写成给人看的说明。没有风险时返回空数组。
 *
 * 容量相关的提示已随容量层一起移除 —— 安全区不再有上限，
 * 因此不存在"会不会撑爆"这回事。这里只剩跨盘复制这一项。
 *
 * @param forecast 预估结果。
 * @returns 风险条目，可能为空。
 */
export function describeSpaceRisks(forecast: SpaceForecast): string[] {
  const risks: string[] = []
  if (forecast.copyWillNotFit) {
    const free = forecast.freeBytes === undefined ? 'less than needed' : humanBytes(forecast.freeBytes)
    risks.push(
      `this crosses volumes, so ${humanBytes(forecast.copyBytes)} will be copied onto the safe zone's disk ` +
        `(only ${free} free). Move the safe zone to the source volume, or free space first.`,
    )
  } else if (forecast.copyBytes > 0) {
    // 不会写不下，但也要告诉用户"这会占目标盘空间" —— 清理到回收站并不会还回来。
    risks.push(
      `this crosses volumes, so ${humanBytes(forecast.copyBytes)} will be copied onto the safe zone's disk ` +
        `and stays there until the entry expires. Pruning to the recycle bin does not free it (same-volume rename).`,
    )
  }
  if (forecast.blockedByPolicy) {
    // 跨盘且未开 crossVolumeCopy：moveToSafeZone 会直接抛 EXDEV。
    // 与其让用户撞到一条报错，不如在确认卡里就说清两条出路。
    risks.push(
      'this crosses volumes and crossVolumeCopy is off, so the move will be refused. ' +
        'Either move the safe zone onto the source volume, or enable crossVolumeCopy to accept a real copy.',
    )
  }
  return risks
}


/**
 * 执行一次删除。
 *
 * 顺序即正确性：先证明目标存在且不是禁区，再描述，再（必要时）问人，最后才移动。
 *
 * ## 什么时候才问人
 *
 * 只在**真的有风险**时问，普通删除绝不打扰（频繁弹确认会训练用户无脑点允许，
 * 反而更危险）。三个独立理由，任一命中问**一次**（不叠加问多次）：
 *
 *   1. 路径危险（家目录、profile 清单、node_modules…）
 *   2. 这一单太大（条目数或字节数超阈值）
 *   3. 空间后果异常：会把安全区撑过上限，或跨卷复制写不下
 */
export async function deletePath(request: DeleteRequest, ctx: DeleteContext): Promise<DeleteResult> {
  const raw = request.path ?? ''
  if (raw.trim() === '') return { ok: false, error: 'path is required' }
  const target = path.resolve(raw)

  // 1. 禁区：盘符根、安全区自身。
  if (isDriveRoot(target)) {
    return { ok: false, error: `refusing to trash a filesystem root "${target}"` }
  }
  if (isInsideStateDir(target, ctx.stateDir)) {
    return { ok: false, error: `refusing to delete "${target}": it is the safe zone's own state directory` }
  }

  // 2. 存在性。
  if (!existsSync(target)) return { ok: false, target, error: `not found: ${target}` }

  // 3. 描述。
  const description = describeTarget(target)
  const gate = decideGate(target, description, ctx)

  // 4. 预览：只说不做。
  if (request.preview === true) {
    return { ok: true, kind: 'preview', target, description, gate }
  }

  /*
   * 5. 空间后果评估。
   *
   * 单盘和多盘各有一次"承诺与实际不符"的机会：
   *
   *   - 安全区放不下：条目进去后立刻被容量清理踢进回收站，但输出仍写
   *     「7 天可恢复」；
   *   - 跨盘复制：源在 D、安全区在 C 时会真的复制一份到 C，把系统盘吃掉；
   *     而清理到回收站只是同卷 rename，不会还回来。
   *
   * 关键设计：**不为此额外弹一次审批**。它只并入下面那一次确认，
   * 或者在没有其它风险时也不打扰 —— 用户明确要求"除非超限或有预警，别随时弹"。
   */
  const forecast = await forecastSpace(
    description,
    {
      stateDir: ctx.stateDir,
      ...(ctx.crossVolumeCopy === true ? { crossVolumeCopy: true } : {}),
    },
    target,
  )
  const risks = describeSpaceRisks(forecast)

  /*
   * 只有"目标盘真的放不下"才**拒绝**；其余风险只是告知，随确认卡一起给出。
   *
   * 判断必须用结构化字段（`forecast.copyWillNotFit`），不能去匹配文案里的
   * 关键词 —— 那会在改一句话之后悄悄失效。
   */
  if (forecast.copyWillNotFit) {
    const free = forecast.freeBytes === undefined ? 'less than needed' : humanBytes(forecast.freeBytes)
    return {
      ok: false,
      target,
      error:
        `not enough free space on the safe zone's volume: need ${humanBytes(forecast.copyBytes)}, ` +
        `only ${free} free. Move the safe zone onto the source volume, or free space first`,
    }
  }

  // 6. 需要人确认时问一次（危险路径 / 超阈值 / 空间风险，合并成一次）。
  if (gate.needsApproval || risks.length > 0) {
    const base = describeApprovalRequest(target, description, gate, ctx.retentionDays)
    const text = risks.length === 0 ? base : `${base}\n\nSpace warning:\n- ${risks.join('\n- ')}`
    const outcome = await ctx.requestApproval(text)
    if (outcome !== 'allowed-once') {
      return { ok: false, target, error: approvalFailureText(outcome, target) }
    }
  }

  // 7. 移入安全区。
  /*
   * 理由先收进安全长度再落盘 —— 它会进索引与审计各一份，而索引每次读写都是
   * 全量的（见 `boundReason` 的注释）。
   */
  const reason = boundReason(request.reason)
  const entry = await moveToSafeZone(ctx.stateDir, target, {
    retentionDays: ctx.retentionDays,
    now: ctx.now(),
    ...(ctx.crossVolumeCopy === true ? { crossVolumeCopy: true } : {}),
    ...(reason === undefined ? {} : { reason }),
  })

  appendAudit(ctx.stateDir, {
    event: 'delete',
    target,
    tool: 'safe_delete',
    detail: `id=${entry.id} cls=${gate.classification}${reason === undefined ? '' : ` reason=${reason}`}`,
  })

  // 7. 顺带清理（时间 + 容量）。
  const pruned = ctx.afterMove === undefined ? [] : await ctx.afterMove()

  return { ok: true, kind: 'moved', target, entry, description, gate, pruned }
}

/**
 * 组装给人看的确认文案。
 *
 * 必须是**提问式**的：说清删什么、多大、为什么要你确认、以及之后能不能取回。
 * 只说「拒绝」而不解释，用户只会换个姿势重试。
 */
export function describeApprovalRequest(
  target: string,
  description: TargetDescription,
  gate: GateDecision,
  retentionDays: number,
): string {
  const size = description.isDirectory
    ? `Directory, ${description.fileCount} entries, ${description.bytes} bytes`
    : `File, ${description.bytes} bytes`
  return (
    `Delete "${target}"? ${size}. ` +
    `Why this needs your OK: ${gate.reasons.join('; ')}. ` +
    `It will be moved into the safe zone and can be restored for ${retentionDays} days.`
  )
}

/** 把审批结果翻译成可区分的错误文本。 */
export function approvalFailureText(outcome: ApprovalOutcome, target: string): string {
  switch (outcome) {
    case 'rejected':
      return `the user rejected deleting "${target}". Do not retry; ask the user what they actually want.`
    case 'cancelled':
      return `the approval request for "${target}" was cancelled.`
    case 'unavailable':
      return `"${target}" needs approval, but no approval channel is available (the session approval policy is likely "never"). Ask the user to switch the permission preset to one that uses "ask".`
    case 'allowed-once':
      return ''
  }
}

/** `reason` 的最大长度。 */
const MAX_REASON_CHARS = 200

/**
 * 把删除理由收进安全长度。
 *
 * ## 为什么要截
 *
 * `reason` 是模型或用户给的**自由文本**，会被写进索引与审计日志**各一份**。
 * 没有上限时：
 *
 *   - 模型把一段文件内容贴进来当理由 → 索引膨胀，而索引每次删除/清理都要全量
 *     读写（1000 条时 268 KB、5000 条时 1.3 MB），等于把整个插件的 I/O 成本推高；
 *   - 那段文本可能含敏感信息（密钥、私信），于是长期留在磁盘上。
 *
 * 实测：传 10000 字符，索引与审计里各存了 10000 字符。
 *
 * ## 为什么保留开头
 *
 * 理由的前半段通常更有信息量（"清理构建产物…"），截尾比截头损失小。
 *
 * @param reason 原始理由（可能为空或超长）。
 * @returns 长度不超过 `MAX_REASON_CHARS` 的理由；空输入返回 undefined。
 */
export function boundReason(reason: string | undefined): string | undefined {
  if (reason === undefined || reason === '') return undefined
  return reason.length <= MAX_REASON_CHARS ? reason : `${reason.slice(0, MAX_REASON_CHARS - 1)}…`
}

/** 人类可读的体积。 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/** 把预览结论拼成人看的文本。 */
export function describePreview(result: Extract<DeleteResult, { kind: 'preview' }>, retentionDays: number): string {
  const d = result.description
  const top =
    d.topEntries.length > 0
      ? `\n  ${d.topEntries.slice(0, 10).join('\n  ')}${d.truncated ? `\n  … and ${d.fileCount - 10} more` : ''}`
      : ''
  return (
    `PREVIEW (nothing moved):\n${result.target}\n` +
    `${d.isDirectory ? 'directory' : 'file'}: ${d.fileCount} entr${d.fileCount === 1 ? 'y' : 'ies'}, ${humanBytes(d.bytes)}${top}\n\n` +
    `classification: ${result.gate.classification}` +
    (result.gate.needsApproval ? ` — will need your approval (${result.gate.reasons.join('; ')})` : ' — moves without asking') +
    `\nretention: ${retentionDays} days`
  )
}

/** 把移动结论拼成人看的文本。 */
export function describeMoved(result: Extract<DeleteResult, { kind: 'moved' }>, retentionDays: number): string {
  const d = result.description
  // 输出是**按次**付费的，所以这里只保留模型真正会用到的信息：
  //   - 移到哪、id 是什么（取回要用）
  //   - 大小与条目数（让模型能向用户复述"删了多大"）
  //   - 天数（而不是完整 ISO 时间戳：模型不会去算日期差，人也不看）
  // 原来 id 打印了两次、时间戳带毫秒 ISO 串，压缩后信息不减。
  //
  // `id: <value>` 这个形状**不能改**：测试用 `/id:\s*(\S+)/` 提取它，模型也照着
  // 这个格式复制 id 去调 safe_zone_restore。输出格式是隐含契约。
  const top =
    d.topEntries.length > 0
      ? `\n  ${d.topEntries.slice(0, 10).join('\n  ')}${d.truncated ? `\n  … and ${d.fileCount - 10} more` : ''}`
      : ''
  const size = d.isDirectory ? `${d.fileCount} entries, ${humanBytes(d.bytes)}` : `file, ${humanBytes(d.bytes)}`
  return (
    `moved to safe zone: ${result.target}\n` +
    `  id: ${result.entry.id}  ${size}${top}\n` +
    `  restore: safe_zone_restore id=${result.entry.id} (${retentionDays}d)` +
    (result.pruned.length > 0
      ? `\n  pruned ${result.pruned.length} expired/over-cap entr${result.pruned.length === 1 ? 'y' : 'ies'}`
      : '')
  )
}
