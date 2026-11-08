/**
 * 描述一个待删除目标：它是什么、多大、里面有什么。
 *
 * 这是「删之前让你看清」的依据，也是审批卡片上那行文字的来源。
 *
 * 实现约束：
 *   - 不抛错：权限被拒、链接损坏都只跳过，不能让描述失败挡住一次删除判定。
 *   - 不跟随符号链接：避免链接环导致无限递归。
 *   - 顶层条目排序：输出稳定，测试才能断言。
 */

import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'

import type { BoundedMeasure, TargetDescription } from './types'

/** 顶层条目最多列多少个。 */
const MAX_TOP_ENTRIES = 20

/** 递归遍历时最多访问多少个条目，防止超大目录拖死事件循环。 */
const MAX_WALK_ENTRIES = 200_000

/**
 * 有界枚举的墙钟预算。
 *
 * 这个函数在钩子里**同步**跑，而钩子对每次工具调用都要跑一遍 —— 几万个条目的
 * `lstatSync` 就是几秒的事件循环阻塞。超时退回 `incomplete`（按风险处理），
 * 比"卡住所有工具调用"要好。
 *
 * 1.5 s 的取法：实测 2238 个文件 39 ms，十万级目录才会接近这个量级。
 */
export const DEFAULT_MEASURE_BUDGET_MS = 1500

/**
 * 带早退的有界枚举：只为了回答「这棵树有没有超过 `limitBytes`」。
 *
 * ## 为什么需要它（2026-11-08）
 *
 * 回收站模式下钩子不递归统计目录，`bytes` 只是一个下界。下界小于上限时
 * `assessQuota` 只能返回 `unknown`，钩子据此 `ask`；策略是 `never` 时
 * 管线驳回 `ask`，整个删除被拒绝 —— 于是「244.8 MB 的目录，回收站上限
 * 48.5 GB」这种一眼就知道能放下的删除也删不掉。
 *
 * 这里的取舍是**用一次有界遍历换一个确定结论**：
 *
 *   - 累计一旦超过上限就立刻停 → `over`（此时继续走没有任何价值）；
 *   - 走完都没超 → `exact`（确定放得进去）；
 *   - 出错 / 撞到条目上限 / 预算耗尽 → `incomplete`（仍然按风险处理）。
 *
 * 代价只落在「确实小于上限」的目录上，而那正是删除时本来就要遍历的树。
 *
 * 语义与 `describeTarget` 的 `walk` 保持一致：不跟随符号链接（避免链接环），
 * 链接只按 0 字节计，读不到的条目让结论退回 `incomplete` 而不是少算。
 *
 * @param absPath 目录绝对路径（也接受单文件）。
 * @param limitBytes 配额上限（字节）。
 * @param options.maxEntries 条目上限，用于测试与极端目录保护。
 * @param options.budgetMs 墙钟预算（毫秒），见 `DEFAULT_MEASURE_BUDGET_MS`。`0` 表示直接放弃。
 * @param options.now 时钟，测试注入。
 * @returns 三态结论。
 */
export function measureTreeBounded(
  absPath: string,
  limitBytes: number,
  options: { maxEntries?: number; budgetMs?: number; now?: () => number } = {},
): BoundedMeasure {
  const maxEntries = options.maxEntries ?? MAX_WALK_ENTRIES
  const budgetMs = options.budgetMs ?? DEFAULT_MEASURE_BUDGET_MS
  const clock = options.now ?? Date.now

  if (budgetMs <= 0) {
    return { kind: 'incomplete', reason: 'no time budget was available to measure the tree' }
  }
  const deadline = clock() + budgetMs
  const exhausted = (): BoundedMeasure | undefined =>
    clock() > deadline
      ? {
          kind: 'incomplete',
          reason: `the tree could not be measured within ${budgetMs} ms, so its total size is unknown`,
        }
      : undefined

  let rootStat
  try {
    rootStat = lstatSync(absPath)
  } catch {
    return { kind: 'incomplete', reason: 'the target could not be inspected' }
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    // 单文件没有「下界」问题，直接给确定值。
    return { kind: 'exact', bytes: rootStat.size }
  }

  const pending = [absPath]
  let total = 0
  let visited = 0

  while (pending.length > 0) {
    const over = exhausted()
    if (over !== undefined) return over
    const current = pending.pop() as string
    let names: string[]
    try {
      names = readdirSync(current)
    } catch {
      return {
        kind: 'incomplete',
        reason: `part of the tree could not be read (${path.basename(current) || current})`,
      }
    }
    for (const name of names) {
      if (visited >= maxEntries) {
        return {
          kind: 'incomplete',
          reason: `the tree exceeded ${maxEntries} entries, so its total size could not be established`,
        }
      }
      // 每 256 个条目看一次表，避免把 Date.now() 的成本摊到每个条目上。
      if ((visited & 0xff) === 0) {
        const over = exhausted()
        if (over !== undefined) return over
      }
      visited += 1
      const full = path.join(current, name)
      let st
      try {
        st = lstatSync(full)
      } catch {
        return {
          kind: 'incomplete',
          reason: `an entry could not be inspected (${name})`,
        }
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        pending.push(full)
        continue
      }
      total += st.size
      // 早退：继续走不会改变"已经超了"这个结论。
      if (total > limitBytes) return { kind: 'over', bytes: total }
    }
  }

  return { kind: 'exact', bytes: total }
}

/**
 * 递归累加目录的大小与文件数。
 */
function walk(dir: string, acc: { bytes: number; fileCount: number; incomplete: boolean }): void {
  const pending = [dir]
  let visited = 0
  while (pending.length > 0) {
    if (visited >= MAX_WALK_ENTRIES) { acc.incomplete = true; return }
    const current = pending.pop()!
    let names: string[]
    try { names = readdirSync(current) } catch { acc.incomplete = true; continue }
    for (const name of names) {
      if (visited >= MAX_WALK_ENTRIES) { acc.incomplete = true; return }
      visited += 1
      const full = path.join(current, name)
      let st
      try { st = lstatSync(full) } catch { acc.incomplete = true; continue }
      if (st.isSymbolicLink()) { acc.fileCount += 1; continue }
      if (st.isDirectory()) { pending.push(full); continue }
      acc.bytes += st.size
      acc.fileCount += 1
    }
  }
}

/**
 * 只量**顶层直接子项**的总大小，不递归。
 *
 * ## 为什么需要它（2026-11-04 第 24 次审查 R24-9）
 *
 * 回收站模式下 `stats:false` 跳过递归统计，于是目录的 `bytes` 恒为 0 ——
 * 而配额判定用的正是 `bytes`。结果是**目录超配额永远不触发预警**，
 * 可目录恰恰最容易超（几个 G 的构建产物目录很常见）。
 *
 * 递归的代价是 O(文件数)，这正是模式要避免的；只 stat 顶层是 O(顶层数)，
 * 通常几十个，可忽略。它给出的是一个**下界**，足以覆盖「顶层有个巨大文件」
 * 这个最常见形态。
 *
 * @param dir 目录绝对路径。
 * @returns 顶层直接子项字节数之和（子目录按自身条目大小计，不展开）。
 */
export function shallowBytes(dir: string): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    try {
      const st = lstatSync(path.join(dir, name))
      // 目录本身的大小没有意义，只用文件大小；子目录展开会让成本退回 O(文件数)。
      if (st.isFile()) total += st.size
    } catch {
      /* 读不到就跳过：一个不可读条目不该让整个判定失败 */
    }
  }
  return total
}

/**
 * 描述一个路径。
 *
 * ## `stats` 选项（2026-11-04）
 *
 * 递归统计是「删之前让你看清」的代价：每个条目一次 `lstatSync`，全在审批
 * 卡片出现**之前**同步跑完。回收站模式不需要这两个数字（它也不做按大小的
 * 确认），所以允许跳过 —— 目录只读顶层一层，`fileCount` 记 0，`bytes` 取
 * `shallowBytes` 的下界，并带 `statsOmitted: true`。
 *
 * 顶层使用 `lstatSync`，链接只描述自身；单文件保留实际大小，跳过反而
 * 让「删一个 3 GB 镜像」显示成「0 条目 0 B」。
 *
 * @param absPath 目标绝对路径。
 * @param options.stats 是否统计目录内容；缺省 `true`（保持原有行为）。
 */
export function describeTarget(
  absPath: string,
  options: { stats?: boolean } = {},
): TargetDescription {
  const stats = options.stats !== false
  let st
  try {
    st = lstatSync(absPath)
  } catch {
    return { exists: false, isDirectory: false, bytes: 0, fileCount: 0, topEntries: [], truncated: false }
  }

  if (st.isSymbolicLink() || !st.isDirectory()) {
    return {
      exists: true,
      isDirectory: false,
      bytes: st.size,
      fileCount: 1,
      topEntries: [],
      truncated: false,
    }
  }

  const acc = { bytes: 0, fileCount: 0, incomplete: false }
  if (stats) {
    walk(absPath, acc)
  } else {
    /*
     * 不递归，但至少量顶层（R24-9）：否则目录 `bytes` 恒为 0，
     * 配额判定对它永远失效。
     */
    acc.bytes = shallowBytes(absPath)
  }

  let names: string[] = []
  try {
    names = readdirSync(absPath).sort()
  } catch {
    names = []
  }

  return {
    exists: true,
    isDirectory: true,
    bytes: acc.bytes,
    fileCount: acc.fileCount,
    topEntries: names.slice(0, MAX_TOP_ENTRIES),
    truncated: names.length > MAX_TOP_ENTRIES,
    ...(stats ? {} : { statsOmitted: true }),
    ...(acc.incomplete ? { statsIncomplete: true } : {}),
  }
}
