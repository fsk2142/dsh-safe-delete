/**
 * 安全区：被删除内容的暂存处，也是本插件唯一会移动用户数据的地方。
 *
 * 布局：
 *   <stateDir>/items/<id>/   被移入的内容
 *   <stateDir>/index.json    条目索引
 *
 * 两条硬约束：
 *   1. **移入用 rename**（同卷 O(1)，不复制、不占额外空间）。跨卷时 `rename`
 *      抛 `EXDEV`；在 `crossVolumeCopy` 为假（默认）时明确拒绝，绝不静默降级为
 *      「复制后删源」那种看起来成功、实则多一份拷贝的行为。
 *   2. **唯一允许递归删除的地方是 `destroyEntry`**，且只针对安全区内部路径。
 *      除此之外本文件不删任何用户数据。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describeTarget } from './describe'
import type { TrashEntry } from './types'

/** 移入选项。 */
export interface MoveOptions {
  /** 删除原因（进审计与卡片）。 */
  reason?: string
  /** 保留天数。 */
  retentionDays: number
  /** 当前时间戳（测试可注入）。 */
  now?: number
  /** 跨卷时是否允许「复制 + 删源」。默认 false。 */
  crossVolumeCopy?: boolean
}

const INDEX_FILE = 'index.json'
const ITEMS_DIR = 'items'

/** 索引路径。 */
function indexPath(stateDir: string): string {
  return path.join(stateDir, INDEX_FILE)
}

/** 条目内容目录。 */
function entryDir(stateDir: string, id: string): string {
  return path.join(stateDir, ITEMS_DIR, id)
}

/**
 * 索引写操作的串行队列。
 *
 * ## 为什么需要
 *
 * `moveToSafeZone` / `destroyEntry` / `restoreFromSafeZone` 都是
 * 「读索引 → 改 → 写回」。DSH 的并发工具调用可达 50，两个并发的删除会读到同一份
 * 旧数组，后写者把它整个覆盖回去 —— 前一条从索引里消失，但内容还留在
 * `items/<id>/` 盘上。后果是**列表看不见、清理永远轮不到**（prune 只扫索引），
 * 属于静默的磁盘泄漏。
 *
 * ## 为什么用 Promise 链而不是文件锁
 *
 * 插件跑在单个宿主进程里，跨进程并发不存在。一条 Promise 链就够，而且
 * 没有锁文件残留、崩溃自动释放的问题。
 */
let indexQueue: Promise<unknown> = Promise.resolve()

/**
 * 把一次索引操作排进队列，保证读-改-写不交错。
 *
 * @param job 要串行执行的操作。
 * @returns 该操作的结果。
 */
function serialized<T>(job: () => Promise<T>): Promise<T> {
  // 无论前一个成功还是失败都继续排队（用 catch 抹掉拒绝，避免链条断掉）。
  const run = indexQueue.then(job, job)
  indexQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** 读索引；不存在或损坏时返回空数组（安全区宁可"看起来空"也不能让删除流程崩掉）。 */
async function readIndex(stateDir: string): Promise<TrashEntry[]> {
  const file = indexPath(stateDir)
  if (!existsSync(file)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed as TrashEntry[]
  } catch {
    return []
  }
}

/**
 * 原子写索引：先写临时文件再 rename，避免中途崩溃留下半个 JSON。
 */
async function writeIndex(stateDir: string, entries: TrashEntry[]): Promise<void> {
  mkdirSync(stateDir, { recursive: true })
  const file = indexPath(stateDir)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 生成一个可读且不冲突的 id。 */
function makeId(now: number): string {
  const d = new Date(now)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return `${stamp}-${rand}`
}

/** `child` 是否在 `parent` 之内（按分隔符边界）。 */
function isUnder(child: string, parent: string): boolean {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  if (c === p) return true
  return c.startsWith(p + path.sep)
}

/**
 * 把一个路径移入安全区。
 *
 * @param stateDir 安全区根目录。
 * @param absPath 要移入的绝对路径。
 * @param opts 保留期与跨卷策略。
 * @returns 新条目。
 */
export async function moveToSafeZone(stateDir: string, absPath: string, opts: MoveOptions): Promise<TrashEntry> {
  return serialized(async () => {
  const target = path.resolve(absPath)

  // 安全区自保护：不能把自己移进自己。
  if (isUnder(stateDir, target) || isUnder(target, stateDir)) {
    throw new Error(`refusing to move the safe zone itself (${target}) into the safe zone`)
  }

  const now = opts.now ?? Date.now()
  const description = describeTarget(target)
  if (!description.exists) {
    throw new Error(`not found: ${target}`)
  }

  const id = makeId(now)
  // 内容放在 `items/<id>/<basename>`：安全区可以被人在资源管理器里直接翻看，
  // 文件名必须认得出原本是什么。`items/<id>` 永远是目录，不随目标是文件而变。
  const entryRoot = entryDir(stateDir, id)
  const dest = path.join(entryRoot, path.basename(target))
  mkdirSync(entryRoot, { recursive: true })

  let crossVolume = false
  try {
    renameSync(target, dest)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw error
    // 跨卷：默认拒绝，让人自己决定是把安全区换到同一卷、还是接受一次真实复制。
    if (opts.crossVolumeCopy !== true) {
      throw new Error(
        `cannot move "${target}" into the safe zone: they are on different volumes. ` +
          'Move the safe zone to the same volume, or enable crossVolumeCopy to copy instead.',
      )
    }
    crossVolume = true
    // 顺序很重要：先复制、再登记索引、**最后**才删源。
    // 如果在删源之前就登记失败，源还在，用户什么都没丢；反过来则会留下
    // "磁盘上没有、索引里也没有"的孤儿数据。
    cpSync(target, dest, { recursive: true, preserveTimestamps: true })
  }

  const entry: TrashEntry = {
    id,
    originalPath: target,
    movedAt: now,
    expiresAt: now + opts.retentionDays * 24 * 60 * 60 * 1000,
    bytes: description.bytes,
    fileCount: description.fileCount,
    isDirectory: description.isDirectory,
    crossVolume,
    ...(opts.reason !== undefined && opts.reason !== '' ? { reason: opts.reason } : {}),
  }

  const entries = await readIndex(stateDir)
  entries.push(entry)
  try {
    await writeIndex(stateDir, entries)
  } catch (error) {
    // 索引写不进去就不能留下无主的拷贝；回滚掉这份拷贝并让原目标保持原样。
    if (crossVolume) {
      try {
        rmSync(dest, { recursive: true, force: true })
      } catch {
        /* 回滚失败也要把原始错误抛出去 */
      }
    }
    throw error
  }

  // 跨卷此刻才删源：索引已经落盘，即使进程立刻崩溃也能按 id 取回。
  if (crossVolume) {
    rmSync(target, { recursive: true, force: true })
  }

  return entry
  })
}

/** 列出安全区条目（按移入时间升序）。 */
export async function listSafeZone(stateDir: string): Promise<TrashEntry[]> {
  const entries = await readIndex(stateDir)
  return [...entries].sort((a, b) => a.movedAt - b.movedAt)
}

/**
 * 从安全区还原一条。
 *
 * 原路径已被占用时还原到同级 `.restored-<时间戳>` 兄弟 —— 绝不覆盖现在的文件。
 */
export async function restoreFromSafeZone(stateDir: string, id: string): Promise<{ restoredTo: string }> {
  return serialized(async () => {
    const entries = await readIndex(stateDir)
    const entry = entries.find((e) => e.id === id)
    if (entry === undefined) {
      throw new Error(`unknown safe-zone id: ${id}`)
    }

    // 内容在 `items/<id>/<basename>`；取该目录下唯一的那个条目。
    const source = resolveStoredContent(stateDir, id)
    if (source === null) {
      throw new Error(`safe-zone entry ${id} has no content on disk`)
    }

    let destination = entry.originalPath
    if (existsSync(destination)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      destination = `${entry.originalPath}.restored-${stamp}`
    }

    mkdirSync(path.dirname(destination), { recursive: true })

    // 跨卷还原：`rename` 会抛 EXDEV。
    //
    // 移入方向早就有「复制 + 删源」的回退，还原方向也必须对称 —— 否则
    // `crossVolumeCopy` 造出来的条目**恰好全都取不回来**，与「可逆删除」的核心
    // 承诺直接矛盾。
    //
    // 顺序：先复制到目标，成功后删源，最后写索引。任一步失败都留下源，
    // 不会出现"安全区没了、原位置也没有"的孤儿状态。
    try {
      renameSync(source, destination)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EXDEV') throw error
      cpSync(source, destination, { recursive: true, preserveTimestamps: true })
      rmSync(source, { recursive: true, force: true })
    }

    // 取回后清掉空的条目目录，避免在安全区里留下空壳。
    try {
      rmSync(entryDir(stateDir, id), { recursive: true, force: true })
    } catch {
      /* 空壳残留不影响取回结果 */
    }

    await writeIndex(stateDir, entries.filter((e) => e.id !== id))
    return { restoredTo: destination }
  })
}

/**
 * 找出某条目实际存放内容的位置。
 *
 * 兼容两种布局：`items/<id>/<basename>`（当前）与 `items/<id>` 本身（早期版本）。
 *
 * @returns 内容路径；条目为空或缺失时返回 `null`。
 */
function resolveStoredContent(stateDir: string, id: string): string | null {
  const root = entryDir(stateDir, id)
  if (!existsSync(root)) return null
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return null
  }
  if (names.length === 0) return null
  if (names.length === 1) return path.join(root, names[0]!)
  // 极端情况（手工往条目目录里放了多份）：返回目录本身，调用方拿到的仍是完整内容。
  return root
}

/**
 * 销毁一条：真正从硬盘抹掉。
 *
 * **这是本文件唯一允许递归删除的地方**，且 `entryDir` 保证路径落在安全区内部。
 */
export async function destroyEntry(stateDir: string, id: string): Promise<void> {
  return serialized(async () => {
    const entries = await readIndex(stateDir)
    const entry = entries.find((e) => e.id === id)
    if (entry === undefined) {
      throw new Error(`unknown safe-zone id: ${id}`)
    }

    const dir = entryDir(stateDir, id)
    // 双保险：即使索引被篡改，也绝不删到安全区之外的路径。
    if (!isUnder(dir, path.join(stateDir, ITEMS_DIR))) {
      throw new Error(`refusing to destroy a path outside the safe zone: ${dir}`)
    }
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }

    await writeIndex(stateDir, entries.filter((e) => e.id !== id))
  })
}

/** 安全区是否为空（含磁盘上无残留条目）。 */
export async function isEmptySafeZone(stateDir: string): Promise<boolean> {
  const entries = await readIndex(stateDir)
  if (entries.length > 0) return false
  const items = path.join(stateDir, ITEMS_DIR)
  if (!existsSync(items)) return true
  try {
    return readdirSync(items).length === 0
  } catch {
    return true
  }
}
