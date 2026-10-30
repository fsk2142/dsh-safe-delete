/**
 * 把绝对路径分成三级：`free` / `confirm` / `protected`。
 *
 * 纯函数，不碰文件系统。分级决定两件事：要不要弹审批卡，以及是否允许走安全删除。
 *
 * 两条必须守住的正确性约束（都在测试里钉死）：
 *   1. 判定前先规范化 —— `C:\Work\..\Users\alice\...` 必须被认成家目录下的路径，
 *      否则保护规则可以被写法绕开。
 *   2. 包含关系必须按分隔符边界判断 —— `C:\Users\alice2` 不在 `C:\Users\alice` 内。
 */

import os from 'node:os'
import path from 'node:path'

import type { Classification } from './types'

/** 分类所需的路径事实。 */
export interface ClassifyEnv {
  /** 用户主目录（`os.homedir()`）。 */
  home: string
  /** 当前会话工作目录。 */
  workdir: string
  /** DSH 安装目录；提供时其下所有内容受保护。 */
  installDir?: string
  /** DSH_HOME；默认 `<home>/.dsh`。 */
  dshHome?: string
  /**
   * 系统临时目录。默认取 `os.tmpdir()`。
   *
   * 必须单独豁免：Windows 上 `%TEMP%` 位于 `C:\Users\<user>\AppData\Local\Temp`，
   * 也就是**在家目录里面**。若不豁免，删任何一个临时文件都会弹审批卡 ——
   * 真实使用中这正是被抱怨的那类打扰。
   */
  tmpdir?: string
  /**
   * 安全区状态目录的实际位置。
   *
   * 默认按 `<dshHome>/.dsh-safe-delete` 推导，但 `stateDir` 是可配置的 ——
   * 配到别处时若不显式告知，安全区自身就会失去保护。
   */
  safeZoneDir?: string
}

/** profile 目录下受保护的清单文件名。 */
const PROTECTED_PROFILE_FILES = [
  'package.json',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
] as const

/** 受保护的 home 级文件名。 */
const PROTECTED_HOME_FILES = ['cordis.patch.yml', 'settings.yaml'] as const

/**
 * 路径规范化 + Windows 风格的大小写归一。
 *
 * @param p 任意路径。
 * @returns 规范化后的绝对路径（Windows 上统一小写）。
 */
function normalize(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * `child` 是否在 `parent` 之内（含相等）。
 *
 * 按分隔符边界判断，避免 `C:\Users\alice2` 被误认为在 `C:\Users\alice` 下。
 */
function isUnder(child: string, parent: string): boolean {
  const c = normalize(child)
  const p = normalize(parent)
  if (c === p) return true
  return c.startsWith(p + path.sep)
}

/**
 * 路径中是否含名为 `node_modules` 的目录段。
 */
function hasNodeModulesSegment(p: string): boolean {
  return normalize(p)
    .split(path.sep)
    .includes('node_modules')
}

/**
 * 判断一个路径的分级。
 *
 * @param absPath 待判定路径（会被规范化）。
 * @param env 分类事实。
 */
export function classifyPath(absPath: string, env: ClassifyEnv): Classification {
  const target = normalize(absPath)
  const home = normalize(env.home)
  const dshHome = normalize(env.dshHome ?? path.join(env.home, '.dsh'))
  // 安全区可能被配置到任意位置（`stateDir`），所以由调用方显式告知，
  // 不能只按 `<dshHome>/.dsh-safe-delete` 猜 —— 猜错就等于让插件自己的状态目录
  // 暴露在写入/删除通道下。
  const safeZone = normalize(env.safeZoneDir ?? path.join(env.dshHome ?? path.join(env.home, '.dsh'), '.dsh-safe-delete'))

  // 1. 安全区自身：永不允许被删除。
  if (isUnder(target, safeZone)) return 'protected'

  /*
   * 2. 安装目录与 node_modules：**必须在临时目录豁免之前**。
   *
   * 原来的顺序是"临时目录 → 安装目录 → node_modules"，于是只要安装目录或
   * 某个 `node_modules` 恰好位于 `%TEMP%` 之下（便携安装、CI 容器、
   * `npm install` 到临时目录都很常见），就会被前面的豁免短路成 `free`，
   * 一次误删就能让 DSH 起不来。
   *
   * 保护规则优先于便利规则 —— 这个顺序没有取舍空间。
   */
  if (env.installDir !== undefined && env.installDir !== '' && isUnder(target, env.installDir)) {
    return 'protected'
  }
  if (hasNodeModulesSegment(target)) return 'protected'

  // 3. 系统临时目录：豁免。
  //
  // Windows 上 `%TEMP%` 在 `C:\Users\<user>\AppData\Local\Temp`，也就是在家目录
  // 内部。它是"可丢弃"区域的语义，不是"用户的东西"；不豁免就会让每次删临时文件
  // 都弹卡。这一条仍然排在家目录 → confirm 之前。
  const tmp = normalize(env.tmpdir ?? os.tmpdir())
  if (isUnder(target, tmp)) return 'free'

  // 4. profile 下的清单类文件。
  const profilesRoot = path.join(dshHome, 'profiles')
  if (isUnder(target, profilesRoot)) {
    const base = path.basename(target)
    const parent = path.basename(path.dirname(target))
    // `<dshHome>/profiles/<name>/<file>` 或更深层同名的清单文件都不许删。
    if ((PROTECTED_PROFILE_FILES as readonly string[]).includes(base)) {
      return 'protected'
    }
    // profile 根目录本身（`<dshHome>/profiles/<name>`）算 confirm：它是插件源码的家，
    // 删它需要人点头，但不至于像清单文件那样「一改就起不来」。
    if (parent === 'profiles') return 'confirm'
  }

  // 6. home 级清单/设置。
  if (isUnder(target, dshHome)) {
    const base = path.basename(target)
    if ((PROTECTED_HOME_FILES as readonly string[]).includes(base)) return 'protected'
    // `<dshHome>` 下的其他内容（sessions / storages / 插件数据）视为 confirm。
    return 'confirm'
  }

  // 7. 家目录下其余内容。
  if (isUnder(target, home)) return 'confirm'

  // 8. 其余：自由。
  return 'free'
}

/**
 * 该分级是否需要在界面里获得用户授权。
 *
 * 用户已明确：只有危险路径弹卡，普通工作区文件直接进安全区不打扰。
 */
export function requiresApproval(classification: Classification): boolean {
  return classification === 'confirm' || classification === 'protected'
}
