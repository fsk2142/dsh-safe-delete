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

import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { describeTarget } from './describe'
import { withIndexLock } from './index-lock'
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
 * 索引写操作的串行队列（进程内）+ 跨进程文件锁。
 *
 * ## 为什么需要
 *
 * `moveToSafeZone` / `destroyEntry` / `restoreFromSafeZone` 都是
 * 「读索引 → 改 → 写回」。DSH 的并发工具调用可达 50，两个并发的删除会读到同一份
 * 旧数组，后写者把它整个覆盖回去 —— 前一条从索引里消失，但内容还留在
 * `items/<id>/` 盘上。后果是**列表看不见、清理永远轮不到**（prune 只扫索引），
 * 属于静默的磁盘泄漏。
 *
 * ## 为什么光有 Promise 链不够（2026-10-30 复审 P1-03）
 *
 * 这条 Promise 链只能串行化**同一进程内**的操作。清理现在跑在独立子进程里，
 * 于是出现真正的跨进程交错：
 *
 * ```
 * 主进程  ── 读索引 [] ──┐
 * worker  ── 读索引 [] ──┤  两者都读到空
 * 主进程  ── 写 [A] ─────┤
 * worker  ── 写 [B] ─────┘  主进程的 A 被覆盖，从索引消失
 * ```
 *
 * ## 两级保护，但**不能嵌套**
 *
 * - **进程内**：Promise 链，零系统调用，覆盖 DSH 的 50 路并发；
 * - **跨进程**：`index.lock` 文件锁（见 `index-lock.ts`），覆盖 worker 与主进程。
 *
 * 关键是这两级**不能嵌套**。第一版把 `withIndexLock` 写在了 `serialized` 的
 * 占位里、让队列回调自己去抢锁，于是链条上第二个操作开始执行时、第一个
 * 还持有文件锁 —— 它等自己，永远等不到。实测「并发 5 次 moveToSafeZone」
 * 全部超时失败。
 *
 * 现在的顺序是：**先在本地队列排队，轮到自己时才抢文件锁**。这样任何一刻
 * 只有一个本进程的请求在等锁，不会自等。
 */
let indexQueue: Promise<unknown> = Promise.resolve()

/**
 * 把一次索引操作排进队列，再在跨进程锁内执行。
 *
 * ## 顺序为什么是"先排队、后抢锁"
 *
 * 同一进程的并发请求先在 `indexQueue` 上排队，**轮到它时**才去抢文件锁。
 * 这样任何一刻只有一个本进程的请求在等锁，不会出现"链上一个持有锁、
 * 链上另一个已经进了锁函数在等"的自等 —— 第一版正是那样写的，
 * 实测「并发 5 次 moveToSafeZone」全部超时失败。
 *
 * @param stateDir 安全区根目录。
 * @param job 要串行执行的操作。
 * @returns 该操作的结果。
 */
function serialized<T>(stateDir: string, job: () => Promise<T>): Promise<T> {
  // 无论前一个成功还是失败都继续排队（用 catch 抹掉拒绝，避免链条断掉）。
  const run = indexQueue.then(
    () => withIndexLock(stateDir, job),
    () => withIndexLock(stateDir, job),
  )
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
    /*
     * ## 严格校验每一条（2026-10-30 复审 SD-06）
     *
     * 第一版只查 `id` 与 `originalPath`，于是三种坏数据都被"当作有效"：
     *
     * | 输入 | 后果 |
     * |---|---|
     * | `[null]` | **崩溃** —— `item as Partial<TrashEntry>` 后读 `.id` 抛 TypeError |
     * | 非法时间戳 | 后续 `new Date(x).toISOString()` 抛 RangeError |
     * | `id: "../../etc"` | 被当真 —— 而 id 会拼进文件路径 |
     *
     * 索引是**磁盘上的数据**，可能被手动编辑、被崩溃写坏、被旧版本写坏。
     * 它不该让插件崩溃，也不该让一个带路径分隔符的 id 去构造出安全区之外的
     * 路径。这里逐条验证，任何一条不合格就整体报 corrupt（**保留原文件**）。
     */
    const e = item as Partial<TrashEntry> | null | undefined
    if (e === null || e === undefined || typeof e !== 'object' || Array.isArray(e)) {
      return {
        kind: 'corrupt',
        reason: `index entry is not an object: ${JSON.stringify(item)?.slice(0, 120) ?? String(item)}`,
      }
    }
    if (typeof e.id !== 'string' || e.id === '' || typeof e.originalPath !== 'string') {
      return { kind: 'corrupt', reason: `index entry missing id/originalPath: ${JSON.stringify(item).slice(0, 120)}` }
    }
    /*
     * id 会拼进 `items/<id>`，绝不能含路径分隔符或遍历片段。
     *
     * 这不是理论风险：`destroyEntry` / `restoreFromSafeZone` 都从索引取 id
     * 再拼路径，校验过的 id 才让 `isUnder` 那道双保险有意义。
     */
    if (e.id.includes('/') || e.id.includes('\\') || e.id.includes('..') || e.id.includes('\0')) {
      return { kind: 'corrupt', reason: `index entry has an illegal id: ${JSON.stringify(e.id)}` }
    }
    if (seen.has(e.id)) {
      return { kind: 'corrupt', reason: `duplicate id in index: ${e.id}` }
    }
    // 时间戳必须是有限数 —— 否则后面算过期时间会得到 NaN，永不清理。
    if (!Number.isFinite(e.movedAt) || !Number.isFinite(e.expiresAt)) {
      return {
        kind: 'corrupt',
        reason: `index entry has a non-finite timestamp: ${JSON.stringify({ id: e.id, movedAt: e.movedAt, expiresAt: e.expiresAt })}`,
      }
    }
    // 字节数与文件数必须是非负有限数（旧版本可能写缺这些字段）。
    if (!Number.isFinite(e.bytes) || (e.bytes as number) < 0) {
      return { kind: 'corrupt', reason: `index entry has an invalid bytes value: ${JSON.stringify(e.bytes)}` }
    }
    if (!Number.isFinite(e.fileCount) || (e.fileCount as number) < 0) {
      return { kind: 'corrupt', reason: `index entry has an invalid fileCount value: ${JSON.stringify(e.fileCount)}` }
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
  return serialized(stateDir, async () => {
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
    /*
     * 顺序很重要：先复制、再登记索引、**最后**才删源。
     * 如果在删源之前就登记失败，源还在，用户什么都没丢；反过来则会留下
     * "磁盘上没有、索引里也没有"的孤儿数据。
     *
     * ## 复制中途失败必须回滚（2026-10-30 复审 SD-05.1）
     *
     * `cpSync` 可能在复制了一部分之后抛错（`ENOSPC`、`EACCES`、源文件被占用）。
     * 第一版直接上抛，于是 `items/<id>` 里留下一个**半副本**，而索引从未登记它。
     *
     * 这种目录是最糟的泄漏形态：
     *   - `prune` 只扫索引 → 永远轮不到它；
     *   - `safe_zone_list` 看不到它 → 用户不知道它占着空间；
     *   - 只有手工翻 `items/` 才会发现。
     *
     * 现在失败即回滚：删掉刚建的 `items/<id>`。源文件从未被改动（删源在后），
     * 所以用户数据零风险；回滚本身失败也不吞掉原始错误。
     */
    try {
      cpSync(target, dest, { recursive: true, preserveTimestamps: true })
    } catch (error) {
      try {
        rmSync(entryRoot, { recursive: true, force: true })
      } catch {
        /* 回滚失败时保留原位：宁可留孤儿，也不能掩盖真正的复制错误 */
      }
      throw error
    }
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
  return serialized(stateDir, async () => {
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
  return serialized(stateDir, async () => {
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
 * 列出条目，**但不排序**。
 *
 * ## 什么时候用
 *
 * 调用方只需要计数、求和、或扫描求最值时 —— 排序是白花的钱。
 *
 * 2026-10-30 复审 P2-05 实测（3 万条索引）：解析 575 ms、排序 324 ms。
 * 解析不可避免（索引是 JSON 数组），排序可以省。
 *
 * **不要把它用在需要"最早一条在最前"的地方** —— 那正是排序的意义，
 * 传给 `safe_zone_list` 会让输出顺序变得不可预测。
 *
 * @param stateDir 安全区根目录。
 * @returns 条目（索引原序）与（可能的）损坏原因。
 */
export async function listSafeZoneUnordered(
  stateDir: string,
): Promise<{ entries: TrashEntry[]; corrupt?: string }> {
  const { entries, corrupt } = await readIndexForRead(stateDir)
  return corrupt === undefined ? { entries } : { entries, corrupt }
}

/**
 * 生成候选还原路径。
 *
 * 第 0 个是用户期望的原路径，之后依次是 `.restored-<时间戳>` 兄弟名。
 *
 * @param desired 期望路径。
 * @param i 序号。
 * @param stamp 时间戳（同一轮尝试内固定）。
 * @returns 候选路径。
 */
function restoreCandidate(desired: string, i: number, stamp: string): string {
  if (i === 0) return desired
  const suffix = i === 1 ? '' : `-${i - 1}`
  return `${desired}.restored-${stamp}${suffix}`
}

/**
 * 把一个**文件**落到候选路径，绝不覆盖已存在的内容。
 *
 * ## 为什么 `link` + `unlink` 而不是 `rename`
 *
 * `rename` 在 POSIX 上会覆盖已存在的目标、Windows 上会失败 —— 行为不一致，
 * 而 POSIX 上"覆盖"意味着用户刚落下的文件被我们删了。
 *
 * `linkSync` 在两个平台上都以 `EEXIST` 拒绝已存在的目标（实测）：
 *
 * ```
 * linkSync(src, 已存在的 dst) → EEXIST，dst 内容不变
 * linkSync(src, 不存在的 dst) → 成功，两者指向同一 inode
 * ```
 *
 * 成功后 `unlinkSync` 源即可 —— 中间**不存在目标缺失的瞬间**。
 *
 * @param source 源文件（staging）。
 * @param target 目标路径。
 * @returns 成功 true；目标已存在 false；其他错误抛出（交给复制回退）。
 */
function linkFileNoReplace(source: string, target: string): boolean {
  try {
    linkSync(source, target)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    // EXDEV / EPERM / ENOTSUP：不支持硬链接，交给调用方的回退。
    throw error
  }
}

/**
 * 把内容放到一个**保证不覆盖**的目标路径。
 *
 * ## 为什么彻底放弃"占位目录"（2026-10-30 复审 SD-01）
 *
 * 之前的三段式是：
 *
 * ```
 * mkdirSync(destination)                  ← 占位
 * renameSync(source, destination/payload) ← 内容进占位内部
 * rmSync(destination, {recursive:true})   ← **递归删掉占位**
 * renameSync(temp, destination)           ← 换出
 * ```
 *
 * 第三行有两个独立缺陷，都用隔离实验复现过：
 *
 * 1. **它删掉别人写进占位目录的东西**。目录一旦出现在用户眼前，用户就可能
 *    往里拖文件；`rmSync(recursive)` 会一并删除。
 * 2. **删完到换出之间目标路径是空的**。竞态方恰好在这时创建同名项，
 *    就会被最后一次 rename 覆盖（POSIX）或让恢复失败（Windows）。
 *
 * 失败路径更糟：内容已离开 `items/<id>`、停在 `.dsh-tmp-*`，而恢复扫描
 * 只查 `items/<id>` —— 唯一副本找不回来。
 *
 * ## 现在的做法：平台原语做原子 no-replace
 *
 * - **文件**：`linkSync`（EEXIST 即冲突）+ `unlinkSync` 源；
 * - **目录**：`mkdirSync` 抢位 → `rmdirSync` 收掉**空**目录 → `renameSync`。
 *   `rmdir` 只能删空目录，若占位期间有人写入它会失败，我们就换候选名 ——
 *   绝不递归删别人的内容。
 *
 * 内容先落到目标**同级**的唯一 staging 名，它不占用任何候选路径，所以每次
 * 尝试都是干净的。任何一步失败都不删内容：它要么还在 staging（错误信息给出
 * 确切位置），要么已经在候选路径上。
 *
 * @param stateDir 安全区目录（用于在内容缺失时诊断它是否在批次里）。
 * @param id 条目 id（用于 staging 命名）。
 * @param source 内容路径。
 * @param desired 期望还原到的路径。
 * @param onClaimed 测试钩子：在"已用 mkdir 抢到候选路径、尚未收掉它"的
 *   **窗口内**调用。生产代码不传。存在的理由见下方目录落位处的注释 ——
 *   那是唯一无法用外部时序复现的窗口，没有钩子就只能靠人工审阅来保证。
 * @returns 实际使用的路径。
 */
function placeNoReplace(
  stateDir: string,
  id: string,
  source: string,
  desired: string,
  onClaimed?: (candidate: string) => void,
): string {
  mkdirSync(path.dirname(desired), { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  let isDir: boolean
  try {
    isDir = statSync(source).isDirectory()
  } catch {
    /*
     * 内容可能刚被清理 worker 搬进批次目录 —— 用能说清楚的诊断，
     * 而不是让用户以为数据丢了（SD-05.2）。
     */
    throw contentMissingError(stateDir, id)
  }

  /*
   * 内容先进目标同级的唯一 staging 名。
   *
   * 这样它不占用任何候选路径，后续每次尝试都是干净的 no-replace。
   * 它同时是失败时的落点 —— 内容在这里仍然完整。
   */
  const staging = path.join(
    path.dirname(desired),
    `.dsh-restore-${id}-${process.pid}-${Date.now().toString(36)}`,
  )

  try {
    renameSync(source, staging)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw error
    // 跨卷：复制到 staging，成功后删源；复制失败则源原样保留。
    cpSync(source, staging, { recursive: true, preserveTimestamps: true })
    rmSync(source, { recursive: true, force: true })
  }

  /** 尝试把 staging 落到候选路径；返回是否成功。 */
  const placeAt = (candidate: string): boolean => {
    if (!isDir) {
      try {
        if (linkFileNoReplace(staging, candidate)) {
          // 链接成功：目标已指向同一 inode，删掉 staging 这个名字即可。
          rmSync(staging, { force: true })
          return true
        }
        return false
      } catch {
        /*
         * 硬链接不可用（跨卷、文件系统限制）。回退到"存在性检查 + rename"，
         * 但把它当成**最后手段**：检查与 rename 之间仍有极小窗口，所以只在
         * 平台确实不支持 link 时才会走到这里。
         */
        if (existsSync(candidate)) return false
        try {
          renameSync(staging, candidate)
          return true
        } catch {
          return false
        }
      }
    }

    /*
     * ## 目录路径**仍有窗口** —— 必须诚实标注
     *
     * 文件能用 `linkSync` 做到真正原子（EEXIST 即冲突，无窗口）。
     * **目录做不到**：Node 没有跨平台的 no-replace 目录改名原语
     * （POSIX 的 `renameat2(RENAME_NOREPLACE)`、Windows 的
     * `MoveFileEx` 不含 `MOVEFILE_REPLACE_EXISTING`，都需要原生模块，
     * 而本插件零运行时依赖）。
     *
     * 所以目录走 mkdir → rmdir → rename，仍有一个极短窗口：
     *
     * ```
     * mkdirSync(candidate)    ← 抢位
     * rmdirSync(candidate)    ← 空出来（窗口）
     * renameSync(staging, candidate)
     * ```
     *
     * ## 与旧实现（SD-01）的关键区别
     *
     * 1. `rmdir` 只能删空目录。若竞态方在窗口里往我们这个空目录写了文件，
     *    `rmdir` 会 `ENOTEMPTY` 失败 —— 我们换候选名，**绝不删对方的内容**。
     *    旧实现用 `rmSync(recursive)`，会连同那些文件一起删掉。
     * 2. 内容始终在 `staging`（目标同级的唯一名），失败不丢、位置写进错误。
     *
     * ## 剩余风险（未消除，必须说明）
     *
     * 窗口里若恰好有人创建了同名**目录**：Windows 上 `renameSync` 失败
     * （保守 —— 内容留在 staging，报错给出位置）；POSIX 上会覆盖那个目录。
     * 后者只可能覆盖一个**空**目录（非空会 ENOTEMPTY），空目录没有数据可丢。
     */
    try {
      mkdirSync(candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return false
      throw error
    }
    /*
     * 窗口在这里。生产路径 `onClaimed` 是 undefined，什么都不做；
     * 测试用它模拟"别人在这个瞬间往我们的空目录里写了文件"。
     */
    onClaimed?.(candidate)
    try {
      rmdirSync(candidate)
    } catch {
      // 有人在我们的占位目录里放了东西 —— 不能动它，换下一个候选。
      return false
    }
    try {
      renameSync(staging, candidate)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY') return false
      throw error
    }
  }

  for (let i = 0; i < 100; i += 1) {
    if (placeAt(restoreCandidate(desired, i, stamp))) {
      return i === 0 ? desired : restoreCandidate(desired, i, stamp)
    }
  }

  /*
   * 100 个候选全被占用。**内容仍在 staging** —— 必须把位置告诉调用方，
   * 否则用户会以为数据丢了。
   */
  throw new Error(
    `cannot find a free restore path for ${desired}: 100 candidates are all taken. ` +
      `The content is intact at ${staging} — move the existing files away and restore again, ` +
      'or copy that path back manually.',
  )
}

/**
 * 当 `items/<id>` 里找不到内容时，查它是不是正被清理搬到别处去了。
 *
 * ## 为什么需要（2026-10-30 复审 SD-05.2）
 *
 * worker 把条目从 `items/<id>` 搬进 `batches/<batchId>/items/<id>` 的那一步
 * **不持索引锁**（只有写索引时才拿锁）。而 restore 在锁内也可能跑到这里。
 *
 * 于是有一个真实的交错：
 *
 * ```
 * restore  读索引 → 找到条目 → 去找 items/<id>   ← 文件刚被搬走
 * worker   把 items/<id> 搬进 batches/...          ← 就在这一刻
 * restore  报 "no content on disk"                 ← 用户以为数据丢了
 * ```
 *
 * 内容其实完好地躺在批次目录里。报"磁盘上没有内容"是**误导**：用户会以为
 * 丢了，于是去做更糟的事（清空回收站、重装）。
 *
 * 这里查一遍批次目录，命中就把确切位置和原因告诉调用方。
 *
 * @param stateDir 安全区目录。
 * @param id 条目 id。
 * @returns 内容所在位置与说明；找不到时 null。
 */
function locateInBatches(stateDir: string, id: string): { path: string; batchId: string } | null {
  const root = path.join(stateDir, 'batches')
  let batchIds: string[]
  try {
    batchIds = readdirSync(root)
  } catch {
    return null
  }
  for (const batchId of batchIds) {
    const candidate = path.join(root, batchId, 'items', id)
    if (existsSync(candidate)) return { path: candidate, batchId }
  }
  return null
}

/**
 * 生成"找不到内容"的错误 —— 如果内容正躺在批次目录里，说清楚。
 *
 * @param stateDir 安全区目录。
 * @param id 条目 id。
 * @returns 错误对象。
 */
function contentMissingError(stateDir: string, id: string): Error {
  const inBatch = locateInBatches(stateDir, id)
  if (inBatch !== null) {
    return new Error(
      `safe-zone entry ${id} is being cleaned up right now: its content has already been moved ` +
        `into batch ${inBatch.batchId} (${inBatch.path}). ` +
        'The cleanup runs in a separate process, so this can happen while you restore. ' +
        'Nothing is lost — wait for the cleanup to finish, or if it already returned to the ' +
        'safe zone, restore again. Do NOT delete the batches directory.',
    )
  }
  return new Error(
    `safe-zone entry ${id} has no content on disk. ` +
      'It may have been emptied by hand; check items/ and batches/ before assuming the data is gone.',
  )
}

/**
 * 从安全区还原一条。
 *
 * 原路径已被占用时还原到同级 `.restored-<时间戳>` 兄弟 —— **绝不覆盖**现有的
 * 文件。冲突判定用平台原语（文件 `linkSync` 的 EEXIST、目录 `mkdirSync` 的
 * EEXIST），不用「存在性检查 + rename」—— 见 `placeNoReplace` 的注释。
 */
export async function restoreFromSafeZone(
  stateDir: string,
  id: string,
  /**
   * 测试钩子，生产不传。
   *
   * 在"目录落位时已用 mkdir 抢到候选路径、还没收掉"的窗口内被调用 ——
   * 那是唯一无法从外部用真实时序复现的窗口（两次系统调用之间）。
   * 没有它，SD-01 里 `rmdir` 与 `rmSync(recursive)` 的区别就只能靠人工审阅。
   */
  onClaimed?: (candidate: string) => void,
): Promise<{ restoredTo: string }> {
  return serialized(stateDir, async () => {
    const entries = await readIndexForWrite(stateDir)
    const entry = entries.find((e) => e.id === id)
    if (entry === undefined) {
      throw new Error(`unknown safe-zone id: ${id}`)
    }

    // 内容在 `items/<id>/<basename>`；取该目录下唯一的那个条目。
    const source = resolveStoredContent(stateDir, id)
    if (source === null) {
      // 同 `placeNoReplace`：内容可能正在批次目录里等着被回收。
      throw contentMissingError(stateDir, id)
    }

    /*
     * 一次调用完成搬迁：内容先到 staging，再以 no-replace 原语落到候选路径。
     *
     * 跨卷（EXDEV）由 `placeNoReplace` 内部处理成"复制到 staging 再删源"，
     * 所以这里不再需要分两步判断。任何失败都会抛错并把内容位置写进消息，
     * 索引保持不动 —— 用户可以重试或手工取回。
     */
    const destination = placeNoReplace(stateDir, id, source, entry.originalPath, onClaimed)

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
  return serialized(stateDir, async () => {
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
