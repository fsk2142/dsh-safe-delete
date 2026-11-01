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
 *   prune [--dry-run]   把过期条目移入系统回收站；--dry-run 只报告不动手
 *   prune --permanent --yes   永久删除（不可恢复，需两个开关）
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
  dsh-safe-delete prune [--dry-run]    Move expired entries to the recycle bin
dsh-safe-delete prune --permanent --yes   Erase them irrecoverably
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

/**
 * 状态目录（安全区）。
 *
 * ## 优先级（2026-11-01 审查 SD-13）
 *
 * 1. `--state-dir <路径>` 显式覆盖 —— 救援时最可靠，不依赖配置能否读到；
 * 2. 插件配置里的 `stateDir`；
 * 3. `<DSH_HOME>/.dsh-safe-delete`。
 *
 * 第一版只有第 3 条。用户在插件里改过安全区位置后，CLI 会指向一个
 * **完全不同的目录**：`list` 说"空"、`delete` 往别处写。
 * DSH 起不来时 CLI 是唯一救援通道 —— 指错地方等于救援失效。
 *
 * @returns 安全区绝对路径。
 */
function stateDir() {
  // 1. 显式覆盖：从 argv 里找 `--state-dir <path>` 或 `--state-dir=<path>`。
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--state-dir') {
      const next = argv[i + 1]
      if (typeof next === 'string' && next !== '') return path.resolve(next)
    } else if (typeof arg === 'string' && arg.startsWith('--state-dir=')) {
      const value = arg.slice('--state-dir='.length)
      if (value !== '') return path.resolve(value)
    }
  }

  // 2. 配置里的 stateDir。
  try {
    const configured = readConfigDefaults().stateDir
    if (typeof configured === 'string' && configured !== '') return path.resolve(configured)
  } catch {
    /* 读配置失败就退回默认 —— 下面会明确打印用的是哪个目录 */
  }

  // 3. 默认位置。
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
 * @returns `{ retentionDays, confirmFileCount, confirmBytes, crossVolumeCopy, source, note }`
 */
function readConfigDefaults() {
  const fallback = {
    // 保留期默认 1 天：安全区只是短暂缓冲，到期交给系统回收站。
    retentionDays: 1,
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
    /**
     * 读一个**字符串**配置项（2026-11-01 审查 SD-13）。
     *
     * 为什么不复用 `pick`：那个只接受数字，`stateDir` 是路径字符串。
     * 去掉行尾注释与包裹的引号，其余原样保留 —— 路径里的空格、反斜杠
     * 都不能动。
     *
     * @param key 配置键。
     * @param fallbackValue 缺省值。
     * @returns 配置值或缺省值。
     */
    const pickString = (key, fallbackValue) => {
      const m = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, 'm').exec(block)
      if (m === null) return fallbackValue
      let raw = m[1].replace(/#.*$/, '').trim()
      if (
        (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) ||
        (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)
      ) {
        raw = raw.slice(1, -1)
      }
      return raw === '' ? fallbackValue : raw
    }

    return {
      retentionDays: pick('retentionDays', fallback.retentionDays),
      confirmFileCount: pick('confirmFileCount', fallback.confirmFileCount),
      confirmBytes: pick('confirmBytes', fallback.confirmBytes),
      crossVolumeCopy: pickFlag('crossVolumeCopy', fallback.crossVolumeCopy),
      /*
       * `stateDir` 必须读出来（2026-11-01 审查 SD-13）。
       *
       * 第一版只读四个数字/布尔项，`stateDir` 用固定默认值。于是用户在插件
       * 里改了安全区位置后：
       *
       * ```
       * CLI list/undo  → 看默认安全区（空的）→ "没有可恢复的条目"
       * CLI delete     → 往默认安全区写 → 与插件用的那个完全不是一处
       * ```
       *
       * DSH 起不来时 CLI 是唯一能救数据的东西。它指向错误目录等于救援通道失效。
       */
      stateDir: pickString('stateDir', undefined),
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

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /*
   * 支持两种形态（2026-11-01 审查 SD-13 时补第二种）：
   *
   * 1. 列表项：
   *    ```yaml
   *    plugins:
   *      - id: dsh-safe-delete
   *        config:
   *          retentionDays: 1
   *    ```
   * 2. 映射键：
   *    ```yaml
   *    plugins:
   *      dsh-safe-delete:
   *        config:
   *          retentionDays: 1
   *    ```
   *
   * 第一版只认第一种。用第二种写法配了 `stateDir` 的用户，CLI 读不到，
   * 于是回到默认安全区 —— 正是 SD-13 要修的那种"指错地方"。
   */
  const listStart = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${escaped}\\s*$`).test(line))
  if (listStart !== -1) {
    const out = [lines[listStart]]
    for (let i = listStart + 1; i < lines.length; i += 1) {
      if (/^\s*-\s*id:/.test(lines[i])) break
      out.push(lines[i])
    }
    return out.join('\n')
  }

  const keyStart = lines.findIndex((line) => new RegExp(`^\\s+${escaped}:\\s*$`).test(line))
  if (keyStart !== -1) {
    const baseIndent = (lines[keyStart].match(/^\s*/) ?? [''])[0].length
    const out = [lines[keyStart]]
    for (let i = keyStart + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim() === '') {
        out.push(line)
        continue
      }
      const indent = (line.match(/^\s*/) ?? [''])[0].length
      // 缩进回到同级或更浅 → 这个插件的块结束了。
      if (indent <= baseIndent) break
      out.push(line)
    }
    return out.join('\n')
  }

  return null
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
      /*
       * 永久删除必须**两个开关同时给**：`--permanent` 与 `--yes`。
       *
       * 一个够不够？不够。删掉的东西不可恢复，多敲一个 `--yes` 是让人在按下
       * 回车前再想一秒 —— 2026-10-30 我正是"顺手"永久删了 1086 MB 才加的门。
       */
      const permanent = rest.includes('--permanent')
      const alsoYes = rest.includes('--yes')
      const entries = await store.listSafeZone(stateDir())
      const { selectForPrune, safeZoneBytes } = await import('../lib/prune.js')
      const cfg = readConfigDefaults()
      if (cfg.source !== 'file') process.stdout.write(`(${cfg.note})\n`)
      // 只按保留期挑选：没有容量层了。
      const selected = selectForPrune(entries, { now: Date.now() })
      if (selected.length === 0) {
        process.stdout.write('nothing to prune (no entry has passed its retention window)\n')
        return 0
      }
      const totalSelectedBytes = safeZoneBytes(selected)
      if (dryRun) {
        for (const entry of selected) {
          process.stdout.write(
            `would ${permanent ? 'PERMANENTLY DELETE' : 'move to recycle bin'} ${entry.id}  ${humanBytes(entry.bytes)}  ${entry.originalPath}\n`,
          )
        }
        process.stdout.write(
          `total: ${selected.length} entr(ies), ${humanBytes(totalSelectedBytes)} (dry run — nothing changed)\n`,
        )
        return 0
      }

      if (permanent && !alsoYes) {
        process.stderr.write(
          'refusing: `--permanent` erases data irrecoverably; add `--yes` to confirm you really want that.\n' +
            'Without `--permanent` the entries are moved to the system recycle bin instead.\n',
        )
        return 2
      }

      /*
       * 分批调用回收，而不是逐条。
       *
       * ## 为什么改（2026-10-30 复审 P2-02）
       *
       * 原来这里 `for (const entry of selected) destroyEntry(...)` ——
       * 每条一次系统回收站调用（约 1 秒），1000 条要 17 分钟。
       *
       * 而回收站是**按目录树**工作的：把 N 条先聚合进一个目录、再一次送进去，
       * 实测 50 条从 52 秒降到 1.1 秒。worker 里已经实现了这套逻辑
       * （`pruneNowForWorker`），CLI 复用它。
       *
       * ## 永久删除不走这条路
       *
       * `--permanent` 要求的是逐条永久抹除、且要进审计；批量聚合是为了
       * "一次性交给回收站"，语义不同，不能混。
       */
      if (permanent) {
        let moved = 0
        let failed = 0
        let movedBytes = 0
        for (const entry of selected) {
          const result = await store.destroyEntry(stateDir(), entry.id, {
            permanent: { reason: 'cli: prune --permanent --yes', confirmedByUser: true },
          })
          if (result.ok) {
            moved += 1
            movedBytes += entry.bytes
            process.stdout.write(`erased ${entry.id}  ${humanBytes(entry.bytes)}  ${entry.originalPath}\n`)
          } else {
            failed += 1
            process.stderr.write(`skipped ${entry.id} (${entry.originalPath}): ${result.reason}\n`)
          }
        }
        process.stdout.write(
          `total: ${moved} entr(ies) permanently deleted, ${humanBytes(movedBytes)}\n`,
        )
        if (failed > 0) {
          process.stdout.write(`${failed} entr(ies) could not be erased and remain in the safe zone.\n`)
          return 1
        }
        return 0
      }

      // 批量回收：worker 的执行体会按批聚合，每批一次回收调用。
      const { pruneNowForWorker } = await import('../lib/cleanup-run.js')
      const before = selected.length
      const beforeBytes = safeZoneBytes(selected)

      process.stdout.write(`recycling ${before} entr(ies), ${humanBytes(beforeBytes)} in batches...\n`)
      const t0 = Date.now()
      const result = await pruneNowForWorker(stateDir(), before)
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

      process.stdout.write(
        `total: ${result.recycled} of ${before} entr(ies) moved to the recycle bin in ${elapsed}s\n`,
      )
      if (result.skipped > 0) {
        process.stdout.write(
          `${result.skipped} entr(ies) left in the safe zone because the recycle bin was unavailable.\n`,
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
          `retention: ${cfg.retentionDays} day(s), then moved to the system recycle bin${suffix}`,
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
      /*
       * 用**实际配置**的保留期，不写死。
       *
       * 这里原来硬编码 7，而默认保留期是 1 天 —— CLI 会向用户承诺"7 天内可
       * 恢复"，实际第二天就进回收站了。用户可见的错误承诺，必须修。
       */
      process.stdout.write(
        `${result.kind === 'preview' ? describePreview(result, cfg.retentionDays) : describeMoved(result, cfg.retentionDays)}\n`,
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
