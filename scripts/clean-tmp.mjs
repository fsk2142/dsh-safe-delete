#!/usr/bin/env node
/**
 * 清理测试与探针脚本留下的残留。
 *
 * ## 为什么需要
 *
 * 全量测试走后 `tests/support/tmpdir.ts` 的 `scratchDir()`，它在 `afterEach`
 * 里自己收尾。但**一次性探针脚本**（为测量某件事临时写的 `zz-*.ts`）常常直接
 * 用 `mkdtempSync`，跑完源码删了，临时目录却留在系统 temp 里。
 *
 * 实测累积到 59 个目录、6.5 MB。
 *
 * ## 两处都要查
 *
 * 1. **系统临时目录**里的 `dsd-*` / `.dsd-*` 残留；
 * 2. **工作区**里的探针脚本（`zz-*`）、输出清单（`.tmp-*`）、草稿（`.msg*` / `.rel*`）。
 *
 * 第二类已被 `.gitignore` 覆盖（不会误提交），但留在工作树里仍然碍事。
 *
 * ## 用法
 *
 *   pnpm clean:tmp          只列出会清什么（dry run）
 *   pnpm clean:tmp --apply  真的清理
 *
 * 默认 dry run 是刻意的：这是删文件，`--apply` 是明确的选择。
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** 系统临时目录里的本项目残留前缀。 */
const TEMP_PATTERN = /^\.?dsd[-_]|^safe-delete/
/** 工作区里的探针与草稿。 */
const WS_PATTERN = /^(zz-|\.tmp-|\.msg|\.rel)/

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
 * 收集两处待清理项。
 *
 * @returns 条目列表（绝对路径 + 大小）。
 */
function collect() {
  const items = []

  const tempRoot = resolve(tmpdir())
  for (const e of readdirSync(tempRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !TEMP_PATTERN.test(e.name)) continue
    const full = join(tempRoot, e.name)
    items.push({ path: full, label: e.name, where: 'temp', bytes: sizeOf(full) })
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

  return { items, tempRoot, workspace }
}

const { items, tempRoot, workspace } = collect()

if (items.length === 0) {
  console.log('没有测试残留：系统临时目录与工作区都干净。')
  process.exit(0)
}

const tempItems = items.filter((i) => i.where === 'temp')
const wsItems = items.filter((i) => i.where === 'workspace')

if (tempItems.length > 0) {
  console.log(`系统临时目录 ${tempRoot}：${tempItems.length} 个`)
  for (const i of tempItems) console.log(`  ${i.label.padEnd(46)} ${(i.bytes / 1024).toFixed(1)} KB`)
}

if (wsItems.length > 0) {
  console.log('')
  console.log(`工作区 ${workspace}：${wsItems.length} 个（已被 .gitignore 覆盖，仍建议删）`)
  for (const i of wsItems) console.log(`  ${i.label.padEnd(46)} ${(i.bytes / 1024).toFixed(1)} KB`)
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
 * 真删。逐个确认路径在各自的根之下 —— 名字来自 readdirSync（不含分隔符），
 * 仍然做边界检查，因为这个脚本本身就在删东西。
 */
let removed = 0
let failed = 0
for (const i of items) {
  const root = i.where === 'temp' ? tempRoot : workspace
  const full = resolve(i.path)
  if (!full.startsWith(root)) {
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
