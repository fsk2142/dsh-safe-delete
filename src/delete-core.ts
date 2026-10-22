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

import { existsSync } from 'node:fs'
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
 * 执行一次删除。
 *
 * 顺序即正确性：先证明目标存在且不是禁区，再描述，再（必要时）问人，最后才移动。
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

  // 5. 需要人确认时问一次。
  if (gate.needsApproval) {
    const outcome = await ctx.requestApproval(describeApprovalRequest(target, description, gate, ctx.retentionDays))
    if (outcome !== 'allowed-once') {
      return { ok: false, target, error: approvalFailureText(outcome, target) }
    }
  }

  // 6. 移入安全区。
  const entry = await moveToSafeZone(ctx.stateDir, target, {
    retentionDays: ctx.retentionDays,
    now: ctx.now(),
    ...(request.reason !== undefined && request.reason !== '' ? { reason: request.reason } : {}),
  })

  appendAudit(ctx.stateDir, {
    event: 'delete',
    target,
    tool: 'safe_delete',
    detail: `id=${entry.id} cls=${gate.classification}${request.reason === undefined || request.reason === '' ? '' : ` reason=${request.reason}`}`,
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
  const top =
    d.topEntries.length > 0
      ? `\n  ${d.topEntries.slice(0, 10).join('\n  ')}${d.truncated ? `\n  … and ${d.fileCount - 10} more` : ''}`
      : ''
  return (
    `moved to the safe zone: ${result.target}\n` +
    `id: ${result.entry.id}\n` +
    `${d.isDirectory ? 'directory' : 'file'}: ${d.fileCount} entr${d.fileCount === 1 ? 'y' : 'ies'}, ${humanBytes(d.bytes)}${top}\n` +
    `restore with: safe_zone_restore id=${result.entry.id}\n` +
    `expires: ${new Date(result.entry.expiresAt).toISOString()} (${retentionDays} days)` +
    (result.pruned.length > 0
      ? `\npruned ${result.pruned.length} expired/over-cap entr${result.pruned.length === 1 ? 'y' : 'ies'}`
      : '')
  )
}
