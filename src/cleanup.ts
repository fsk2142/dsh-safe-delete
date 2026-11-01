/**
 * 清理任务的调度：**搭车触发，不搭车执行**。
 *
 * ## 这个模块解决的事故
 *
 * 2026-10-30 的事故：`pruneIfDue` 挂在 6 个工具的 `beforeExecute` 上，节流只有
 * 1 秒，而一次完整清理要为 28,724 条逐条调系统回收站（1049 ms/次），合计约
 * 8.4 小时。于是每次工具调用都重新进入这条路径，同步阻塞事件循环，宿主连
 * 会话历史都加载不出来。
 *
 * ## 现在的规则
 *
 * 1. **主进程只写一个请求文件**（几毫秒），然后立即返回；
 * 2. 真正的清理交给独立的**操作系统子进程**（`spawn`，不是 `execFileSync`）；
 * 3. 子进程独占一个锁文件，保证同时只有一个；
 * 4. 子进程的进度写在 `cleanup-job.json` 里，`safe_zone_status` 可以读；
 * 5. 子进程崩溃后，残留的锁会被下次调度按"过期"接管 —— 但接管前会核对
 *    PID 是否还活着，避免误杀正在跑的清理。
 *
 * ## 为什么不用 `setImmediate` / `void prune()`
 *
 * 那些仍在**同一个事件循环**里执行同步 fs 和 `execFileSync`。看起来是"后台"，
 * 实际照样卡住宿主。必须换进程。
 *
 * @module dsh-safe-delete/cleanup
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 清理任务的状态快照（写在 `<stateDir>/cleanup-job.json`）。 */
export interface CleanupJobState {
  /** 请求 id（便于日志关联）。 */
  requestId: string
  /** 子进程 pid；未运行时为 null。 */
  pid: number | null
  /** 什么时候请求的。 */
  requestedAt: number
  /** 什么时候真正开始的；未开始为 null。 */
  startedAt: number | null
  /** 什么时候结束的；未结束为 null。 */
  finishedAt: number | null
  /** 本轮的结局。 */
  outcome: 'pending' | 'running' | 'completed' | 'failed' | 'unknown'
  /** 本轮实际送入回收站的条数。 */
  recycled: number
  /** 本轮跳过（回收失败）的条数。 */
  skipped: number
  /** 最近一次错误信息。 */
  lastError?: string
}

/** 请求文件名。 */
const JOB_FILE = 'cleanup-job.json'
/** 锁文件名。 */
const LOCK_FILE = 'cleanup.lock'
/** 子进程入口（相对本模块编译后的位置解析）。 */
const WORKER_ENTRY = 'cleanup-worker.js'

/**
 * 读当前清理任务状态。
 *
 * @param stateDir 安全区目录。
 * @returns 状态；从未请求过时为 null。
 */
export function readCleanupJob(stateDir: string): CleanupJobState | null {
  const file = join(stateDir, JOB_FILE)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CleanupJobState
  } catch {
    return null
  }
}

/**
 * 原子写任务状态。
 *
 * @param stateDir 安全区目录。
 * @param state 要写的状态。
 */
function writeCleanupJob(stateDir: string, state: CleanupJobState): void {
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, JOB_FILE)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 进程是否还活着。
 *
 * 用于判断锁的持有者是否真的在跑 —— 仅凭 `mtime` 过期就接管会误杀长任务。
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
 * 尝试获取清理锁。
 *
 * ## 为什么锁里要写 pid
 *
 * 只按文件存在与否判断，会在子进程崩溃后永久卡住；只按 `mtime` 过期判断，
 * 又会误杀一个正在慢慢跑的长任务。两者结合：过期 **且** pid 已死才接管。
 *
 * ## 为什么要 owner token
 *
 * 第一版用 `pid` 判断所有权，结果**锁永远释放不掉**：锁由主进程创建
 * （`pid = 主进程`），而释放发生在 worker 里（`pid = worker`），两个 pid
 * 永不相等，`releaseLock` 的所有权检查必然失败。表现是"第一次清理之后，
 * 后续每次清理都被 `another cleanup holds the lock` 挡住"。
 *
 * 现在锁里带一个随机 `token`：谁创建锁谁拿到 token，创建者把它传给 worker；
 * 释放时比对 token，而不是比对 pid。
 *
 * ## pid 必须是 **worker 的**，不是主进程的（2026-10-30 复审 SD-02）
 *
 * 第一版把 `pid: process.pid` 写进锁 —— 那是**主进程**的 pid。清理实际由
 * spawn 出来的子进程执行，于是 worker 崩溃时出现了最糟的组合：
 *
 * ```
 * worker 崩溃          ← 锁没释放
 * 主进程还活着          ← holderAlive 永远为真
 * → 即使锁过期 10 小时，接管判据 age > stale && !alive 也永不成立
 * ```
 *
 * 结果是"清理永久停摆，直到重启 DSH"。隔离复现证实：写一个
 * `{pid: 活着的调度方, at: 11 分钟前}` 的锁，`eligibleForTakeover` 为 false。
 *
 * 现在分两个阶段写锁：
 *
 * 1. 主进程派发时写 `{ pid: 主进程, token, requestId }` —— 这一小段窗口里
 *    还没有 worker，用主进程 pid 是对的（主进程若死，锁自可接管）；
 * 2. **worker 启动后立刻把 `workerPid` 写进锁**，此后存活判定以它为准。
 *
 * 判据因此变成：`workerPid` 存在 → 看它是否活着；否则看 `pid`。
 *
 * @param stateDir 安全区目录。
 * @param staleMs 多久算过期。
 * @param token 本次要写入锁的 owner token。
 * @param onStale 检测到"过期但持有者已死"时收到原因说明（本轮**不接管**）。
 * @returns 拿到锁返回 true。
 */
function tryAcquireLock(
  stateDir: string,
  staleMs: number,
  token: string,
  onStale?: (reason: string) => void,
): boolean {
  const lockPath = join(stateDir, LOCK_FILE)
  /*
   * 检测到"陈旧但无法安全接管"时把原因交出去。
   *
   * 为什么用回调而不是返回值对象：调用点（`requestCleanup`）把它转成
   * `scheduled.reason`，用户能看到"为什么没开始清理、怎么恢复"。
   */
  let staleLockReason: string | undefined
  try {
    // `wx` 是原子的：文件已存在就失败。
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: 'wx' })
    return true
  } catch {
    // 已存在 —— 判断能否接管。
    try {
      const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        pid?: number
        workerPid?: number | null
        at?: number
        token?: string
      }
      const age = Date.now() - (holder.at ?? 0)
      /*
       * 存活判定优先看 workerPid。
       *
       * 这是 SD-02 的修复点：清理跑在子进程里，主进程活着不代表清理还在跑。
       */
      const livenessPid =
        typeof holder.workerPid === 'number' ? holder.workerPid : holder.pid
      const holderAlive = typeof livenessPid === 'number' && isAlive(livenessPid)
      if (age > staleMs && !holderAlive) {
        /*
         * ## 不再自动接管陈旧锁（2026-11-01 定版复核第 5 项）
         *
         * ## 为什么停止
         *
         * 前两版的接管协议是 `renameSync(lock, tombstone)` + 事后比对 token。
         * 两轮审查各找出一个反例，而第三个反例证明**这套协议本身无法证明
         * 互斥**。定版复核实测的完整交错：
         *
         * ```
         * B: 读到陈旧锁，判定可接管
         * A: 接管成功，建了活锁，开始工作
         * B: rename(lockPath, tombstoneB)  ← 搬走的是 A 的活锁
         * B: 读 token，发现不符 → 退出
         *    但锁路径已经空了 ← 这是关键
         * C: write(wx) 成功 → C 也进入工作体
         * → A 从未被停止，A/C 同时运行
         * ```
         *
         * 复核用真实 `withIndexLock` 两个工作体验证：`overlap=true`，
         * 两者读同一初值后分别写入，最终只剩 A，**C 的更新丢失**。
         *
         * 事后比对 token 只能让 B 退出，不能让 A 恢复对锁的所有权。
         *
         * ## 现在的行为
         *
         * 检测到"过期 + 持有者已死"时，**不接管**，返回失败并给出可操作的
         * 说明。代价是清理可能停摆到人工介入；收益是不会有两个工作体同时
         * 改索引。**宁可停下，也不能丢数据。**
         *
         * 恢复办法见 `staleLockMessage()`。
         */
        staleLockReason =
          `the cleanup lock is held by a process that is no longer running ` +
          `(pid ${String(livenessPid)}, ${Math.round(age / 1000)}s old). ` +
          'Automatic takeover is disabled because it cannot be proven safe: ' +
          'a taker can move a live lock away, leaving the path empty for a third process. ' +
          `To clear it, delete ${lockPath} and retry.`
        return false
      }
    } catch {
      /* 锁文件损坏，当作被占用 */
    }
    return false
  } finally {
    /*
     * 把"陈旧但未接管"的原因交给调用方。
     *
     * 只在真的检测到这种情况时回调，正常竞争（活锁）不触发。
     */
    if (staleLockReason !== undefined) onStale?.(staleLockReason)
  }
}

/**
 * 把 **worker 自己的 pid** 绑定到锁上。
 *
 * ## 为什么必须绑定（2026-10-30 复审 SD-02）
 *
 * 锁由主进程创建，于是最初写进去的是主进程 pid。清理实际在子进程里跑，
 * 一旦子进程崩溃而主进程还活着，存活判定 `isAlive(holder.pid)` 永远为真 ——
 * 锁永不过期、永不接管，清理永久停摆到重启。
 *
 * worker 启动后第一件事就是调用这个函数，把 `workerPid` 写进锁。
 * 此后存活判定以它为准（见 `tryAcquireLock`）。
 *
 * ## 为什么按 token 校验
 *
 * 只有锁的持有者才该改它。若 token 不匹配（说明锁已被别人接管），
 * 这里安静地什么都不做 —— 让那个接管者继续。
 *
 * @param stateDir 安全区目录。
 * @param token 派发方交给本 worker 的 owner token。
 * @returns 是否成功绑定。
 */
function bindWorkerPid(stateDir: string, token: string): boolean {
  const lockPath = join(stateDir, LOCK_FILE)
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      token?: string
      pid?: number
      at?: number
    }
    if (holder.token !== token) return false
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: holder.pid ?? process.pid,
        workerPid: process.pid,
        at: holder.at ?? Date.now(),
        token,
      }),
    )
    return true
  } catch {
    return false
  }
}

/** 供诊断：锁当前由谁持有、判定用的是哪个 pid。 */
export function cleanupLockHolder(
  stateDir: string,
): { pid: number; workerPid: number | null; ageMs: number; alive: boolean } | null {
  const lockPath = join(stateDir, LOCK_FILE)
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      pid?: number
      workerPid?: number | null
      at?: number
    }
    if (typeof holder.pid !== 'number' || typeof holder.at !== 'number') return null
    const workerPid = typeof holder.workerPid === 'number' ? holder.workerPid : null
    return {
      pid: holder.pid,
      workerPid,
      ageMs: Date.now() - holder.at,
      alive: isAlive(workerPid ?? holder.pid),
    }
  } catch {
    return null
  }
}

/**
 * 释放清理锁（**只释放自己持有的那把**）。
 *
 * 所有权按 `token` 判断而不是 `pid` —— 锁由主进程创建、由 worker 释放，
 * 两者的 pid 本来就不同。详见 `tryAcquireLock` 的注释。
 *
 * @param stateDir 安全区目录。
 * @param token 创建锁时用的 owner token。
 * @returns 是否真的删掉了锁。
 */
function releaseLock(stateDir: string, token: string): boolean {
  const lockPath = join(stateDir, LOCK_FILE)
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: string }
    if (holder.token !== token) return false
  } catch {
    return false
  }
  try {
    rmSync(lockPath, { force: true })
    return true
  } catch {
    return false
  }
}

/** 请求清理的选项。 */
export interface RequestCleanupOptions {
  /** 安全区目录。 */
  stateDir: string
  /** 本次最多处理多少条。 */
  limit?: number
  /** 多久没清理过才真的启动（毫秒）；0 表示总是启动。 */
  minIntervalMs?: number
  /**
   * 选中哪些条目。**必须显式给出**（2026-10-30 复审 SD-03）。
   *
   * - `expired`：只选超过保留期的（自动清理）；
   * - `all`：不论是否过期都选（用户明确的"清空安全区"）。
   *
   * ## 为什么不能用"传个很大的 limit"代替
   *
   * 第一版正是如此：`/safe-delete clean` 与面板按钮把 `selected.length`
   * 当 limit 传下去，而 worker 永远只 `selectForPrune`（仅过期）。
   *
   * 结果是**功能语义错误**：用户 5 分钟前删的文件（保留期 1 天），
   * 点"清空安全区"时命令报告"已请求清理 1 条"，worker 却找不到过期项、
   * 返回 `recycled=0`，那条纹丝不动 —— 而命令看起来成功了。
   *
   * "处理多少条"和"选哪些"是两件事，一个数字表达不了。
   */
  mode: 'expired' | 'all'
}

/**
 * 请求一次后台清理 —— **立即返回，不等结果**。
 *
 * @param opts 选项。
 * @returns 是否真的派生了子进程；已有一个在跑、或未到间隔时返回 false。
 */
export async function requestCleanup(opts: RequestCleanupOptions): Promise<{ started: boolean; reason?: string }> {
  const { stateDir, limit = 500, minIntervalMs = 0, mode } = opts

  const prev = readCleanupJob(stateDir)
  if (prev !== null && minIntervalMs > 0) {
    const since = prev.finishedAt ?? prev.requestedAt
    if (Date.now() - since < minIntervalMs) {
      return { started: false, reason: 'not due yet' }
    }
  }

  // 已在跑就不重复派。
  if (prev !== null && prev.outcome === 'running' && prev.pid !== null && isAlive(prev.pid)) {
    return { started: false, reason: 'already running' }
  }

  /*
   * 锁的 owner token。
   *
   * 主进程创建锁、worker 释放锁，两个进程的 pid 不同 —— 所以所有权按
   * 这个 token 判断，并通过命令行参数交给 worker。
   */
  const ownerToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  /*
   * 锁拿不到时把**具体原因**带给用户（2026-11-01 定版复核第 5 项）。
   *
   * "另一个清理持有锁"和"锁陈旧但无法安全接管"是完全不同的处境：
   * 前者等一会儿就好，后者需要人工删除锁文件。混成一句话会让用户
   * 一直重试一个永远不会自己恢复的状态。
   */
  let staleReason: string | undefined
  if (!tryAcquireLock(stateDir, 10 * 60 * 1000, ownerToken, (reason) => {
    staleReason = reason
  })) {
    return {
      started: false,
      reason: staleReason ?? 'another cleanup holds the lock',
    }
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeCleanupJob(stateDir, {
    requestId,
    pid: null,
    requestedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    outcome: 'pending',
    recycled: 0,
    skipped: 0,
  })

  /*
   * 派生**独立进程**。
   *
   * 关键是 `spawn` 而不是 `execFileSync`：后者的同步等待会阻塞本进程的事件循环，
   * 那正是这次事故的机制。`spawn` 只是 fork + exec，几毫秒返回。
   */
  /*
   * 定位 worker 文件：**不要用 `__dirname`，也不要依赖 `import.meta.dirname`**。
   *
   * 两次踩坑记录：
   *
   *   1. 第一版用 `__dirname` —— ESM 里不存在，运行时抛
   *      `ERR_AMBIGUOUS_MODULE_SYNTAX`。它只在**真的派生 worker** 时才执行，
   *      单元测试碰不到这行。
   *
   *   2. 第二版用 `import.meta.dirname` —— 源码里正确，但**打包器把它改写成
   *      了 `__dirname`**（产出的 chunk 里能直接看到 `join(__dirname, ...)`），
   *      而产物是 ESM，于是生产环境同样失效，且不报错、只是清理永远不跑。
   *
   * `fileURLToPath(import.meta.url)` 是打包器不会改写的形态：`import.meta.url`
   * 在 ESM 产物里始终有效，`fileURLToPath` 是纯函数调用。
   */
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), WORKER_ENTRY)
  /*
   * 参数：stateDir limit requestId ownerToken mode
   *
   * `mode` 必须显式传 —— worker 原来只会清过期项，导致"清空安全区"清不掉
   * 刚删除的条目（SD-03）。
   */
  const child = spawn(
    process.execPath,
    [workerPath, stateDir, String(limit), requestId, ownerToken, mode],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  )

  /*
   * **必须监听 `error`。**
   *
   * `spawn` 失败（worker 文件不存在、node 无法启动、权限不足）是**异步**
   * 报告的 —— 通过 `error` 事件。没有监听器时 EventEmitter 会把 `error`
   * 变成未捕获异常，可能让宿主主进程崩掉。
   *
   * 而且 `child.pid` 在这类情况下可能是 undefined，所以不能只靠它判断。
   */
  let spawnFailed: string | undefined
  child.on('error', (error: Error) => {
    spawnFailed = error.message
    // 派发失败必须把锁还回去，否则后续清理永远被挡住。
    releaseLock(stateDir, ownerToken)
    writeCleanupJob(stateDir, {
      requestId,
      pid: null,
      requestedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: Date.now(),
      outcome: 'failed',
      recycled: 0,
      skipped: 0,
      lastError: `failed to spawn cleanup worker: ${error.message}`,
    })
  })

  /*
   * ## 必须监听 `exit`（2026-11-01 审查 SD-08）
   *
   * `spawn` 成功只表示 **Node 进程启动了**，不表示 worker 文件被成功加载。
   * 入口缺失、依赖损坏、绑定前崩溃 —— 这些情况下 Node 正常产生 pid、
   * 然后以非零码退出，**不会触发 `error` 事件**。
   *
   * 而锁里存的是**父进程 pid**（worker 还没来得及 `bindWorkerPid`）。
   * 于是：
   *
   * ```
   * worker 退出（锁没释放）
   * 父进程活着 → isAlive(holder.pid) 恒真
   * → 陈旧锁接管永不成立 → 清理永久停摆
   * ```
   *
   * 现在监听 `exit`：正常退出（code 0）什么都不做 —— worker 自己已经写好
   * 状态并释放锁。非零退出视为失败，写 failed 状态并释放锁。
   *
   * 竞态说明：worker 可能已经写了 completed 状态之后才退出（code 0），
   * 所以**只在非零退出时**覆盖状态，不去踩正常路径写下的结果。
   */
  child.on('exit', (code: number | null, signal: string | null) => {
    if (code === 0 || spawnFailed !== undefined) {
      /*
       * 正常退出，或 `error` 已经处理过 —— 不覆盖。
       *
       * 注意 `exit` 与 `error` 可能都触发，`spawnFailed` 是去重标志。
       */
      return
    }
    /*
     * 非零退出 / 被信号杀掉：worker 没能完成自己的收尾。
     *
     * 释放锁并把状态标为 failed —— 否则它会永远停在 `running`，
     * 而陈旧锁接管又被活着的父 pid 挡住。
     */
    releaseLock(stateDir, ownerToken)
    /*
     * 只在状态仍是本次请求的 `running` 时才覆盖 ——
     * 避免踩掉一个已经开始的新请求。
     */
    const current = readCleanupJob(stateDir)
    if (current !== null && current.requestId === requestId && current.outcome === 'running') {
      writeCleanupJob(stateDir, {
        requestId,
        pid: child.pid ?? null,
        requestedAt: current.requestedAt,
        startedAt: current.startedAt ?? Date.now(),
        finishedAt: Date.now(),
        outcome: 'failed',
        recycled: 0,
        skipped: 0,
        lastError:
          `cleanup worker exited before finishing (code ${code ?? 'null'}, signal ${signal ?? 'none'}). ` +
          'The lock has been released so the next run can start.',
      })
    }
  })
  child.unref()

  if (typeof child.pid === 'number') {
    /*
     * ## 不能无条件把状态写成 `running`（2026-11-01 定版复核第 7 项）
     *
     * spawn 成功只表示进程启动了。**一个很快的 worker 可能在父进程执行到
     * 这一行之前就已经跑完**：写好 `completed`、`recycled=7`、释放锁并退出。
     *
     * 那时父进程再写 `running` / `recycled=0`，就把终态和统计一起抹掉。
     * 而且 `exit` 的 `code === 0` 分支只做"直接返回"，不会纠正 ——
     * 状态永远停在 `running`，计数永远是 0。
     *
     * 复核用受控调度实测到：最终 running、recycled=0、锁已不存在。
     *
     * 现在：先读一次，若已是**本次请求**的终态就什么都不写。
     */
    const existing = readCleanupJob(stateDir)
    const alreadyTerminal =
      existing !== null &&
      existing.requestId === requestId &&
      (existing.outcome === 'completed' || existing.outcome === 'failed')

    if (!alreadyTerminal) {
      writeCleanupJob(stateDir, {
        requestId,
        pid: child.pid,
        requestedAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: null,
        outcome: 'running',
        recycled: 0,
        skipped: 0,
      })
    }
  } else {
    /*
     * 没有 pid：spawn 失败了。`error` 事件可能稍后才到，但此刻我们已能
     * 判定失败 —— 立刻释放锁并返回，不等异步事件。
     */
    releaseLock(stateDir, ownerToken)
    return {
      started: false,
      reason: spawnFailed ?? 'failed to spawn the cleanup worker (no pid)',
    }
  }

  return { started: true }
}

/** 供 worker 复用（导出给子进程用）。 */
export {
  releaseLock as releaseCleanupLock,
  writeCleanupJob as writeCleanupJobState,
  tryAcquireLock,
  bindWorkerPid,
}
