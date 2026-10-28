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
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { moveToSystemRecycleBin } from '../lib/tools.js'

const SRC_ROOT = resolve('.')
const SRC_LIB = join(SRC_ROOT, 'lib')

/**
 * 推导已安装插件的目录。
 *
 * ## 为什么不写死路径
 *
 * 第一版默认值是 `C:\Users\<本机用户名>\.dsh\profiles\...` —— 那是把本机用户名
 * 写进了公开仓库（隐私审计直接判红），而且别人机器上必然找不到这个目录。
 *
 * 改为按 `DSH_HOME` 推导：
 *   - 设了 `DSH_HOME` 就用它（自定义安装位置）；
 *   - 否则退回 `os.homedir()/.dsh`（默认位置）。
 *
 * 这两个来源都不含硬编码的用户名。
 *
 * @param profile profile 名，默认 desktop。
 * @returns 插件目录的绝对路径。
 */
function defaultTarget(profile) {
  const dshHome =
    process.env['DSH_HOME'] !== undefined && process.env['DSH_HOME'] !== ''
      ? resolve(process.env['DSH_HOME'])
      : join(homedir(), '.dsh')
  return join(dshHome, 'profiles', profile, 'node_modules', 'dsh-safe-delete')
}

const explicit = process.argv[2]
const target = explicit !== undefined && explicit !== '' ? resolve(explicit) : defaultTarget('desktop')
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

/**
 * `child` 是否在 `parent` 之内（按分隔符边界）。
 *
 * 与 `src/store.ts` 的 `isUnder` 同一语义。单纯 `child.startsWith(parent)` 会放过
 * 兄弟路径 —— `C:\x\lib-evil` 以 `C:\x\lib` 开头却不是它的子目录。这里枚举来源是
 * `readdirSync`（名字不含分隔符），实际构造不出这种输入，但边界判断本身应当正确。
 *
 * @param child 待判定的路径。
 * @param parent 父目录。
 * @returns 是否在父目录内（含自身）。
 */
function isUnder(child, parent) {
  const c = resolve(child)
  const p = resolve(parent)
  if (c === p) return true
  return c.startsWith(p + (process.platform === 'win32' ? '\\' : '/'))
}

let removed = 0
let removedBytes = 0
let recycled = 0
let hardDeleted = 0
for (const name of dstNames) {
  if (srcNames.has(name)) continue
  const full = resolve(join(dstLib, name))
  // 双保险：只删 dstLib 下的东西。
  if (!isUnder(full, resolvedLib)) {
    console.error(`跳过越界路径：${full}`)
    continue
  }
  removedBytes += statSync(full).size

  /*
   * 先试系统回收站，失败才硬删。
   *
   * 这与本插件的产品理念一致（删除应当可撤回），也让"同步脚本自己误删了什么"
   * 仍然能捞回来。构建产物是已验证不可达的陈旧文件，退到硬删是可接受的兜底 ——
   * 否则回收站不可用（或该平台不支持）时同步会卡住。
   *
   * `moveToSystemRecycleBin` 是同步函数且自带熔断，不会拖慢大批量。
   */
  const outcome = moveToSystemRecycleBin(full)
  if (outcome.ok) {
    recycled += 1
  } else {
    rmSync(full, { force: true })
    hardDeleted += 1
  }
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
if (removed > 0) {
  const detail = hardDeleted > 0 ? `，其中 ${recycled} 个进回收站、${hardDeleted} 个直接删除` : '，均已移入回收站'
  console.log(`  删除陈旧文件 ${removed} 个（${(removedBytes / 1024).toFixed(1)} KB${detail}）`)
} else {
  console.log('  删除陈旧文件 0 个')
}
console.log(`  复制 ${copied} 个文件`)
console.log(`  安装版本 ${version}`)
