#!/usr/bin/env node
/**
 * dsh-safe-delete 的独立命令行。
 *
 * 存在的理由：**取回被删的东西不能依赖 DSH 正在运行**。如果插件没加载、DSH 打不开、
 * 或者你根本在终端里，`undo` 仍然必须能用。
 *
 * 命令：
 *   list                列出安全区内容
 *   undo <id>           把某条取回原位（原位被占用时落到 .restored-<时间戳>）
 *   prune [--dry-run]   按策略清理（时间 + 容量），--dry-run 只报告不动手
 *   check               只读体检（不写任何文件）
 *   status              安全区概况
 *   journal [n]         审计流水（拦截 / 删除 / 取回 / 清理），最新在前
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const USAGE = `dsh-safe-delete — move deletions into a recoverable safe zone

Usage:
  dsh-safe-delete delete <path> [--preview]   Move a file or directory into the safe zone
  dsh-safe-delete list                 List what is in the safe zone
  dsh-safe-delete undo <id>            Restore one entry to where it came from
  dsh-safe-delete prune [--dry-run]    Destroy expired / over-capacity entries
  dsh-safe-delete status               Show safe-zone size, retention and capacity
  dsh-safe-delete check                Read-only composition health check
  dsh-safe-delete journal [n]          Audit trail, newest first

Notes:
  delete refuses anything that needs interactive approval: a terminal has no
  approval channel. Use /safe-delete inside DSH for those paths.

Environment:
  DSH_HOME   DSH home directory (default: ~/.dsh)
`

/** 解析 DSH_HOME。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/** 状态目录。 */
function stateDir() {
  return path.join(dshHome(), '.dsh-safe-delete')
}

/**
 * 读本插件的配置；读不到就退回内置默认值，并**明确标注**。
 *
 * 为什么必须标注：终端里没有 settings 服务。如果 `status` 直接打印
 * `retention: 7 days`，用户会理所当然地以为那是当前配置 —— 而它可能早被改成 30 天。
 * 宁可说明「这是默认值」，也不要给一个看起来确定的错数。
 *
 * 配置真实存放位置：`<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 里
 * 本插件那一行的 `config:`。
 *
 * @returns `{ maxBytes, retentionDays, pruneAtPercent, source, note }`
 */
function readConfigDefaults() {
  const fallback = {
    maxBytes: 20 * 1024 ** 3,
    retentionDays: 7,
    pruneAtPercent: 90,
    confirmFileCount: 5000,
    confirmBytes: 2 * 1024 ** 3,
    crossVolumeCopy: false,
    source: 'default',
    note: 'built-in defaults — DSH settings not read (run /safe-delete config inside DSH for live values)',
  }
  try {
    const profile = process.env.DSH_PROFILE
    if (profile === undefined || profile === '') return fallback
    // 存放位置已在宿主上核实（2026-10-22）：`app-boot` 的 `PROFILE_PATCH_FILENAME`
    // 就是 `cordis.patch.yml`，用户层配置由 `loadOverlayPatches(binName, patchPath)`
    // 从这里读；实测真实 profile 里 `dsh-context` / `better-sidebar` 都带 `config:` 块。
    // 若将来宿主改了落盘位置，这里会读不到并**明确标注退回默认值**，不会给错数。
    const patchFile = path.join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
    if (!fs.existsSync(patchFile)) return fallback

    // 只做一次轻量文本扫描：不引入 YAML 依赖，配置行是扁平的 `key: value`。
    const text = fs.readFileSync(patchFile, 'utf8')
    const block = extractPluginBlock(text, 'dsh-safe-delete')
    if (block === null) return fallback

    const pick = (key, fallbackValue) => {
      const m = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, 'm').exec(block)
      if (m === null) return fallbackValue
      const raw = m[1].replace(/#.*$/, '').trim()
      const n = Number(raw)
      return Number.isFinite(n) ? n : fallbackValue
    }
    const pickFlag = (key, fallbackValue) => {
      const m = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, 'm').exec(block)
      if (m === null) return fallbackValue
      const raw = m[1].replace(/#.*$/, '').trim().toLowerCase()
      if (raw === 'true' || raw === 'on' || raw === 'yes') return true
      if (raw === 'false' || raw === 'off' || raw === 'no') return false
      return fallbackValue
    }

    return {
      maxBytes: pick('maxBytes', fallback.maxBytes),
      retentionDays: pick('retentionDays', fallback.retentionDays),
      pruneAtPercent: pick('pruneAtPercent', fallback.pruneAtPercent),
      confirmFileCount: pick('confirmFileCount', fallback.confirmFileCount),
      confirmBytes: pick('confirmBytes', fallback.confirmBytes),
      crossVolumeCopy: pickFlag('crossVolumeCopy', fallback.crossVolumeCopy),
      source: 'file',
      note: `read from ${patchFile}`,
    }
  } catch {
    return fallback
  }
}

/**
 * 从 patch 文本里切出某个插件的行（含它的 config 缩进块）。
 *
 * @param text patch 文件全文。
 * @param name 插件包名。
 * @returns 该行的文本片段；找不到时 `null`。
 */
function extractPluginBlock(text, name) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${name}\\s*$`).test(line))
  if (start === -1) return null
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i += 1) {
    // 下一行的 `- id:` 表示换了一个插件。
    if (/^\s*-\s*id:/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n')
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

async function main(argv) {
  const [command, ...rest] = argv

  // 按需加载：插件入口带着 cordis 接线，一个只跑 `undo` 的命令行不该拉它进来。
  // 构建产物缺失时给出可操作的提示，而不是一个 ESM 解析栈。
  const store = await import('../lib/store.js').catch(() => undefined)
  const missingBuild = () => {
    process.stderr.write('lib/ is missing — run `pnpm build` first\n')
    return 1
  }

  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help': {
      process.stdout.write(USAGE)
      return 0
    }

    case 'list': {
      if (store === undefined) return missingBuild()
      const entries = await store.listSafeZone(stateDir())
      if (entries.length === 0) {
        process.stdout.write('safe zone is empty\n')
        return 0
      }
      for (const entry of entries) {
        const expires = new Date(entry.expiresAt).toISOString().slice(0, 10)
        process.stdout.write(
          `${entry.id}  ${entry.isDirectory ? '[dir] ' : '[file]'}  ${humanBytes(entry.bytes)}  ` +
            `expires ${expires}  ${entry.originalPath}\n`,
        )
      }
      return 0
    }

    case 'undo': {
      const id = rest[0]
      if (id === undefined) {
        process.stderr.write('usage: dsh-safe-delete undo <id>\n')
        return 2
      }
      if (store === undefined) return missingBuild()
      const { restoredTo } = await store.restoreFromSafeZone(stateDir(), id)
      process.stdout.write(`restored to: ${restoredTo}\n`)
      return 0
    }

    case 'prune': {
      if (store === undefined) return missingBuild()
      const dryRun = rest.includes('--dry-run')
      const entries = await store.listSafeZone(stateDir())
      const { selectForPrune, safeZoneBytes } = await import('../lib/prune.js')
      const cfg = readConfigDefaults()
      if (cfg.source !== 'file') process.stdout.write(`(${cfg.note})\n`)
      const selected = selectForPrune(entries, {
        now: Date.now(),
        maxBytes: cfg.maxBytes,
        ...(cfg.pruneAtPercent > 0 ? { pruneAtPercent: cfg.pruneAtPercent } : {}),
      })
      if (selected.length === 0) {
        process.stdout.write('nothing to prune\n')
        return 0
      }
      const freed = safeZoneBytes(selected)
      if (dryRun) {
        for (const entry of selected) {
          process.stdout.write(`would move to recycle bin ${entry.id}  ${humanBytes(entry.bytes)}  ${entry.originalPath}\n`)
        }
        process.stdout.write(`total: ${selected.length} entr(ies), ${humanBytes(freed)} (dry run — nothing changed)\n`)
        return 0
      }
      // 移入系统回收站：失败的条目留在安全区，不永久删除。
      let moved = 0
      let failed = 0
      for (const entry of selected) {
        const result = await store.destroyEntry(stateDir(), entry.id)
        if (result.ok) {
          moved += 1
          process.stdout.write(`recycled ${entry.id}  ${humanBytes(entry.bytes)}  ${entry.originalPath}\n`)
        } else {
          failed += 1
          process.stderr.write(`skipped ${entry.id} (${entry.originalPath}): ${result.reason}\n`)
        }
      }
      process.stdout.write(`total: ${moved} entr(ies) moved to the recycle bin, ${humanBytes(freed)}\n`)
      if (failed > 0) {
        process.stdout.write(
          `${failed} entr(ies) left in the safe zone because the recycle bin was unavailable.\n`,
        )
        return 1
      }
      return 0
    }

    case 'status': {
      if (store === undefined) return missingBuild()
      const entries = await store.listSafeZone(stateDir())
      const total = entries.reduce((sum, e) => sum + e.bytes, 0)
      const cfg = readConfigDefaults()
      const suffix = cfg.source === 'file' ? '' : `  (${cfg.note})`
      process.stdout.write(
        [
          `state dir: ${stateDir()}`,
          `entries: ${entries.length}`,
          `total size: ${humanBytes(total)}`,
          `capacity cap: ${humanBytes(cfg.maxBytes)}${suffix}`,
          `retention: ${cfg.retentionDays} days${suffix}`,
          entries.length > 0 ? `oldest expires: ${new Date(entries[0].expiresAt).toISOString()}` : 'safe zone is empty',
        ].join('\n') + '\n',
      )
      return 0
    }

    case 'check': {
      const { checkComposition } = await import('../lib/tools.js')
      process.stdout.write(
        `${checkComposition({ home: os.homedir(), workdir: process.cwd(), dshHome: dshHome() })}\n`,
      )
      return 0
    }

    case 'delete': {
      // 与插件里的斜杠命令走**同一个核心**（lib/delete-core.js），
      // 所以禁区判定、阈值确认、移入安全区的行为完全一致。
      const target = rest.find((arg) => !arg.startsWith('--'))
      const preview = rest.includes('--preview')
      if (target === undefined) {
        process.stderr.write('usage: dsh-safe-delete delete <path> [--preview]\n')
        return 2
      }
      const { deletePath, describeMoved, describePreview } = await import('../lib/delete-core.js')
      const cfg = readConfigDefaults()
      if (cfg.source !== 'file') process.stdout.write(`(${cfg.note})\n`)
      const result = await deletePath(
        { path: target, preview },
        {
          stateDir: stateDir(),
          env: {
            home: os.homedir(),
            workdir: process.cwd(),
            dshHome: dshHome(),
            safeZoneDir: stateDir(),
          },
          // 用真实配置，不硬编码：用户把阈值改成 500 条时，CLI 也要按 500 判。
          retentionDays: cfg.retentionDays,
          confirmFileCount: cfg.confirmFileCount,
          confirmBytes: cfg.confirmBytes,
          crossVolumeCopy: cfg.crossVolumeCopy,
          // 终端里没有 DSH 的审批卡片：需要确认时一律拒绝，并提示改用插件内的命令。
          requestApproval: async () => 'rejected',
          now: () => Date.now(),
        },
      )
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`)
        // 需要审批时给出可行的下一步，而不是只说「不行」。
        if (result.error.includes('needs approval') || result.error.includes('rejected')) {
          process.stderr.write(
            '提示：这条路径需要人工确认，终端里没有审批通道。请在 DSH 里用 /safe-delete 完成。\n',
          )
        }
        return 1
      }
      process.stdout.write(
        `${result.kind === 'preview' ? describePreview(result, 7) : describeMoved(result, 7)}\n`,
      )
      return 0
    }

    case 'journal': {
      const { readAudit } = await import('../lib/audit.js')
      const limit = Math.min(200, Math.max(1, Number(rest[0]) || 20))
      const records = readAudit(stateDir(), limit)
      if (records.length === 0) {
        process.stdout.write('journal is empty\n')
        return 0
      }
      for (const r of records) {
        const when = r.at.slice(0, 19).replace('T', ' ')
        const parts = [when, r.event]
        if (r.tool !== undefined) parts.push(`tool=${r.tool}`)
        if (r.target !== undefined) parts.push(r.target)
        if (r.detail !== undefined) parts.push(`(${r.detail})`)
        process.stdout.write(`${parts.join('  ')}\n`)
      }
      return 0
    }

    default: {
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
      return 2
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`[dsh-safe-delete] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
