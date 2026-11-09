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

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync } from 'node:fs'
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

/** 源目录的顶层条目名：决定要复制什么、以及目标里哪些是陈旧的。 */
const srcNames = new Set(readdirSync(SRC_LIB))

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
/** 回收站不可用而**留在原地**的文件数（不再硬删，见下方注释）。 */
let kept = 0
/** 保留下来的文件及原因，供用户判断。 */
const keptReasons = []

/**
 * 把目标里"源目录没有的条目"逐层处理掉。
 *
 * ## 为什么必须递归（2026-11-09）
 *
 * chunk 挪进 `lib/chunks/` 之后，只比顶层就看不见子目录里的东西：源目录的
 * `chunks` 项在目标里也存在（名字相同），于是整个子目录被跳过 ——
 * 而里面可能躺着上一版留下的 `store-OLDHASH.js`。它们不影响运行（无人 import），
 * 但会让人以为"两套并存"。
 *
 * @param sourceDir 源目录（构建产物）；传 `null` 表示"这一整棵在源里不存在"。
 * @param destDir 目标目录（安装副本）。
 * @param depth 当前深度，只用于日志缩进。
 */
function pruneStale(sourceDir, destDir, depth = 0) {
  let destNames
  try {
    destNames = readdirSync(destDir)
  } catch {
    return
  }
  // 源整棵不存在（`null`）：目标这边全都是陈旧的。
  const srcNames =
    sourceDir === null ? new Set() : new Set(readdirSync(sourceDir, { withFileTypes: true }).map((e) => e.name))
  for (const name of destNames) {
    const full = resolve(join(destDir, name))
    // 双保险：只动 dstLib 之内的东西。
    if (!isUnder(full, resolvedLib)) {
      console.error(`跳过越界路径：${full}`)
      continue
    }
    if (srcNames.has(name)) {
      // 两边都有：源是目录就继续往下比，源是文件就不动（覆盖在后面做）。
      const srcChild = join(sourceDir, name)
      if (statSync(full, { throwIfNoEntry: false })?.isDirectory() === true) {
        if (statSync(srcChild, { throwIfNoEntry: false })?.isDirectory() === true) {
          pruneStale(srcChild, full, depth + 1)
        }
      }
      continue
    }

    // 只有目标里有 —— 陈旧条目。
    const st = statSync(full, { throwIfNoEntry: false })
    if (st === undefined) continue
    if (st.isDirectory()) {
      /*
       * 整个子目录都不在源里：逐个文件走回收站，最后清掉空目录。
       *
       * 不直接 `rm -rf` —— 那条路径会把"回收失败就保留"的保护一起绕过。
       */
      for (const child of readdirSync(full)) {
        const childFull = join(full, child)
        const childSt = statSync(childFull, { throwIfNoEntry: false })
        if (childSt === undefined) continue
        if (childSt.isDirectory()) {
          // 嵌套目录：整棵都不在源里，按空源目录递归处理。
          pruneStale(null, childFull, depth + 1)
          continue
        }
        removedBytes += childSt.size
        const outcome = moveToSystemRecycleBin(childFull)
        if (outcome.ok) {
          recycled += 1
          removed += 1
        } else {
          kept += 1
          keptReasons.push(`${child} — ${outcome.reason}`)
        }
      }
      // 目录空了就移除；还有残留（回收失败）就留着。
      try {
        /*
         * 用 `rmdirSync` 而不是 `rmSync(..., { recursive: false })`。
         *
         * Node 22+ 里后者对**目录**直接报 `ERR_FS_EISDIR`（"Path is a directory"），
         * 于是空目录永远删不掉 —— 实测删完 `oldsub2` 里的文件之后，那个空目录
         * 仍留在原地。`rmdirSync` 才是"删一个空目录"的正确 API；非空时报
         * `ENOTEMPTY`，那正是想要的保护（有残留就留着）。
         */
        if (readdirSync(full).length === 0) rmdirSync(full)
      } catch {
        /* 留着一个空目录不影响运行 */
      }
      continue
    }

    removedBytes += st.size

    /*
     * 先试系统回收站。**失败就留着并报告，不再硬删**
     * （2026-10-30 复审 SD-O3）。
     *
     * ## 为什么改掉了"失败才硬删"
     *
     * 第一版的理由是"构建产物是已验证不可达的陈旧文件，硬删可接受"。
     * 但那个理由有两个漏洞：
     *
     * 1. **"已验证不可达"是针对构建产物的判断，不是针对这一份文件的判断**。
     *    安装目录里可能混有人工补丁、本地调试改动、或别的工具放进来的文件 ——
     *    它们同样会出现在 lib/ 里。
     * 2. 回收站不可用**恰好**是"这台机器上文件操作不太正常"的信号。在那种
     *    时刻选择永久删除，方向反了。
     *
     * 现在：回收失败 → 保留文件、计入 `kept`、打印原因。同步可能因此留下
     * 几个陈旧 chunk，那是可见的小麻烦；永久删掉一份不可恢复的文件，是不可见的大麻烦。
     *
     * `moveToSystemRecycleBin` 是同步函数且自带熔断，不会拖慢大批量。
     */
    const outcome = moveToSystemRecycleBin(full)
    if (outcome.ok) {
      recycled += 1
      removed += 1
    } else {
      /*
       * 留在原地，让用户看到并自行决定。
       *
       * 不抛错中断整个同步 —— 那会让"一个陈旧文件回收失败"挡住其余的正常清理。
       */
      kept += 1
      keptReasons.push(`${full.split(/[\\/]/).pop()} — ${outcome.reason}`)
    }
  }
}

pruneStale(SRC_LIB, dstLib)

// 2. 覆盖复制构建产物。
let copied = 0
for (const name of srcNames) {
  /*
   * **必须处理子目录**（2026-11-09，与 `chunkFileNames: 'chunks/[name].js'` 同批改）。
   *
   * 第一版无条件 `copyFileSync(join(SRC_LIB, name), join(dstLib, name))`。
   * 在 chunk 平铺于 `lib/` 根目录时没问题 —— 那个目录里只有文件。改成
   * `lib/chunks/` 之后，`readdirSync` 会返回一个目录名，而 `copyFileSync`
   * 对目录抛 `EPERM`，整个同步在最后一步崩掉（前面的删除已经执行完，
   * 于是安装目录停在"删了旧的、没复制新的"这个状态）。
   *
   * 实测复现：`sync-install.mjs` → EPERM copyfile lib\\chunks。
   *
   * `cpSync` 的 `recursive: true` 对**文件**同样有效（只是不递归），所以两条路
   * 合并成一次调用，不需要判断类型。
   */
  cpSync(join(SRC_LIB, name), join(dstLib, name), { recursive: true })
  copied += 1
}

// 3. 同步 package.json 与 README（版本号要跟着走）。
for (const name of ['package.json', 'README.md']) {
  const src = join(SRC_ROOT, name)
  if (existsSync(src)) copyFileSync(src, join(target, name))
}

/*
 * 4. 同步 docs/。
 *
 * README 现在只放操作说明，参数与配置全表在 `docs/REFERENCE.md` —— README
 * 里那个链接指向它。不同步的话，插件页里「更多」那一行会指向不存在的文件。
 */
const srcDocs = join(SRC_ROOT, 'docs')
const dstDocs = join(target, 'docs')
if (existsSync(srcDocs)) {
  mkdirSync(dstDocs, { recursive: true })
  for (const name of readdirSync(srcDocs)) {
    if (!name.endsWith('.md')) continue
    copyFileSync(join(srcDocs, name), join(dstDocs, name))
  }
}

const { version } = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))

console.log(`同步到 ${target}`)
if (removed > 0) {
  console.log(
    `  清理陈旧文件 ${removed} 个（${(removedBytes / 1024).toFixed(1)} KB，已移入系统回收站）`,
  )
} else {
  console.log('  清理陈旧文件 0 个')
}
/*
 * 回收站不可用时**明确告诉用户哪些没删、为什么**。
 *
 * 这些文件留在原地不影响插件运行（它们是不可达的陈旧 chunk），
 * 但用户需要知道"同步没有完全清干净"，而不是以为什么都没发生。
 */
if (kept > 0) {
  console.log('')
  console.log(`  ⚠ ${kept} 个陈旧文件未能移入回收站，**已保留在原处**（未永久删除）：`)
  for (const reason of keptReasons.slice(0, 10)) {
    console.log(`      ${reason}`)
  }
  if (keptReasons.length > 10) console.log(`      … 另有 ${keptReasons.length - 10} 个`)
  console.log('    这些是不可达的旧构建产物，不影响运行。想手动清理请先修好回收站，')
  console.log('    或自行确认后删除 —— 脚本不会替你永久删。')
}
console.log(`  复制 ${copied} 个文件`)
console.log(`  安装版本 ${version}`)
