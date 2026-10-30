/**
 * 清理 worker —— 在**独立进程**里执行过期条目回收。
 *
 * ## 为什么必须是独立进程
 *
 * 2026-10-30 事故：清理在宿主主进程里同步执行，把事件循环占住 8 小时，
 * 会话历史加载不出来。改成 `setImmediate` 或 `void promise` 都没用 ——
 * 那些仍在同一个事件循环里跑同步 fs 与 `execFileSync`。
 *
 * 只有换进程，主进程的事件循环才真正不被影响。即使这个 worker 卡住或崩溃，
 * 宿主仍能响应、仍能查询异常批次。
 *
 * ## 用法（由 cleanup.ts 派生，不接受外部任意参数）
 *
 *     node cleanup-worker.js <stateDir> <limit> <requestId>
 *
 * `stateDir` 来自插件配置，不是任意 IPC 输入 —— 避免被用来删除别处的文件。
 *
 * ## 状态写在哪
 *
 * 进度写在 `<stateDir>/cleanup-job.json`，主进程只读。锁 `<stateDir>/cleanup.lock`
 * 由本进程在结束时释放；崩溃时残留的锁会被下次调度按「过期 + pid 已死」接管。
 *
 * @module dsh-safe-delete/cleanup-worker
 */

import { bindWorkerPid, readCleanupJob, releaseCleanupLock, writeCleanupJobState } from './cleanup'
import { pruneNowForWorker } from './cleanup-run'

/**
 * 主函数。
 *
 * @returns 退出码。
 */
async function main(): Promise<number> {
  const [stateDir, limitArg, requestId, ownerToken, modeArg] = process.argv.slice(2)
  if (stateDir === undefined || stateDir === '') {
    console.error('cleanup-worker: missing stateDir')
    return 2
  }
  /*
   * 用法：cleanup-worker.js <stateDir> <limit> <requestId> <ownerToken> <mode>
   *
   * `mode` 是 `expired`（只清过期）或 `all`（用户明确要求清空安全区）。
   * 缺省按 `expired` —— 更保守：宁可少清，不可多删。
   *
   * 这个参数是 SD-03 的修复点。此前 worker 只清过期项，于是用户点
   * "清空安全区"时，刚删除（还没过期）的条目一条都不会动，而命令报告成功。
   */
  const limit = Number(limitArg ?? '500')
  const id = requestId ?? `${Date.now()}`
  const mode: 'expired' | 'all' = modeArg === 'all' ? 'all' : 'expired'
  /*
   * owner token 由派发方生成并传入。
   *
   * 锁是**主进程**创建的，由**本进程**释放 —— 两个进程的 pid 不同，所以
   * 所有权必须按 token 判断。第一版用 pid 判断，结果是 worker 永远不会
   * 释放锁：第一次清理之后，后续每次都被 `another cleanup holds the lock`
   * 挡住，直到 DSH 重启。
   */
  const token = ownerToken ?? ''

  /*
   * **第一件事：把自己的 pid 绑到锁上。**
   *
   * 锁是主进程创建的，里面最初是主进程 pid。而清理在本进程里跑 ——
   * 若本进程崩溃、主进程还活着，存活判定会一直为真，锁永不接管
   * （2026-10-30 复审 SD-02，已隔离复现）。
   *
   * 绑定之后，存活判定以 `workerPid` 为准：本进程一死，锁就能被接管。
   */
  if (token !== '') bindWorkerPid(stateDir, token)

  const prev = readCleanupJob(stateDir)
  const requestedAt = prev?.requestedAt ?? Date.now()

  try {
    const result = await pruneNowForWorker(stateDir, Number.isFinite(limit) ? limit : 500, undefined, undefined, mode)

    writeCleanupJobState(stateDir, {
      requestId: id,
      pid: process.pid,
      requestedAt,
      startedAt: prev?.startedAt ?? Date.now(),
      finishedAt: Date.now(),
      outcome: 'completed',
      recycled: result.recycled,
      skipped: result.skipped,
    })
    return 0
  } catch (error) {
    writeCleanupJobState(stateDir, {
      requestId: id,
      pid: process.pid,
      requestedAt,
      startedAt: prev?.startedAt ?? Date.now(),
      finishedAt: Date.now(),
      outcome: 'failed',
      recycled: 0,
      skipped: 0,
      lastError: error instanceof Error ? error.message : String(error),
    })
    return 1
  } finally {
    // 按 owner token 释放 —— 这个 token 是派发方创建锁时用的那个。
    releaseCleanupLock(stateDir, token)
  }
}

void main().then((code) => {
  process.exit(code)
})
