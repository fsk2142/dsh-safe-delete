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

/**
 * 索引读取结果。
 *
 * 为什么不是「直接返回数组」：**必须区分"没有索引"和"索引坏了"**。
 * 前者可以正常初始化，后者绝不能当成空索引继续写 —— 那会把还没登记的
 * 条目永久变成孤儿（见 `readIndex` 的注释）。
 */
type IndexRead =
  | { kind: 'ok'; entries: TrashEntry[] }
  /** 索引文件不存在：全新的安全区，可以正常初始化。 */
  | { kind: 'missing' }
  /** 索引存在但读不出来（权限/IO）或内容非法。**禁止任何写操作**。 */
  | { kind: 'corrupt'; reason: string }

/**
 * 读索引，区分三种状态。
 *
 * ## 为什么不能"坏了就当空"
 *
 * 早期实现里解析失败直接 `return []`，后果是灾难性的：
 *
 *   1. 用户的安全区里有 100 个条目，索引因为断电/杀进程/同步软件写坏了；
 *   2. 用户再删一个文件 → `moveToSafeZone` 拿到的 `entries` 是 `[]`；
 *   3. `entries.push(newEntry)` 然后 `writeIndex` —— **原索引被整个覆盖**；
 *   4. 那 100 个条目的内容还在 `items/` 里，但索引没了：
 *      列表看不到、恢复拿不回来、定期清理也不会再处理它们。
 *
 * 也就是说"索引坏"这个本来只影响可读性的故障，被放大成了"永久丢失可恢复性"。
 * 对这个插件的核心承诺来说，这是最不能接受的方向。
 *
 * 所以：**只有"文件确实不存在"才允许当作空索引**。其余一律 fail-closed，
 * 让调用方拒绝这次操作，把损坏的原文件留在原地等人处理。
 *
 * @param stateDir 安全区根目录。
 * @returns 三态读取结果。
 */
async function readIndex(stateDir: string): Promise<IndexRead> {
  const file = indexPath(stateDir)
  if (!existsSync(file)) return { kind: 'missing' }

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return {
      kind: 'corrupt',
      reason: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // 空文件按损坏处理：正常写出的索引永远不会是 0 字节。
  if (raw.trim() === '') {
    return { kind: 'corrupt', reason: `index file is empty: ${file}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      kind: 'corrupt',
      reason: `index file is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    }
  }

  if (!Array.isArray(parsed)) {
    return { kind: 'corrupt', reason: `index file is not a JSON array: ${file}` }
  }

  // 结构校验：每条至少要有 id 与 originalPath，否则后续按 id 查找会静默失配。
  const entries: TrashEntry[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    const e = item as Partial<TrashEntry>
    if (typeof e.id !== 'string' || e.id === '' || typeof e.originalPath !== 'string') {
      return { kind: 'corrupt', reason: `index entry missing id/originalPath: ${JSON.stringify(item).slice(0, 120)}` }
    }
    if (seen.has(e.id)) {
      return { kind: 'corrupt', reason: `duplicate id in index: ${e.id}` }
    }
    seen.add(e.id)
    entries.push(item as TrashEntry)
  }
  return { kind: 'ok', entries }
}

/**
 * 读索引并保证"可安全写入"：不存在时给空数组，损坏时**抛错**。
 *
 * 所有"要写索引"的路径都走这个；纯读路径（列表、状态）用 `readIndexForRead`。
 *
 * @param stateDir 安全区根目录。
 * @returns 索引条目（不存在时为空数组）。
 */
async function readIndexForWrite(stateDir: string): Promise<TrashEntry[]> {
  const read = await readIndex(stateDir)
  if (read.kind === 'corrupt') {
    throw new Error(
      `refusing to modify the safe zone: its index is corrupt and rewriting it would lose ${'the existing entries'}. ` +
        `Reason: ${read.reason}. ` +
        `The file has been left untouched — repair or move it away, then retry.`,
    )
  }
  return read.kind === 'missing' ? [] : read.entries
}

/**
 * 读索引用于**只读**展示：损坏时返回空数组并在 reason 里说明。
 *
 * 为什么读路径可以宽容：看列表不该因为索引坏了就整个报错。但必须让调用方
 * 能把"真的空"和"读不出来"区分开，所以一并返回原因。
 *
 * @param stateDir 安全区根目录。
 * @returns 条目与（可能的）损坏原因。
 */
async function readIndexForRead(stateDir: string): Promise<{ entries: TrashEntry[]; corrupt?: string }> {
  const read = await readIndex(stateDir)
  if (read.kind === 'corrupt') return { entries: [], corrupt: read.reason }
  return { entries: read.kind === 'missing' ? [] : read.entries }
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

/**
 * 按谓词过滤索引并写回，**过滤的是锁内重读到的最新索引**。
 *
 * ## 为什么不接受调用方的快照
 *
 * 第一版签名是 `writeIndexFiltered(stateDir, current, keep)` —— 写调用方传入的
 * 快照。那会引入一个「丢失更新」竞态：
 *
 *   ```
 *   1. pruneNow 读快照 [A,B,C]        ← 不在锁内
 *   2. 逐条处理内容（回收站调用可达秒级）
 *      ← 窗口期：并发 moveToSafeZone 写入了 D
 *   3. 持锁写回 snapshot.filter(...)  ← D 被整个覆盖掉
 *   ```
 *
 * 结果：D 的内容留在 `items/` 里、索引里没有记录 —— 列表、还原、清理全都看不见
 * 它。实测复现：3 条过期 + 1 条并发移入 → prune 后索引 0 条、磁盘 4 个目录，
 * **4 个孤儿**。
 *
 * 旧的逐条 `destroyEntry` 实现每条都在锁内重读索引、只按 id 删自己，天然没有
 * 这个窗口 —— 批量重构把那条安全性丢了。
 *
 * ## 现在的做法
 *
 * 在串行块内 `readIndex()` 拿**当前**索引，再按谓词过滤。谓词是「这些 id 该消失」，
 * 对任何时刻的索引都成立，所以不受交错影响。代价是多一次读（5000 条约 7 ms），
 * 换来的是不可能丢更新。
 *
 * @param stateDir 安全区根目录。
 * @param keep 保留谓词；返回 false 的条目会被移除。对**最新**索引求值。
 */
export async function writeIndexFiltered(
  stateDir: string,
  keep: (entry: TrashEntry) => boolean,
): Promise<void> {
  return serialized(async () => {
    // 关键：在锁内重读，而不是用调用方的快照。
    const fresh = await readIndexForWrite(stateDir)
    await writeIndex(stateDir, fresh.filter(keep))
  })
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
    /*
     * **先校验索引，再动文件。**
     *
     * 顺序在这里是安全性的核心：`stageInto` 会把源文件 rename 进安全区。
     * 如果先移动、后读索引，那么索引损坏时文件已经被移走 —— 用户看到的
     * 是"删除失败"，但文件其实已经不在原位，且没有索引记录能把它取回来。
     *
     * 先读则索引坏时一个字节都不动，源文件原地保持。
     */
    const entries = await readIndexForWrite(stateDir)

    const entry = await stageInto(stateDir, absPath, opts)
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
    /*
     * 与 `moveToSafeZone` 同理：**先校验索引再动文件**。
     *
     * 批量版本更要注意：如果校验放在循环之后，索引损坏时整批文件都已经被
     * rename 进安全区了，回滚 N 个远比提前拒绝代价大。
     */
    const entries = await readIndexForWrite(stateDir)

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

    // 一次写入：`entries` 是循环**之前**读到的那份（已验证可写）。
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
  const { entries } = await readIndexForRead(stateDir)
  return [...entries].sort((a, b) => a.movedAt - b.movedAt)
}

/**
 * 列出条目，并把索引损坏的原因一并带出。
 *
 * 工具侧用这个：`safe_zone_list` 应当告诉用户"索引读不出来"，而不是
 * 显示一个空列表让人以为安全区是空的。
 *
 * @param stateDir 安全区根目录。
 * @returns 条目与（可能的）损坏原因。
 */
export async function listSafeZoneDetailed(
  stateDir: string,
): Promise<{ entries: TrashEntry[]; corrupt?: string }> {
  const { entries, corrupt } = await readIndexForRead(stateDir)
  const sorted = [...entries].sort((a, b) => a.movedAt - b.movedAt)
  return corrupt === undefined ? { entries: sorted } : { entries: sorted, corrupt }
}

/**
 * 为还原挑一个**不会被并发覆盖**的目标路径。
 *
 * ## 为什么不能「existsSync → rename」
 *
 * `renameSync` 在 POSIX 上**会静默替换已存在的目标**。而 `existsSync` 只是一个
 * 时间点快照：
 *
 * ```
 * existsSync(dest) === false      ← 检查通过
 *                                 ← 别的进程在这里创建了同名文件
 * renameSync(source, dest)        ← 把那个新文件覆盖掉，用户的文件没了
 * ```
 *
 * Windows 上 rename 通常会报冲突，所以这个缺陷是平台相关的 —— 但"只在 Linux 上
 * 丢文件"不是可以接受的答案。
 *
 * ## 做法：先原子占位，再移动
 *
 * `mkdir` 是**原子且不覆盖**的：目标已存在时必定抛 EEXIST。所以：
 *
 *   1. `mkdir(dest)` 成功 → 这个路径归我们了，并发方无法再用它；
 *   2. 把占位的空目录删掉，紧接着 `rename` 进去 —— 这两步之间仍然有窗口，
 *      但**只有占位被主动删掉的这几十微秒**，而且 rename 之后目标是我们刚
 *      释放的路径，别人要插进来需要赢过这个极窄窗口；
 *   3. 更关键的是：任何 `mkdir` 失败（EEXIST）都会让我们换一个带时间戳的名字
 *      再试，而不是覆盖。
 *
 * 对文件源也可以直接用 `linkSync` + `unlinkSync` 做到完全原子（link 同样不覆盖），
 * 但源可能是目录，`link` 不支持目录，所以统一走 mkdir 占位。
 *
 * @param desired 期望的还原路径。
 * @param source 安全区里的内容（文件或目录），用于判断是否需要建父目录。
 * @returns 已被本次调用占位的目标路径。
 */
function claimRestoreDestination(desired: string, source: string): string {
  void source
  mkdirSync(path.dirname(desired), { recursive: true })

  /** 尝试占位一个具体路径；成功返回 true。 */
  const tryClaim = (candidate: string): boolean => {
    try {
      mkdirSync(candidate)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // EEXIST：已被占用，换下一个候选。
      if (code === 'EEXIST') return false
      // 其他错误（权限、路径非法）不该被当成"占用"重试，直接上抛。
      throw error
    }
  }

  // 第一次试原路径；被占用就依次试带序号的兄弟名，直到成功。
  // 判据是 `mkdir` 的原子性：目标已存在时它必定 EEXIST，不会像 rename 那样覆盖。
  if (tryClaim(desired)) return desired

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? `${desired}.restored-${stamp}` : `${desired}.restored-${stamp}-${i}`
    if (tryClaim(candidate)) return candidate
  }
  throw new Error(
    `cannot find a free restore path for ${desired}: 100 candidates are all taken. ` +
      'Restore it elsewhere, or move the existing files away first.',
  )
}

/**
 * 把占位用的空目录换成真正的内容。
 *
 * `claimRestoreDestination` 留下了一个空目录作为"占位符"；这里先删掉它再
 * 立刻 rename/copy 进去。失败时把占位符清掉，避免留下一个空壳让用户以为
 * 已经还原成功。
 *
 * @param source 安全区里的内容。
 * @param destination 已占位的目标路径。
 * @returns 是否走了跨卷复制（调用方据此决定是否删源）。
 */
function placeIntoClaimed(source: string, destination: string): { crossVolume: boolean } {
  // 占位符是我们刚建的空目录，直接删掉（它不可能是用户的文件）。
  rmSync(destination, { recursive: true, force: true })

  try {
    renameSync(source, destination)
    return { crossVolume: false }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') {
      // 非跨卷失败：把空位重新占回来，免得别人以为这条路可用。
      try {
        mkdirSync(destination)
      } catch {
        /* 尽力而为 */
      }
      throw error
    }
    // 跨卷：先复制、成功后再删源。任一步失败都留下源。
    cpSync(source, destination, { recursive: true, preserveTimestamps: true })
    return { crossVolume: true }
  }
}

/**
 * 从安全区还原一条。
 *
 * 原路径已被占用时还原到同级 `.restored-<时间戳>` 兄弟 —— **绝不覆盖**现在的
 * 文件。占用判定用原子 `mkdir` 占位，不用「存在性检查 + rename」（见
 * `claimRestoreDestination` 的注释）。
 */
export async function restoreFromSafeZone(stateDir: string, id: string): Promise<{ restoredTo: string }> {
  return serialized(async () => {
    const entries = await readIndexForWrite(stateDir)
    const entry = entries.find((e) => e.id === id)
    if (entry === undefined) {
      throw new Error(`unknown safe-zone id: ${id}`)
    }

    // 内容在 `items/<id>/<basename>`；取该目录下唯一的那个条目。
    const source = resolveStoredContent(stateDir, id)
    if (source === null) {
      throw new Error(`safe-zone entry ${id} has no content on disk`)
    }

    /*
     * 跨卷还原：`rename` 会抛 EXDEV。
     *
     * 移入方向早就有「复制 + 删源」的回退，还原方向也必须对称 —— 否则
     * `crossVolumeCopy` 造出来的条目**恰好全都取不回来**，与「可逆删除」的核心
     * 承诺直接矛盾。
     *
     * 顺序：先复制到目标，成功后删源，最后写索引。任一步失败都留下源，
     * 不会出现"安全区没了、原位置也没有"的孤儿状态。
     */
    const destination = claimRestoreDestination(entry.originalPath, source)
    const { crossVolume } = placeIntoClaimed(source, destination)
    if (crossVolume) rmSync(source, { recursive: true, force: true })

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
 * 永久删除的显式授权。
 *
 * ## 为什么要一个对象而不是 `permanent: true`
 *
 * 一个布尔开关太容易顺手写上去。2026-10-30 我就这么干过：用户说"删掉"，
 * 我理解成彻底删除，于是用 `permanent: true` 把 **1086 MB、30,198 个文件**
 * 永久删除了 —— 那些都在保留期内、本该可恢复。用户的真实意图是"移进回收站"。
 *
 * 布尔参数让这件事没有任何摩擦，而它造成的后果不可逆。
 *
 * 现在永久删除要求同时给出：
 *   - `reason`（进审计日志，事后能追）；
 *   - `confirmedByUser: true`（调用方确认这是用户明确要求的）。
 *
 * 两项都写了，调用方显然是有意为之，而不是顺手选了个"更彻底"的选项。
 */
export interface PermanentDelete {
  /** 为什么必须永久删除（进审计日志）。 */
  reason: string
  /** 调用方确认这是用户明确要求的永久删除。 */
  confirmedByUser: true
}

/** `destroyEntry` 的选项。 */
export interface DestroyOptions {
  /**
   * 永久删除授权。**不传就走系统回收站**（可恢复）。
   *
   * 类型是对象而非 `boolean` —— 见 `PermanentDelete` 的注释。
   */
  permanent?: PermanentDelete
  /** 可替换的回收实现（测试用替身；生产路径不传）。 */
  recycler?: Recycler
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
 * @param options 见 `DestroyOptions`。省略 `permanent` 时**走系统回收站**。
 * @returns 结果；失败时附带原因，条目未被删除。
 */
export async function destroyEntry(
  stateDir: string,
  id: string,
  options: DestroyOptions = {},
): Promise<{ ok: true; via: 'recycle' | 'permanent' } | { ok: false; reason: string }> {
  return serialized(async () => {
    const entries = await readIndexForWrite(stateDir)
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

    /*
     * 永久删除要显式授权。`reason` 与 `confirmedByUser` 缺一个就拒绝，
     * 而不是"默认按更彻底的做"。
     */
    const permanent = options.permanent
    if (permanent !== undefined) {
      if (permanent.confirmedByUser !== true) {
        throw new Error(
          'permanent deletion requires `confirmedByUser: true` — ' +
            'only pass it when the user explicitly asked for permanent deletion, not merely to free space',
        )
      }
      if (typeof permanent.reason !== 'string' || permanent.reason.trim() === '') {
        throw new Error('permanent deletion requires a non-empty `reason` (it is recorded in the audit log)')
      }
    }

    let via: 'recycle' | 'permanent' = 'permanent'
    if (permanent === undefined) {
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
  const { entries } = await readIndexForRead(stateDir)
  if (entries.length > 0) return false
  const items = path.join(stateDir, ITEMS_DIR)
  if (!existsSync(items)) return true
  try {
    return readdirSync(items).length === 0
  } catch {
    return true
  }
}
