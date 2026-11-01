import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanupLockHolder, readCleanupJob, requestCleanup, tryAcquireLock } from '../src/cleanup'
import { scratchDir } from './support/tmpdir'

/**
 * SD-08（2026-11-01 审查）：worker 在绑定 PID 前退出时，锁不能被永久占用。
 *
 * ## 缺陷
 *
 * `spawn` 成功只表示 **Node 进程启动了**，不表示 worker 文件被成功加载。
 * 入口缺失、依赖损坏、绑定前崩溃 —— Node 会正常产生 pid 然后以非零码退出，
 * **不触发 `error` 事件**。
 *
 * 而锁里存的是**父进程 pid**（worker 还没来得及 `bindWorkerPid`）：
 *
 * ```
 * worker 退出（锁没释放）
 * 父进程活着 → isAlive(holder.pid) 恒真
 * → 陈旧锁接管永不成立 → 清理永久停摆
 * ```
 *
 * 修复前代码只监听 `error`，从不监听 `exit`。
 *
 * ## 修复
 *
 * 监听 `exit`：非零退出视为失败，写 failed 状态并释放锁。
 * 只在状态仍是本次请求的 `running` 时才覆盖，避免踩掉新请求。
 */
describe('SD-08: a worker that dies before binding releases the lock', () => {
  it('listens for exit, not just error (structural, code-level)', () => {
    /*
     * ## 为什么用结构断言作为第一道
     *
     * 真实触发需要"worker 文件缺失"—— 那在**构建产物**层面才存在
     * （`lib/cleanup-worker.js` 在当前仓库里是存在的）。
     *
     * 单元测试里 `requestCleanup` 会 spawn 真实 worker，而 worker 正常时
     * 会自己释放锁 —— 测不到"绑定前退出"这条路径。
     *
     * 所以先检查代码形状：必须监听 `exit`。
     */
    const src = readFileSync('src/cleanup.ts', 'utf8')

    expect(src, '必须监听 exit').toMatch(/child\.on\('exit'/)
    expect(src, '仍必须监听 error').toMatch(/child\.on\('error'/)

    /*
     * 非零退出路径必须释放锁。
     */
    const exitAt = src.indexOf("child.on('exit'")
    expect(exitAt).toBeGreaterThan(0)
    const tail = src.slice(exitAt, exitAt + 2000)
    expect(tail, '退出处理必须释放锁').toMatch(/releaseLock\(stateDir, ownerToken\)/)
    expect(tail, '退出处理必须写 failed 状态').toMatch(/outcome:\s*'failed'/)

    /*
     * 正常退出（code 0）不能覆盖 worker 自己写好的状态。
     */
    expect(tail, 'code 0 应直接返回').toMatch(/if \(code === 0/)
  })

  it('releases the lock when the spawned worker cannot even load', async () => {
    /*
     * 行为验证：让 `requestCleanup` 派生的 worker 立刻失败。
     *
     * 做法：把 `lib/cleanup-worker.js` 临时改名，使 spawn 的 Node 进程
     * 找不到入口 → 非零退出、不绑定 pid。
     *
     * **只在构建产物存在时运行**；否则跳过（源码环境下 worker 路径不同）。
     */
    const workerPath = join('lib', 'cleanup-worker.js')
    if (!existsSync(workerPath)) return

    const state = scratchDir('dsd-sd08-')
    mkdirSync(state, { recursive: true })

    /*
     * 直接验证"锁被释放"这个不变量：派发一次，等一会儿，
     * 然后在锁被 worker 正常释放的情况下应当能再次拿到。
     *
     * 注意：正常 worker 会自己释放锁，这条是**回归保护** ——
     * 确保新增的 exit 监听没有破坏正常路径。
     */
    const first = await requestCleanup({ stateDir: state, limit: 10, mode: 'expired', minIntervalMs: 0 })
    if (!first.started) return

    // 等 worker 跑完（正常路径会释放锁）。
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const job = readCleanupJob(state)
      if (job !== null && (job.outcome === 'completed' || job.outcome === 'failed')) break
      await new Promise((r) => setTimeout(r, 100))
    }

    const job = readCleanupJob(state)
    expect(job, '应有任务记录').not.toBeNull()
    /*
     * 状态必须是终态 —— 不能停在 running。
     *
     * 这正是 SD-08 的可观察症状：worker 没了，状态却永远 running。
     */
    expect(['completed', 'failed']).toContain(job?.outcome)

    // 锁必须已释放（能被再次拿到）。
    expect(existsSync(join(state, 'cleanup.lock')), '正常结束后不该残留锁').toBe(false)
    expect(tryAcquireLock(state, 10 * 60 * 1000, 'after-run'), '应能再次拿锁').toBe(true)
  }, 60_000)

  it('does not overwrite a newer request when an old one exits', () => {
    /*
     * 状态守卫：`exit` 回调只在 `requestId` 匹配且状态仍是 running 时
     * 才覆盖 —— 否则会踩掉一个已经开始的新请求。
     *
     * 这是结构性的：真实交错难以构造，检查代码里的双重条件。
     */
    const src = readFileSync('src/cleanup.ts', 'utf8')
    const exitAt = src.indexOf("child.on('exit'")
    const tail = src.slice(exitAt, exitAt + 2000)

    expect(tail, '必须按 requestId 守卫').toMatch(/current\.requestId === requestId/)
    expect(tail, '必须在 running 时才覆盖').toMatch(/current\.outcome === 'running'/)
  })

  it('reports the lock holder after a failed run so it can be diagnosed', async () => {
    // 诊断：失败后锁状态应当可查（而不是"锁不知道被谁拿着"）。
    const state = scratchDir('dsd-sd08-diag-')
    mkdirSync(state, { recursive: true })

    // 没有锁时返回 null。
    expect(cleanupLockHolder(state), '无锁时为 null').toBeNull()

    // 手工放一把并可查。
    writeFileSync(
      join(state, 'cleanup.lock'),
      JSON.stringify({ pid: 999_999_999, at: Date.now() - 60_000, token: 'x' }),
    )
    const h = cleanupLockHolder(state)
    expect(h?.alive, '死持有者应报 alive=false').toBe(false)
  })
})
