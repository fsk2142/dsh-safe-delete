#!/usr/bin/env node
/**
 * 把构建产物同步到已安装的 profile 插件目录。
 *
 * ## 为什么需要专门的脚本
 *
 * 手工 `Copy-Item lib\* <dst>\lib\` 只做**覆盖**，不删除目标目录里多余的旧文件。
 * 而构建产物的文件名带内容哈希（`store-ZBayra6Y.js`），每次构建都会变 ——
 * 于是安装目录里越积越多失效 chunk。
 *
 * 实测：经过 20 轮迭代后，安装目录 `lib/` 里积了 **21 个陈旧 chunk、404 KB**，
 * 本地只有 19 个文件。它们不被任何文件引用，不影响功能，但：
 *
 *   - 让人误判"装的是哪一版"（磁盘上同时存在好几个版本的 chunk）；
 *   - 排查问题时在错误的文件里找代码。
 *
 * ## 做法
 *
 * 先删目标 `lib/` 里"源目录没有"的文件，再覆盖复制。删除前逐个确认路径在
 * 目标 `lib/` 之内，避免误删。
 *
 * ## 用法
 *
 *   pnpm build && node scripts/sync-install.mjs
 *
 * 目标目录默认是 desktop profile，可用第一个参数覆盖。
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC_ROOT = resolve('.')
const SRC_LIB = join(SRC_ROOT, 'lib')

const target =
  process.argv[2] ?? '(process.env.USERPROFILE ?? process.env.HOME ?? '.') + '\\.dsh\\profiles\\desktop\\node_modules\\dsh-safe-delete''
const dstLib = join(target, 'lib')

if (!existsSync(SRC_LIB)) {
  console.error(`构建产物不存在：${SRC_LIB}\n先运行 pnpm build`)
  process.exit(1)
}
if (!existsSync(target)) {
  console.error(`目标插件目录不存在：${target}`)
  process.exit(1)
}

const srcNames = new Set(readdirSync(SRC_LIB))
const dstNames = readdirSync(dstLib)

// 1. 删除目标里多余的陈旧文件（路径必须在 dstLib 之内）。
const resolvedLib = resolve(dstLib)
let removed = 0
let removedBytes = 0
for (const name of dstNames) {
  if (srcNames.has(name)) continue
  const full = resolve(join(dstLib, name))
  // 双保险：只删 dstLib 下的东西。
  if (!full.startsWith(resolvedLib)) {
    console.error(`跳过越界路径：${full}`)
    continue
  }
  removedBytes += statSync(full).size
  rmSync(full, { force: true })
  removed += 1
}

// 2. 覆盖复制构建产物。
let copied = 0
for (const name of srcNames) {
  copyFileSync(join(SRC_LIB, name), join(dstLib, name))
  copied += 1
}

// 3. 同步 package.json 与 README（版本号要跟着走）。
for (const name of ['package.json', 'README.md']) {
  const src = join(SRC_ROOT, name)
  if (existsSync(src)) copyFileSync(src, join(target, name))
}

const { version } = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))

console.log(`同步到 ${target}`)
console.log(`  删除陈旧文件 ${removed} 个（${(removedBytes / 1024).toFixed(1)} KB）`)
console.log(`  复制 ${copied} 个文件`)
console.log(`  安装版本 ${version}`)
