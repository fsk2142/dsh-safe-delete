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

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describeTarget } from './describe'
import { moveToSystemRecycleBin, type RecycleOutcome, type Recycler } from './recycle'
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

/** 保留天数的硬边界。与表单、斜杠命令的取值范围保持一致。 */
const RETENTION_MIN_DAYS = 1
const RETENTION_MAX_DAYS = 365

/**
 * 把保留天数收进安全区间。
 *
 * ## 为什么在消费处也要钳
 *
 * 表单（`client/index.tsx`）和斜杠命令（`settings-guide.ts`）都限制 1–365 天，
 * 但**配置文件可以手改**。上游的校验不是数据完整性的最后一道关口。
 *
 * 不钳的后果有两级，都不是「保留更久」那么轻：
 *
 * 1. **`retentionDays: 0` 或负数** → `expiresAt` 落在过去 → 条目刚删进去就被判定
 *    过期，下一轮清理直接进回收站。用户以为有保留期，实际没有。
 * 2. **极大值** → `Date.now() + 1e8 * 86400000` 超出 Date 可表示范围，得到
 *    `Invalid Date`。而 `expiresAt <= now` 对 `NaN` 恒为 false，于是该条目
 *    **永远不会被清理**，且不报任何错。
 *
 * 两种情况都是静默的。所以钳制放在真正写 `expiresAt` 的地方，而不是只放在入口。
 *
 * @param days 上游给的天数（可能非法）。
 * @returns 落在 `[1, 365]` 内的整数天数。
 */
function clampRetentionDays(days: number): number {
  if (!Number.isFinite(days)) return RETENTION_MIN_DAYS
  const whole = Math.round(days)
  if (whole < RETENTION_MIN_DAYS) return RETENTION_MIN_DAYS
  if (whole > RETENTION_MAX_DAYS) return RETENTION_MAX_DAYS
  return whole
}

/** 索引路径。 */
function indexPath(stateDir: string): string {
  return path.join(stateDir, INDEX_FILE)
}

/** 条目内容目录。 */
function entryDir(stateDir: string, id: string): string {
  return path.join(stateDir, ITEMS_DIR, id)
}

/**
 * 把内容搬回原处、再收掉刚建的 `items/<id>` 目录。
 *
 * ## 为什么需要它
 *
 * `moveToSafeZone` 的顺序是：建目录 → 移动内容（rename）→ 写索引。**第三步失败**
 * 时，前两步已经成功：内容真的被移进了 `items/<id>/`，而索引里没有记录指向它。
 *
 * 此时如果只 `rmdir`（空目录才行）就会失败，目录连同**用户的数据**一起变成孤儿：
 * 清理逻辑只遍历索引，所以它既不会被自动清理，也不会出现在 `safe_zone_list` 里
 * —— 用户以为文件还在安全区，其实已经"失联"了。
 *
 * 实测踩到过：一次清理后留下 3 个孤儿目录，`safe_zone_status` 报 87 条而磁盘上
 * 有 90 个目录。
 *
 * ## 正确的补救顺序
 *
 * 1. 先把内容**搬回原路径**（`renameSync` 回去），让用户的数据回到原位；
 * 2. 再删掉现在（应当）已空的 `items/<id>`；
 * 3. 任何一步失败都**只记录不抛**——不能覆盖原始的索引错误。
 *
 * 关键取舍：**宁可不删目录，也不能删掉里面的数据**。所以只有确认搬回成功（或
 * 目录本来就空）才 `rmdir`；如果搬不回去，目录留着 —— 至少数据还在盘上，
 * 用户手动也能捞出来。
 *
 * @param entryRoot 条目目录。
 * @param dest 内容实际落点（`entryRoot/<basename>`）。
 * @param target 原始路径。
 */
function rollbackEntry(entryRoot: string, dest: string, target: string): void {
  // 1. 内容搬回原处。目标位置若已被占用（极少见），搬回会失败，此时不动它。
  try {
    if (existsSync(dest) && !existsSync(target)) {
      renameSync(dest, target)
    }
  } catch {
    /* 搬不回去就保持现状：数据至少还在 items/ 里，不要冒险删 */
  }
  // 2. 只有目录确实空了才收掉。
  try {
    rmdirSync(entryRoot)
  } catch {
    /* 非空（搬回失败留下内容）或已不存在：两种都无需处理 */
  }
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
 * 把内容搬进安全区并返回索引条目，**但不写索引**。
 *
 * 抽出来的目的：批量删除时一批只写一次索引。逐条写时每一条都要重写整个
 * `index.json`（删第 N 条时文件已有 N-1 条），总成本 O(N²) —— 1000 个文件
 * 实测在数秒级（4–6 秒，随索引大小与磁盘而异）。合并后同一批只要约 0.4 秒。
 *
 * ## 调用方的责任
 *
 * 拿到返回值后**必须**把它并进索引（`moveToSafeZone` 或 `moveManyToSafeZone`
 * 都会做）。如果调用方忘了，就会出现「磁盘上有内容、索引里没记录」的孤儿 ——
 * 清理逻辑只遍历索引，那些目录永远清不掉。
 *
 * @param stateDir 安全区根目录。
 * @param absPath 要移入的路径。
 * @param opts 保留期与跨卷策略。
 * @returns 索引条目。
 */
async function stageInto(stateDir: string, absPath: string, opts: MoveOptions): Promise<TrashEntry> {
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
    if (code !== 'EXDEV') {
      rollbackEntry(entryRoot, dest, target)
      throw error
    }
    // 跨卷：默认拒绝，让人自己决定是把安全区换到同一卷、还是接受一次真实复制。
    if (opts.crossVolumeCopy !== true) {
      // 拒绝之前必须把刚建的 `items/<id>` 空目录收掉，否则它会变成"索引里没有、
      // 磁盘上却存在"的孤儿，越攒越多且没人清。
      rollbackEntry(entryRoot, dest, target)
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

  return {
    id,
    originalPath: target,
    movedAt: now,
    // 保留天数在**消费处**再钳一次，不信上游。
    expiresAt: now + clampRetentionDays(opts.retentionDays) * 24 * 60 * 60 * 1000,
    bytes: description.bytes,
    fileCount: description.fileCount,
    isDirectory: description.isDirectory,
    crossVolume,
    ...(opts.reason !== undefined && opts.reason !== '' ? { reason: opts.reason } : {}),
  }
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
    const entry = await stageInto(stateDir, absPath, opts)

    const entries = await readIndex(stateDir)
    entries.push(entry)
    try {
      await writeIndex(stateDir, entries)
    } catch (error) {
      /*
       * 索引写失败：`items/<id>` 里的内容没有记录指向，必须收回。
       *
       * 非跨卷时内容是真的被 rename 进去了，只 `rmdirSync` 删不掉（目录非空），
       * 必须先 `rollbackEntry` 把它搬回原路径。跨卷时是复制出来的副本，直接删。
       */
      const root = entryDir(stateDir, entry.id)
      if (entry.crossVolume) {
        try {
          rmSync(root, { recursive: true, force: true })
        } catch {
          /* 回滚失败也要把原始错误抛出去 */
        }
      } else {
        rollbackEntry(root, path.join(root, path.basename(entry.originalPath)), entry.originalPath)
      }
      throw error
    }

    // 跨卷此刻才删源：索引已经落盘，即使进程立刻崩溃也能按 id 取回。
    if (entry.crossVolume) {
      rmSync(entry.originalPath, { recursive: true, force: true })
    }

    return entry
  })
}

/**
 * 批量移入：所有成功项**只在最后写一次索引**。
 *
 * ## 为什么
 *
 * `moveToSafeZone` 每调用一次就重写整个 `index.json`。删 1000 个文件时索引会
 * 从 0 涨到 1000 条，累计重写量是 O(N²)，实测在数秒级（4–6 秒）。这里改成一次。
 *
 * ## 失败语义没变
 *
 * - 单条失败只影响那一条，其余照常；
 * - 有失败时仍然把**成功的那些**写进索引（否则它们的磁盘内容就成了孤儿）；
 * - 一条都没成功就不写索引（避免无意义的空写）。
 *
 * ## 与 `moveToSafeZone` 的关系
 *
 * 两者共用 `stageInto`，所以分级判定、回滚、跨卷策略完全一致 —— 这里只是把
 * 「写索引」这一步提到了循环外面。
 *
 * @param stateDir 安全区根目录。
 * @param absPaths 要移入的路径列表。
 * @param opts 保留期与跨卷策略。
 * @returns 每条的结果（成功带条目，失败带原因）。
 */
export async function moveManyToSafeZone(
  stateDir: string,
  absPaths: string[],
  opts: MoveOptions,
): Promise<Array<{ path: string; entry?: TrashEntry; error?: string }>> {
  return serialized(async () => {
    const results: Array<{ path: string; entry?: TrashEntry; error?: string }> = []
    const staged: TrashEntry[] = []

    for (const p of absPaths) {
      try {
        const entry = await stageInto(stateDir, p, opts)
        staged.push(entry)
        results.push({ path: p, entry })
      } catch (error) {
        results.push({ path: p, error: error instanceof Error ? error.message : String(error) })
      }
    }

    if (staged.length === 0) return results

    // 一次性合并：读一次、写一次。
    const entries = await readIndex(stateDir)
    entries.push(...staged)
    try {
      await writeIndex(stateDir, entries)
    } catch (error) {
      /*
       * 索引写失败：这一批的磁盘内容全都没有记录指向，必须逐个回滚，
       * 否则会留下成批的孤儿目录。
       */
      for (const entry of staged) {
        const root = entryDir(stateDir, entry.id)
        if (entry.crossVolume) {
          try {
            rmSync(root, { recursive: true, force: true })
          } catch {
            /* 继续回滚其余条目 */
          }
        } else {
          // 非跨卷：内容是真的被 rename 进去了，搬回原处才是正确回滚。
          rollbackEntry(root, path.join(root, path.basename(entry.originalPath)), entry.originalPath)
        }
      }
      throw error
    }

    // 跨卷的源在索引落盘后才删。
    for (const entry of staged) {
      if (entry.crossVolume) {
        rmSync(entry.originalPath, { recursive: true, force: true })
      }
    }

    return results
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
 * 销毁一条：**优先移入系统回收站**，只有明确要求时才永久抹掉。
 *
 * ## 为什么不是直接 rmSync
 *
 * 安全区和系统回收站是两道防线：
 *
 *   删除 → 安全区（保留期内 `safe_zone_restore` 可取回）
 *        → 到期 → 系统回收站（用户清空之前都能还原）
 *        → 用户手动清空回收站 → 才真正消失
 *
 * 如果这里直接 `rmSync`，就把「自动过期」升级成了最终删除 —— 而安全区的定时
 * 清理是**无人值守**的，不该替用户做这个决定。
 *
 * ## 失败时不删除
 *
 * 移入回收站失败（权限、系统组件缺失、路径被占用）时，条目**留在安全区**并把
 * 原因返回给调用方，由 `safe_zone_status` 报告。宁可占磁盘，也不能静默永久删除。
 *
 * @param stateDir 安全区根目录。
 * @param id 条目 id。
 * @param options `permanent: true` 时才真正 rmSync（用于「清空安全区」这类明示操作）；
 *   `recycler` 可替换回收站实现（测试用替身，生产路径不传）。
 * @returns 结果；失败时附带原因，条目未被删除。
 */
export async function destroyEntry(
  stateDir: string,
  id: string,
  options: { permanent?: boolean; recycler?: Recycler } = {},
): Promise<{ ok: true; via: 'recycle' | 'permanent' } | { ok: false; reason: string }> {
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
    if (!existsSync(dir)) {
      // 磁盘上已经没有了：只清理索引，不算失败。
      await writeIndex(stateDir, entries.filter((e) => e.id !== id))
      return { ok: true, via: 'permanent' }
    }

    let via: 'recycle' | 'permanent' = 'permanent'
    if (options.permanent !== true) {
      const recycler = options.recycler ?? moveToSystemRecycleBin
      // 包一层 try：recycler 自身抛错（假实现、平台 API 异常）也必须降级成
      // 「跳过这一条」，不能让异常冒出去中断整轮清理 —— 那样后面的条目连尝试
      // 都没有，而且调用方拿不到任何说明。
      let outcome: RecycleOutcome
      try {
        outcome = recycler(dir)
      } catch (error) {
        outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      if (!outcome.ok) {
        // 关键：不删除，把原因带回去。
        return { ok: false, reason: outcome.reason }
      }
      via = 'recycle'
    } else {
      rmSync(dir, { recursive: true, force: true })
    }

    await writeIndex(stateDir, entries.filter((e) => e.id !== id))
    return { ok: true, via }
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
