/**
 * 在目录树里按模式 / 时间 / 排除条件挑出待删项。
 *
 * ## 为什么单独成模块
 *
 * `safe_delete` 原本只接受字面路径。清生成物时用户真正要说的是「把 `.tmp` 里
 * 7 天前的 `*.log` 删掉，但保留 `latest/`」—— 让模型枚举出几百条路径再传，
 * 既慢（见 `moveManyToSafeZone` 的注释）又容易漏。
 *
 * 这个模块只做**挑选**，不碰删除。挑选结果是路径数组，之后仍走 `deletePath`
 * 的完整判定 —— 保护区、安全区自检、阈值确认全都照常。
 *
 * ## 三条安全约束
 *
 * 1. **`root` 本身不进结果** —— 只挑它内部的项。误写 `root: C:\Work` 时，
 *    后果是「挑出很多文件」而不是「整个 C:\Work 没了」。
 * 2. **不跟随符号链接** —— 避免环，也避免删到链接指向的外部文件。
 * 3. **枚举上限** —— 超过 `MAX_ENUMERATE` 就停，并在结果里标记 `truncated`，
 *    防止在 `node_modules` 这种树里卡死。
 *
 * @module dsh-safe-delete/match
 */

import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** 一次最多枚举多少个条目。与 `describe` 的上限一致。 */
const MAX_ENUMERATE = 200_000

/** 挑选条件。 */
export interface MatchOptions {
  /** 搜索起点（目录）。其自身永远不会出现在结果里。 */
  root: string
  /**
   * glob 模式（相对 `root`），省略表示「全部匹配」。
   *
   * 支持 `*`（不含分隔符）、`**`（任意层）、`?`（单字符）、`{a,b}`（多选）。
   * 大小写在 Windows 上不敏感。
   */
  pattern?: string
  /** 只挑修改时间早于「现在减这个毫秒数」的条目。 */
  olderThanMs?: number
  /** 排除模式（相对 `root`），命中即跳过。可传多个。 */
  exclude?: string[]
  /** 当前时间戳（测试可注入）。 */
  now?: number
}

/** 挑选结果。 */
export interface MatchResult {
  /** 命中的绝对路径（不含 `root` 自身）。 */
  paths: string[]
  /** 是否因为超过枚举上限而提前停止。 */
  truncated: boolean
  /** 一共看过多少条目（含被排除的）。 */
  scanned: number
}

/**
 * 把 glob 片段转成正则。
 *
 * 只支持必要的几个语法：`**`、`*`、`?`、`{a,b}`。刻意不支持 `[...]` 字符类 ——
 * Windows 路径里 `[` `]` 是合法文件名字符，支持它反而会误伤。
 *
 * @param glob glob 模式。
 * @returns 正则（未加锚点）。
 */
function globToRegExp(glob: string): RegExp {
  let out = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i] as string
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` 后跟分隔符时可跨层；否则等同于 `*`。
        const after = glob[i + 2]
        if (after === '/' || after === '\\') {
          out += '(?:.*[\\\\/])?'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^\\\\/]*'
      i += 1
      continue
    }
    if (c === '?') {
      out += '[^\\\\/]'
      i += 1
      continue
    }
    if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end > i) {
        const choices = glob.slice(i + 1, end).split(',')
        out += `(?:${choices.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
        i = end + 1
        continue
      }
    }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  return new RegExp(`^${out}$`)
}

/**
 * 在目录树里挑出符合条件的条目。
 *
 * @param opts 挑选条件。
 * @returns 命中路径与统计。
 */
export function matchInTree(opts: MatchOptions): MatchResult {
  const root = path.resolve(opts.root)
  const now = opts.now ?? Date.now()
  const cutoff = opts.olderThanMs === undefined ? undefined : now - opts.olderThanMs

  const includeRe = opts.pattern === undefined || opts.pattern === '' ? null : globToRegExp(opts.pattern)
  const excludeRes = (opts.exclude ?? []).map((p) => globToRegExp(p))

  const hits: string[] = []
  let scanned = 0
  let truncated = false

  /**
   * 相对 root 的路径，统一用 `/` 分隔，便于与 glob 模式比较。
   *
   * @param abs 绝对路径。
   * @returns 相对路径。
   */
  const relOf = (abs: string): string => path.relative(root, abs).split(path.sep).join('/')

  /**
   * 递归遍历。
   *
   * @param dir 当前目录。
   * @returns 无需返回值；结果累加到闭包变量。
   */
  const walk = (dir: string): void => {
    if (truncated) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      // 权限不足或目录消失：跳过，不影响其余部分。
      return
    }
    for (const name of names) {
      scanned += 1
      if (scanned > MAX_ENUMERATE) {
        truncated = true
        return
      }
      const full = path.join(dir, name)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      // 不跟随符号链接：删链接应该删链接本身，而不是它指向的外部内容。
      const rel = relOf(full)

      // 排除优先于包含：被排除的目录整棵跳过，省得白扫。
      if (excludeRes.some((re) => re.test(rel))) continue

      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (st.isSymbolicLink()) continue

      if (includeRe !== null && !includeRe.test(rel)) continue
      if (cutoff !== undefined && st.mtimeMs >= cutoff) continue
      hits.push(full)
    }
  }

  walk(root)
  return { paths: hits, truncated, scanned }
}

/**
 * 把时长写法解析成毫秒。
 *
 * 支持 `30m` / `6h` / `7d`（也接受裸数字，按天解释 —— 与配置里的 `retentionDays`
 * 一致，避免"写了 7 结果被当成 7 毫秒"）。
 *
 * @param text 时长文本。
 * @returns 毫秒；无法解析时 undefined。
 */
export function parseDuration(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd]?)$/i.exec(text.trim())
  if (m === null) return undefined
  const amount = Number(m[1])
  if (!Number.isFinite(amount) || amount < 0) return undefined
  const unit = (m[2] ?? '').toLowerCase()
  const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return Math.round(amount * factor)
}
