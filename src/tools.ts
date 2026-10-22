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

import { appendAudit, readAudit } from './audit'

import { classifyPath, requiresApproval, type ClassifyEnv } from './classify'
import { describeTarget } from './describe'
import { selectForPrune, safeZoneBytes } from './prune'
import { destroyEntry, isEmptySafeZone, listSafeZone, moveToSafeZone, restoreFromSafeZone } from './store'
import type { Classification, TrashEntry } from './types'

/** 审批结果词汇（与 DSH `ApprovalOutcome` 一致）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 工具执行结果。 */
export interface ToolResult {
  ok: boolean
  text: string
  error?: string
}

/** 手写的 JSON Schema 子集。 */
export interface JsonSchemaSubset {
  type: 'object'
  properties: Record<string, { type: string; description?: string; enum?: string[] }>
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
  maxBytes: number
  /** 是否自动按时间/容量清理。 */
  autoPrune?: boolean
  /** 当前时间（测试可注入）。 */
  now?: () => number
}

/** 参数 spec → JSON Schema 子集。 */
function toJsonSchema(spec: Record<string, { type: string; description?: string; enum?: string[]; required?: boolean }>): JsonSchemaSubset {
  const properties: JsonSchemaSubset['properties'] = {}
  const required: string[] = []
  for (const [key, meta] of Object.entries(spec)) {
    const prop: { type: string; description?: string; enum?: string[] } = { type: meta.type }
    if (meta.description !== undefined) prop.description = meta.description
    if (meta.enum !== undefined) prop.enum = meta.enum
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
  parameters: Record<string, { type: string; description?: string; enum?: string[]; required?: boolean }>
  execute: (args: Record<string, unknown>) => Promise<ToolResult>
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
      try {
        return await spec.execute(args)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, text: '', error: `[dsh-safe-delete] ${message}` }
      }
    },
  }
}

/** 人类可读的体积。 */
function humanBytes(bytes: number): string {
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

/** 驱动盘根判定（`C:\`、`C:/`、`/`）。 */
function isDriveRoot(p: string): boolean {
  const resolved = path.resolve(p)
  const parsed = path.parse(resolved)
  return parsed.root === resolved
}

/**
 * 把审批结果翻译成给模型看的、可区分的错误文本。
 *
 * 「人说不」和「没有审批通道」必须是两句不同的话 —— 模型据此决定是停手还是报告。
 */
function approvalFailureText(outcome: ApprovalOutcome, target: string): string {
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

/** 创建全部工具。 */
export function createTools(deps: ToolDeps): ToolDefinition[] {
  const now = deps.now ?? (() => Date.now())

  /** 按策略清理安全区；返回被销毁的条目。 */
  const pruneNow = async (): Promise<TrashEntry[]> => {
    if (deps.autoPrune === false) return []
    const entries = await listSafeZone(deps.stateDir)
    const selected = selectForPrune(entries, { now: now(), maxBytes: deps.maxBytes })
    for (const entry of selected) {
      await destroyEntry(deps.stateDir, entry.id)
      appendAudit(deps.stateDir, {
        event: 'prune',
        target: entry.originalPath,
        detail: `id=${entry.id} bytes=${entry.bytes}`,
      })
    }
    return selected
  }

  const safeDelete = makeTool({
    name: 'safe_delete',
    description:
      'Delete a file or directory the safe way: it is moved into the safe zone (restorable via safe_zone_restore) instead of being erased. ' +
      'Dangerous paths (the OS home directory, plugin sources, profile manifests, node_modules) require the user to approve in the UI; ordinary workspace files move without asking. ' +
      'Run with preview:true first to see exactly what would be moved. This is the ONLY sanctioned way to delete in DSH — raw shell deletes are blocked.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the file or directory to delete.' },
      preview: { type: 'boolean', description: 'Only describe what would be moved; change nothing.' },
      reason: { type: 'string', description: 'Why this is being deleted (recorded in the safe zone and the audit trail).' },
      force: {
        type: 'boolean',
        description: 'Ignored. Kept for compatibility: a model-set flag is never a user approval.',
      },
    },
    async execute(args) {
      const raw = String(args.path ?? '')
      if (raw === '') return { ok: false, text: '', error: 'path is required' }
      const target = path.resolve(raw)

      // 1. 禁区：盘符根、安全区自身。
      if (isDriveRoot(target)) {
        return { ok: false, text: '', error: `refusing to trash a filesystem root "${target}"` }
      }
      const stateResolved = path.resolve(deps.stateDir)
      if (target === stateResolved || target.startsWith(stateResolved + path.sep)) {
        return {
          ok: false,
          text: '',
          error: `refusing to delete "${target}": it is the safe zone's own state directory`,
        }
      }

      // 2. 存在性。
      if (!existsSync(target)) {
        return { ok: false, text: '', error: `not found: ${target}` }
      }

      // 3. 描述。
      const description = describeTarget(target)
      const summary =
        `${target}\n` +
        `${description.isDirectory ? 'directory' : 'file'}: ${description.fileCount} entr${description.fileCount === 1 ? 'y' : 'ies'}, ${humanBytes(description.bytes)}` +
        (description.topEntries.length > 0
          ? `\n  ${description.topEntries.slice(0, 10).join('\n  ')}${description.truncated ? `\n  … and ${description.fileCount - 10} more` : ''}`
          : '')

      // 4. 预览：只说不做。
      if (args.preview === true) {
        const classification: Classification = classifyPath(target, deps.env)
        return {
          ok: true,
          text:
            `PREVIEW (nothing moved):\n${summary}\n\n` +
            `classification: ${classification}` +
            (requiresApproval(classification) ? ' — will require your approval in the UI' : ' — moves without asking') +
            `\nretention: ${deps.retentionDays} days\nRun safe_delete again without preview to move it into the safe zone.`,
        }
      }

      // 5. 分类与授权。
      const classification = classifyPath(target, deps.env)
      if (requiresApproval(classification)) {
        // `force` 在这里被刻意无视：它只作为兼容参数存在，不参与任何判定。
        const outcome = await deps.requestApproval(
          `Delete "${target}"? ${description.isDirectory ? `Directory, ${description.fileCount} entries, ` : 'File, '}${humanBytes(description.bytes)}. ` +
            `It will be moved into the safe zone and can be restored for ${deps.retentionDays} days.`,
        )
        if (outcome !== 'allowed-once') {
          return { ok: false, text: '', error: approvalFailureText(outcome, target) }
        }
      }

      // 6. 移入安全区。
      const reason = typeof args.reason === 'string' ? args.reason : undefined
      const entry = await moveToSafeZone(deps.stateDir, target, {
        retentionDays: deps.retentionDays,
        now: now(),
        ...(reason !== undefined && reason !== '' ? { reason } : {}),
      })

      appendAudit(deps.stateDir, {
        event: 'delete',
        target,
        tool: 'safe_delete',
        detail: `id=${entry.id} cls=${classification}${reason === undefined || reason === '' ? '' : ` reason=${reason}`}`,
      })

      // 7. 顺带清理（时间 + 容量）。
      const pruned = await pruneNow()

      return {
        ok: true,
        text:
          `moved to the safe zone: ${target}\n` +
          `id: ${entry.id}\n${summary}\n` +
          `restore with: safe_zone_restore id=${entry.id}\n` +
          `expires: ${new Date(entry.expiresAt).toISOString()} (${deps.retentionDays} days)` +
          (pruned.length > 0 ? `\npruned ${pruned.length} expired/over-cap entr${pruned.length === 1 ? 'y' : 'ies'}` : ''),
      }
    },
  })

  const safeZoneList = makeTool({
    name: 'safe_zone_list',
    description: 'List what is currently in the safe zone, newest last, with ids you can pass to safe_zone_restore.',
    parameters: {
      limit: { type: 'integer', description: 'Max entries to show (default 50).' },
    },
    async execute(args) {
      const entries = await listSafeZone(deps.stateDir)
      if (entries.length === 0) return { ok: true, text: 'safe zone is empty' }
      const limit = Math.max(1, Number(args.limit) || 50)
      const shown = entries.slice(-limit)
      const lines = shown.map(
        (e) =>
          `${e.id}  ${e.isDirectory ? '[dir] ' : '[file]'}  ${humanBytes(e.bytes)}  ` +
          `expires ${new Date(e.expiresAt).toISOString().slice(0, 10)}  ${e.originalPath}`,
      )
      return {
        ok: true,
        text:
          `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in the safe zone:\n` +
          lines.join('\n') +
          (entries.length > shown.length ? `\n… ${entries.length - shown.length} older entr(ies) not shown` : ''),
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
    async execute() {
      const entries = await listSafeZone(deps.stateDir)
      const total = safeZoneBytes(entries)
      const next = entries[0]
      return {
        ok: true,
        text: [
          `state dir: ${deps.stateDir}`,
          `entries: ${entries.length}`,
          `total size: ${humanBytes(total)}`,
          `capacity cap: ${humanBytes(deps.maxBytes)}`,
          `retention: ${deps.retentionDays} days`,
          `auto prune: ${deps.autoPrune === false ? 'off (manual only)' : 'on'}`,
          next !== undefined ? `oldest entry expires: ${new Date(next.expiresAt).toISOString()}` : 'safe zone is empty',
        ].join('\n'),
      }
    },
  })

  const safeZoneCheck = makeTool({
    name: 'safe_zone_check',
    description:
      'Read-only health check of the composition under $DSH_HOME: can each profile package.json be parsed, is each cordis.patch.yml readable, and are any row ids duplicated across layers (duplicates make the next boot fail). Writes nothing.',
    parameters: {},
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
