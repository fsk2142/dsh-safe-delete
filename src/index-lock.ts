/**
 * 跨进程索引锁 —— 让主进程和清理 worker 不再互相覆盖索引。
 *
 * ## 问题（2026-10-30 复审 P1-03）
 *
 * `store.ts` 里的 `indexQueue` 只是一条 **Promise 链**，只能串行化**同一进程内**
 * 的操作。而清理现在跑在独立子进程里：
 *
 * ```
 * 主进程  ── 读索引 [] ──┐
 * worker  ── 读索引 [] ──┤  两者都读到空
 * 主进程  ── 写 [A] ─────┤
 * worker  ── 写 [B] ─────┘  主进程的 A 被覆盖掉
 * ```
 *
 * 隔离实验证实了这个交错：最终索引只剩 `[B]`，A 的更新丢失。
 *
 * ## 做法：文件锁 + 进程内队列
 *
 * - **进程内**仍用 Promise 链（快，无系统调用）；
 * - **跨进程**用 `<stateDir>/index.lock`，`wx` 独占创建；
 * - 拿不到锁就短暂重试（几毫秒级退避），而不是无限等待；
 * - 持有者进程已死且锁过期 → 可接管（与 cleanup 锁同一套判据）。
 *
 * 锁只在**读-改-写**期间持有，几毫秒；不做长任务持有。
 *
 * ## 为什么不用操作系统级锁
 *
 * Node 没有跨平台的 `flock`。Unix 有 `fcntl`，Windows 走 `LockFileEx`，
 * 都要原生模块 —— 而本插件的硬约束是零运行时依赖。
 * 「`wx` 创建 + pid + 过期」是这个约束下最接近正确的做法，且已有测试覆盖。
 *
 * @module dsh-safe-delete/index-lock
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 锁文件名。 */
const LOCK_FILE = 'index.lock'

/** 锁多久算过期（毫秒）。索引操作只该占几毫秒，这里给足余量。 */
const STALE_MS = 30_000

/** 拿锁的最长等待（毫秒）。超时就让调用方失败，而不是无限等。 */
const ACQUIRE_TIMEOUT_MS = 10_000

/** 每次重试的退避（毫秒）。 */
const RETRY_MS = 5

/** 锁文件内容。 */
interface LockHolder {
  pid: number
  at: number
  token: string
}

/**
 * 进程是否还活着。
 *
 * @param pid 进程 id。
 * @returns 活着返回 true。
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 读锁文件。
 *
 * @param stateDir 安全区目录。
 * @returns 持有者信息；不存在或损坏时 null。
 */
function readHolder(stateDir: string): LockHolder | null {
  const file = join(stateDir, LOCK_FILE)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockHolder>
    if (typeof parsed.pid !== 'number' || typeof parsed.at !== 'number') return null
    return { pid: parsed.pid, at: parsed.at, token: String(parsed.token ?? '') }
  } catch {
    return null
  }
}

/**
 * 尝试拿到锁（不等待）。
 *
 * ## 必须区分 EEXIST 与其他错误
 *
 * `wx` 在**锁已存在**时抛 `EEXIST` —— 那才是"被别人占用"。
 * 而**父目录不存在**时抛 `ENOENT`，那是环境问题，不是争用。
 *
 * 第一版把任何写入失败都当作"被占用"，于是安全区目录还没创建时
 * `moveToSafeZone` 会空等到 10 秒超时。实测：单次删除卡 3 秒以上、
 * 5 个并发全部失败。
 *
 * @param stateDir 安全区目录。
 * @param token 本次的 owner token。
 * @returns 拿到返回 true。
 */
function tryOnce(stateDir: string, token: string): boolean {
  // 目录不存在时先建出来：锁文件本身也需要它。
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch {
    /* 建不出来就让下面的写入报错，错误信息更具体 */
  }

  const file = join(stateDir, LOCK_FILE)
  const payload = JSON.stringify({ pid: process.pid, at: Date.now(), token })
  try {
    writeFileSync(file, payload, { flag: 'wx' })
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    /*
     * 只有 EEXIST 才是"被别人占用"。其他错误（权限、路径非法、磁盘满）
     * 不该被当成争用去重试 —— 那会把一个立刻可诊断的失败变成 10 秒空等。
     */
    if (code !== 'EEXIST') {
      throw new Error(
        `cannot create the index lock at ${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // 到这里说明锁已存在 —— 判断能否接管。
  const holder = readHolder(stateDir)
  if (holder === null) {
    /*
     * 锁文件存在但读不出内容：可能正被别的进程写到一半。
     * 保守起见不接管（那会破坏互斥）。靠调用方的超时兜底。
     */
    return false
  }
  const age = Date.now() - holder.at
  const alive = isAlive(holder.pid)
  if (age > STALE_MS && !alive) {
    try {
      rmSync(file, { force: true })
      writeFileSync(file, payload, { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * 释放锁（只释放自己持有的）。
 *
 * @param stateDir 安全区目录。
 * @param token 拿锁时用的 token。
 */
function release(stateDir: string, token: string): void {
  const holder = readHolder(stateDir)
  if (holder === null || holder.token !== token) return
  try {
    rmSync(join(stateDir, LOCK_FILE), { force: true })
  } catch {
    /* 释放失败不影响正确性：锁会因过期被接管 */
  }
}

/**
 * 在跨进程锁内执行一段索引操作。
 *
 * ## 语义
 *
 * - 拿到锁 → 执行 `job` → 释放锁；
 * - `job` 抛错也一定释放；
 * - 超时拿不到锁 → 抛错（让调用方明确失败，而不是静默丢更新）。
 *
 * @param stateDir 安全区目录。
 * @param job 要执行的操作。
 * @returns `job` 的结果。
 */
export async function withIndexLock<T>(stateDir: string, job: () => Promise<T>): Promise<T> {
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS

  for (;;) {
    if (tryOnce(stateDir, token)) break
    if (Date.now() >= deadline) {
      const holder = readHolder(stateDir)
      throw new Error(
        `cannot acquire the index lock under ${stateDir} after ${ACQUIRE_TIMEOUT_MS} ms` +
          (holder === null ? '' : `; held by pid ${holder.pid}`) +
          '. Another process is writing the index. Retry shortly — nothing was changed.',
      )
    }
    await new Promise((r) => setTimeout(r, RETRY_MS))
  }

  try {
    return await job()
  } finally {
    release(stateDir, token)
  }
}

/** 供诊断：当前锁的持有者。 */
export function indexLockHolder(stateDir: string): { pid: number; ageMs: number; alive: boolean } | null {
  const holder = readHolder(stateDir)
  if (holder === null) return null
  return { pid: holder.pid, ageMs: Date.now() - holder.at, alive: isAlive(holder.pid) }
}
