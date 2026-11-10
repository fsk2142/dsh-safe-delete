#!/usr/bin/env node
/**
 * 把构建产物与发布文件同步到已安装的 profile 插件目录。
 *
 * ## 为什么需要专门的脚本
 *
 * 手工 `Copy-Item lib\* <dst>\lib\` 只做**覆盖**，不删除目标目录里多余的旧文件。
 *
 * ## 关于 chunk 文件名（2026-11-10 更新）
 *
 * 2.3.2 之前构建产物带内容哈希（`store-ZBayra6Y.js`），每次构建换一批名字，
 * 于是安装目录里越积越多失效 chunk（实测 20 轮迭代后积了 21 个、404 KB）。
 * 那正是当初写这个脚本的原因。
 *
 * **现在** `tsdown.config.ts` 用的是稳定名 `chunks/[name].js`，新构建不再换名字。
 * 但历史遗留的哈希 chunk 仍可能躺在老安装目录里（缺少本脚本时积累下来的），
 * 所以"先删目标里源目录没有的文件"这条逻辑仍然必要 —— 它清理的是**存量**，
 * 不是新产生的。
 *
 * ## 做法
 *
 * 1. 先删目标 `lib/` 里"源目录没有"的条目，再覆盖复制构建产物。删除前逐个
 *    确认路径在目标 `lib/` 之内，且**不是链接**（链接会让遍历跑出安装根）。
 * 2. 按 `package.json#files` 同步其余发布文件（`bin/`、`locale/`、`docs/`、
 *    `cordis.patch.yml`、`icon.svg` …）—— 判据是清单，不是逐条补漏。
 *
 * ## 用法
 *
 *   pnpm build && node scripts/sync-install.mjs
 *
 * 目标目录默认是 desktop profile，可用第一个参数覆盖。
 */

import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync } from 'node:fs'
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

/**
 * 链接守卫的拒绝记录。
 *
 * ## 为什么必须拒绝而不是"跳过继续"（2026-11-10 复审 D05）
 *
 * 安装目录是插件的私有副本。里面出现符号链接 / 目录联接只有两种可能：
 * 别的工具误放、或有人故意把 `lib/chunks` 指向外部。两种情况都不该由
 * 同步脚本去"猜"。
 *
 * 实测过的越界：`mklink /J installed/lib/chunks outside` 之后，`isUnder()`
 * 仍返回 true（词法路径在 `dstLib` 下），而 `statSync`/`readdirSync` 会走进
 * `outside`，`pruneStale()` 把那里的 OUTSIDE_MARKER 移进了系统回收站。
 */
const linkRefusals = new Set()

/**
 * 判断一个条目是不是链接（符号链接 / Windows junction）。
 *
 * 用 `lstatSync`：它不跟随链接，报告的正是"这个条目本身是什么"。
 *
 * @param full 条目绝对路径。
 * @returns 是链接时返回真。
 */
function isLink(full) {
  const st = lstatSync(full, { throwIfNoEntry: false })
  return st !== undefined && st.isSymbolicLink()
}

/**
 * 目标目录的真实路径，用于核对"没被链接带出安装根"。
 *
 * @returns 真实路径；拿不到时 undefined。
 */
function realLibRoot() {
  try {
    return realpathSync(dstLib)
  } catch {
    return undefined
  }
}

/**
 * 一个目录的真实路径是否仍在安装根内。
 *
 * 词法前缀只能证明"名字看起来在里面"，而链接可以让实际位置跑到外面。
 *
 * @param dir 目录绝对路径。
 * @returns 在安装根内返回真；拿不到真实路径时保守返回 false。
 */
function realUnderLib(dir) {
  const root = realLibRoot()
  if (root === undefined) return false
  let real
  try {
    real = realpathSync(dir)
  } catch {
    return false
  }
  return isUnder(real, root)
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

    /*
     * ## 守卫一：只动安装根之内的东西
     *
     * 词法前缀（`isUnder`）只能证明"名字看起来在里面"。链接会让实际位置
     * 跑到外面，所以这里再用 `realpathSync` 核对一次。
     */
    if (!isUnder(full, resolvedLib)) {
      console.error(`跳过越界路径：${full}`)
      continue
    }

    /*
     * ## 守卫二：链接一律拒绝，绝不跟进去（2026-11-10 复审 D05）
     *
     * `statSync` / `readdirSync` 会**跟随**符号链接与 Windows junction。
     * 若 `lib/chunks` 被替换成指向外部的链接，路径看着仍在 `dstLib` 下，
     * 但遍历会走进外部目录 —— 然后对那里"源目录没有的文件"调回收站。
     *
     * 实测：`mklink /J installed/lib/chunks outside` 之后跑真实脚本，
     * `outside/OUTSIDE_MARKER.txt` 确实被移进了系统回收站。
     *
     * 安装目录里出现链接本身就是异常信号，没有"猜一个合理动作"的余地：
     * 拒绝该条目、记下来、继续处理其他条目，最后统一报告。
     */
    if (isLink(full)) {
      linkRefusals.add(full)
      continue
    }
    if (!realUnderLib(destDir)) {
      linkRefusals.add(destDir)
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
        /*
         * 子条目同样要防链接：`statSync` 会跟随，`lstatSync` 不会。
         * 一个指向外部的链接若被当作普通文件，下一行就会把**外部**那个
         * 东西送进回收站。
         */
        if (isLink(childFull)) {
          linkRefusals.add(childFull)
          continue
        }
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
  /*
   * 目标位置若已经是链接，`cpSync` 会往链接指向的目录里写 —— 又一个越界路径
   * （与 `pruneStale` 那条同源）。先看它是什么，是链接就拒绝。
   */
  const destination = join(dstLib, name)
  if (isLink(destination)) {
    linkRefusals.add(destination)
    continue
  }
  cpSync(join(SRC_LIB, name), destination, { recursive: true })
  copied += 1
}

/*
 * 3. 同步**发布清单**里的文件（2026-11-10 复审 D06）。
 *
 * 这里原来只同步 `package.json` / `README.md` / `docs/`。而 `package.json#files`
 * 声明了更多：`bin/`、`locale/`、`cordis.patch.yml`、`icon.svg`。缺任何一项的后果
 * 都是「本地构建与发布包行为不一致」：
 *
 *   - `locale/` 缺 → 插件页 `meta.detail` 读不到，详情页报 invalid；
 *   - `bin/` 缺 → CLI 是旧版（或根本没有）；
 *   - 其余缺 → 图标/补丁不同步，看起来像另一个版本的插件。
 *
 * 判据是**清单本身**，不是逐条补漏：新增发布文件时只要它在 `files` 里，
 * 这里就会带上它。
 */
const manifestFiles = JSON.parse(readFileSync(join(SRC_ROOT, 'package.json'), 'utf8')).files ?? []

/*
 * 逐个复制清单里的条目。`lib/` 已经在上面按构建产物处理过（它有"陈旧检测"），
 * 这里跳过它以免重复；其余条目一律 `cpSync`（目录递归、文件直接覆盖）。
 */
let published = 0
for (const entry of manifestFiles) {
  if (entry === 'lib/') continue
  const name = entry.replace(/\/$/, '')
  const src = join(SRC_ROOT, name)
  if (!existsSync(src)) {
    console.log(`  ⚠ 发布清单里的 ${entry} 在源目录不存在，已跳过`)
    continue
  }
  const dest = join(target, name)
  if (isLink(dest)) {
    linkRefusals.add(dest)
    continue
  }
  /*
   * 先删掉目标里"源目录已经不再有的"同名内容（例如 `docs/` 里删掉的一篇），
   * 再整体复制。判定同样走 `pruneStale`，所以链接守卫一致生效。
   */
  if (existsSync(dest)) pruneStale(src, dest)
  cpSync(src, dest, { recursive: true })
  published += 1
}

/*
 * 链接被拒绝时**必须报告**（2026-11-10 复审 D05）。
 *
 * 安装目录里出现符号链接 / 目录联接本身就是异常：要么是别的工具放错，
 * 要么是有人把它指向了外部。同步脚本不能据此"猜一个动作"，但也绝不能
 * 静默跳过 —— 用户需要知道"这次只同步了一部分，因为那里有链接"。
 */
if (linkRefusals.size > 0) {
  console.log('')
  console.log(`  ⚠ ${linkRefusals.size} 个条目是符号链接/目录联接，已**拒绝**处理（未跟进、未删除）：`)
  for (const path of [...linkRefusals].slice(0, 10)) console.log(`      ${path}`)
  if (linkRefusals.size > 10) console.log(`      … 另有 ${linkRefusals.size - 10} 个`)
  console.log('  安装目录里出现链接通常是异常状态。确认它指向哪里之后再手动处理；')
  console.log('  同步脚本不会跟随链接，也不会删除链接指向的任何内容。')
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
console.log(`  复制 ${copied} 个构建产物，同步 ${published} 项发布文件`)
