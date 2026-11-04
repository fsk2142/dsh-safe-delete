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

import { lstatSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import type { TargetDescription } from './types'

/** 顶层条目最多列多少个。 */
const MAX_TOP_ENTRIES = 20

/** 递归遍历时最多访问多少个条目，防止超大目录拖死事件循环。 */
const MAX_WALK_ENTRIES = 200_000

/**
 * 递归累加目录的大小与文件数。
 */
function walk(dir: string, acc: { bytes: number; fileCount: number }): void {
  if (acc.fileCount > MAX_WALK_ENTRIES) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = path.join(dir, name)
    let st
    try {
      st = lstatSync(full)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      // 不跟随：链接本身不计入大小，避免环和跨卷遍历。
      acc.fileCount += 1
      continue
    }
    if (st.isDirectory()) {
      walk(full, acc)
      continue
    }
    acc.bytes += st.size
    acc.fileCount += 1
  }
}

/**
 * 描述一个路径。
 *
 * ## `stats` 选项（2026-11-04）
 *
 * 递归统计是「删之前让你看清」的代价：每个条目一次 `lstatSync`，全在审批
 * 卡片出现**之前**同步跑完。回收站模式不需要这两个数字（它也不做按大小的
 * 确认），所以允许跳过 —— 目录只读顶层一层，`bytes`/`fileCount` 记 0 并带
 * `statsOmitted: true`。
 *
 * 单文件在两种模式下都 `statSync`：那是一次系统调用，本来就免费，跳过反而
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
    st = statSync(absPath)
  } catch {
    return { exists: false, isDirectory: false, bytes: 0, fileCount: 0, topEntries: [], truncated: false }
  }

  if (!st.isDirectory()) {
    return {
      exists: true,
      isDirectory: false,
      bytes: st.size,
      fileCount: 1,
      topEntries: [],
      truncated: false,
    }
  }

  const acc = { bytes: 0, fileCount: 0 }
  if (stats) walk(absPath, acc)

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
  }
}
