#!/usr/bin/env node
/**
 * 清理测试与探针脚本留下的残留。
 *
 * ## 为什么需要
 *
 * 全量测试走后 `tests/support/tmpdir.ts` 的 `scratchDir()`，它在 `afterEach`
 * 里自己收尾 —— 全套跑完不留垃圾。
 *
 * 但**一次性探针脚本**（为测量某件事临时写的 `zz-*.ts`）是我自己写的，
 * 常常直接 `mkdtempSync` 或 `join('C:\\Work', ...)`，跑完源码 `safe_delete`
 * 掉了，目录却留在原地。
 *
 * 实际发生过的泄漏点（累计 75+ 个目录、2 万多项）：
 *
 * | 位置 | 为什么在那儿 |
 * |---|---|
 * | 系统 temp | `mkdtempSync(tmpdir(), 'dsd-...')` |
 * | `C:\Work` 根 | 探针里写死 `join('C:\\Work', ...)` 图省事 |
 * | 用户家目录根 | 需要"看起来像家目录"的路径来做分级测试 |
 * | 工作区 | `zz-*.ts` 源码、`.msg*` 草稿、`.tmp-*` 清单 |
 *
 * ## 设计取舍
 *
 * 扫描范围**刻意包含 C:\Work 根与家目录根**，因为那正是我实际泄漏过的地方。
 * 前缀严格限定 `.dsd-*` / `dsd-*`，不匹配任何用户自己的目录。
 *
 * ## 用法
 *
 *   pnpm clean:tmp          只列出会清什么（dry run）
 *   pnpm clean:tmp --apply  真的清理
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** 探针残留的目录名前缀。**只匹配这些，不碰用户目录。** */
const PROBE_PATTERN = /^\.?dsd-/

/** 工作区里的探针与草稿。 */
/*
 * 工作区里的探针与草稿。
 *
 * `.commitmsg*` 是补上的：我一度把提交信息写成 `.commitmsg127`，以 `.commitmsg`
 * 开头，而原来的模式只认 `.msg` 前缀 —— 于是那个文件留在了工作区，脚本报"干净"。
 * 现在把常见变体都覆盖：`.commitmsg` / `.tagmsg` / `.cm`。
 */
const WS_PATTERN = /^(zz-|\.tmp-|\.msg|\.rel|\.commitmsg|\.tagmsg|\.cm)/

/** 是否真的要删。 */
const apply = process.argv.includes('--apply')

/**
 * 递归统计目录大小。
 *
 * @param dir 目录路径。
 * @returns 字节数。
 */
function sizeOf(dir) {
  let total = 0
  let items
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of items) {
    const full = join(dir, e.name)
    try {
      if (e.isDirectory()) total += sizeOf(full)
      else total += statSync(full).size
    } catch {
      /* 统计失败不影响清理 */
    }
  }
  return total
}

/**
 * 要扫描的根目录（去重）。
 *
 * `C:\Work` 与家目录根是我实际泄漏过的位置，所以必须查 —— 只查系统 temp
 * 会漏掉它们。
 *
 * @returns 根目录列表。
 */
function scanRoots() {
  const roots = new Set()
  roots.add(resolve(tmpdir()))
  roots.add(resolve(homedir()))
  roots.add(resolve(process.cwd()))
  // 父级工作区（dsh-plug-in）也查一层：探针有时把输出放那里。
  roots.add(resolve(process.cwd(), '..'))
  // 历史泄漏位置：C:\Work 根。
  roots.add(resolve('C:\\Work'))
  return [...roots].filter((r) => {
    try {
      return statSync(r).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * 需要往里"看一层"的用户目录。
 *
 * ## 为什么单独处理
 *
 * 有些位置本身是**用户的目录**（不能整体判断、更不能删），但我的探针曾经往
 * 里面写过子目录。`C:\Work\_fpga_tmp` 就是这样：它是 FPGA 综合产物目录，
 * 里面有 `opt/`、`ctl/`、`dsc/` 这些真实数据，同时也混进了我 6 个
 * `dsh-*` 测试残留子目录（home/、state/、探针脚本）。
 *
 * 所以这里只枚举**下一层**，且只匹配 `dsh-*` 前缀 —— `opt`、`ctl` 这些
 * 用户目录一律不碰。
 *
 * @returns 需要检查子项的目录列表。
 */
function nestedRoots() {
  return [
    resolve('C:\\Work\\_fpga_tmp'),
  ].filter((r) => {
    try {
      return statSync(r).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * 收集两处待清理项。
 *
 * @returns 条目列表（绝对路径 + 大小 + 来源）。
 */
function collect() {
  const items = []

  for (const root of scanRoots()) {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !PROBE_PATTERN.test(e.name)) continue
      const full = join(root, e.name)
      items.push({ path: full, label: full, where: 'probe', bytes: sizeOf(full) })
    }
  }

  /*
   * 用户目录里的探针子目录。
   *
   * `_fpga_tmp` 是用户的 FPGA 产物目录，只清其中 `dsh-*` 前缀的子目录
   * （我的测试残留），同级的 `opt/`、`ctl/`、`dsc/` 一律不碰。
   */
  for (const parent of nestedRoots()) {
    for (const e of readdirSync(parent, { withFileTypes: true })) {
      // 注意：有 dsh- 也有 dsh_（历史的 dsh_verify），两种都要认。

      if (!e.isDirectory() || !/^dsh[-_]/.test(e.name)) continue
      const full = join(parent, e.name)
      items.push({ path: full, label: full, where: 'nested', bytes: sizeOf(full) })
    }
  }

  const workspace = resolve(process.cwd())
  for (const e of readdirSync(workspace, { withFileTypes: true })) {
    if (!e.isFile() || !WS_PATTERN.test(e.name)) continue
    const full = join(workspace, e.name)
    let bytes = 0
    try {
      bytes = statSync(full).size
    } catch {
      /* 读不到就当 0 */
    }
    items.push({ path: full, label: e.name, where: 'workspace', bytes })
  }

  return items
}

const items = collect()

if (items.length === 0) {
  console.log('没有测试残留：探针目录与工作区都干净。')
  process.exit(0)
}

const probes = items.filter((i) => i.where === 'probe')
const nested = items.filter((i) => i.where === 'nested')
const wsItems = items.filter((i) => i.where === 'workspace')

if (probes.length > 0) {
  console.log(`探针残留目录：${probes.length} 个`)
  for (const i of probes) console.log(`  ${i.label.padEnd(56)} ${(i.bytes / 1024).toFixed(1)} KB`)
}

if (nested.length > 0) {
  console.log('')
  console.log(`用户目录里的探针子目录：${nested.length} 个（同级用户数据不受影响）`)
  for (const i of nested) console.log(`  ${i.label.padEnd(56)} ${(i.bytes / 1024).toFixed(1)} KB`)
}

if (wsItems.length > 0) {
  console.log('')
  console.log(`工作区残留：${wsItems.length} 个（已被 .gitignore 覆盖，仍建议删）`)
  for (const i of wsItems) console.log(`  ${i.label.padEnd(56)} ${(i.bytes / 1024).toFixed(1)} KB`)
}

const totalBytes = items.reduce((s, i) => s + i.bytes, 0)
console.log('')
console.log(`合计 ${items.length} 项，${(totalBytes / 1024 / 1024).toFixed(2)} MB`)

if (!apply) {
  console.log('')
  console.log('这是 dry run。加 --apply 才会真的删除：')
  console.log('  pnpm clean:tmp --apply')
  process.exit(0)
}

/*
 * 真删。逐个确认路径在它所来自的扫描根之下 —— 名字来自 readdirSync
 * （不含分隔符），仍然做边界检查，因为这个脚本本身就在删东西。
 */
const roots = scanRoots()
const nestedParents = nestedRoots()
let removed = 0
let failed = 0
for (const i of items) {
  const full = resolve(i.path)
  let ok
  if (i.where === 'workspace') {
    ok = full.startsWith(resolve(process.cwd()))
  } else if (i.where === 'nested') {
    // 必须在某个用户目录的**下一层**，且名字是 dsh-*。
    ok = nestedParents.some((p) => {
      const parent = resolve(p)
      return full.startsWith(parent + '\\') && /^dsh[-_]/.test(full.slice(parent.length + 1).split('\\')[0] ?? '')
    })
  } else {
    ok = roots.some((r) => full.startsWith(r))
  }
  if (!ok) {
    console.error(`  跳过越界路径：${full}`)
    failed += 1
    continue
  }
  try {
    rmSync(full, { recursive: true, force: true })
    removed += 1
  } catch (error) {
    console.error(`  删除失败 ${i.label}: ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
}

console.log('')
console.log(`已删除 ${removed} 项${failed > 0 ? `，失败 ${failed} 项` : ''}`)
process.exitCode = failed > 0 ? 1 : 0
