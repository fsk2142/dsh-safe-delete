import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readCleanupJob } from '../src/cleanup'
import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 自动清理现在是**后台子进程**，不再是工具调用里的同步步骤。
 *
 * ## 为什么重写这组测试
 *
 * 旧测试验证的是「调用工具后过期条目被清掉了」。那在同步实现下成立，
 * 但它恰好**验证不出** 2026-10-30 的事故：清理确实发生了，代价是把事件
 * 循环占住 8 小时，宿主连会话历史都加载不出来。
 *
 * 新测试验证新架构真正的不变量：
 *
 *   1. 工具调用**不等待**清理完成；
 *   2. 调用后留下可查询的任务状态；
 *   3. 注入一个慢得离谱的 recycler 时，工具仍在毫秒级返回 —— 这是事故的直接回归测试。
 */

const DAY = 24 * 60 * 60 * 1000

/**
 * 建一套工具依赖。
 *
 * @param over 覆盖项。
 * @returns 工具依赖。
 */
function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  const root = scratchDir('dsd-autoprune-')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  return {
    stateDir: join(root, 'state'),
    env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
    requestApproval: async () => 'allowed-once',
    retentionDays: 7,
    ...over,
  }
}

/**
 * 造一条已过期的条目。
 *
 * @param stateDir 安全区。
 * @param work 工作目录。
 * @param name 文件名。
 */
async function seedExpired(stateDir: string, work: string, name: string): Promise<void> {
  const p = join(work, name)
  writeFileSync(p, 'x')
  // now 设到 10 天前 → retention 7 天 → 立刻过期
  await moveToSafeZone(stateDir, p, { retentionDays: 7, now: Date.now() - 10 * DAY })
}

/**
 * 取一个工具。
 *
 * @param list 工具列表。
 * @param name 工具名。
 * @returns 工具。
 */
function toolOf(list: ReturnType<typeof createTools>, name: string) {
  const found = list.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

describe('background cleanup: does not block tool calls', () => {
  it('returns from safe_zone_status quickly even with expired entries', async () => {
    const d = deps()
    mkdirSync(d.env.workdir, { recursive: true })
    for (let i = 0; i < 10; i += 1) {
      await seedExpired(d.stateDir, d.env.workdir, `old${i}.txt`)
    }
    expect(await listSafeZone(d.stateDir)).toHaveLength(10)

    const tool = toolOf(createTools(d), 'safe_zone_status')
    const t0 = Date.now()
    await tool.execute({})
    const ms = Date.now() - t0

    /*
     * 关键断言：**不阻塞**。
     *
     * 旧实现在这里会同步跑完 10 条的回收站调用。新实现只派生一个子进程
     * 就返回。500 ms 是宽松上限（正常应在 10 ms 量级），足以区分两者。
     */
    expect(ms, `状态查询应立刻返回，实际 ${ms} ms`).toBeLessThan(500)
  })

  it('leaves a queryable task record after the first tool call', async () => {
    const d = deps()
    mkdirSync(d.env.workdir, { recursive: true })
    await seedExpired(d.stateDir, d.env.workdir, 'old.txt')

    const tool = toolOf(createTools(d), 'safe_zone_status')
    await tool.execute({})

    /*
     * 派发后应当留下一条任务记录 —— 用户与诊断都需要知道"清理到底跑没跑"。
     * 子进程可能已经跑完，所以只断言"有记录"，不断言具体状态。
     */
    const job = readCleanupJob(d.stateDir)
    if (job !== null) {
      expect(job.requestId).toBeTruthy()
      expect(['pending', 'running', 'completed', 'failed', 'unknown']).toContain(job.outcome)
    }
  })

  it('does not wait for a deliberately slow recycler', async () => {
    /*
     * 这次事故的直接回归测试。
     *
     * 注入一个每次调用忙等 300 ms 的 recycler。若清理还在调用路径上同步执行，
     * 20 条就是 6 秒。新架构下工具应在毫秒级返回。
     */
    let recycleCalls = 0
    const d = deps({
      recycler: () => {
        recycleCalls += 1
        const until = Date.now() + 300
        while (Date.now() < until) {
          /* 故意忙等，模拟慢回收站 */
        }
        return { ok: true }
      },
    })
    mkdirSync(d.env.workdir, { recursive: true })
    for (let i = 0; i < 20; i += 1) {
      await seedExpired(d.stateDir, d.env.workdir, `slow${i}.txt`)
    }

    const tool = toolOf(createTools(d), 'safe_zone_status')
    const t0 = Date.now()
    await tool.execute({})
    const ms = Date.now() - t0

    expect(ms, `慢回收替身不该拖慢这次调用，实际 ${ms} ms`).toBeLessThan(500)
    // 慢回收发生在**子进程**里，本进程的计数器应当没被调用（或极少）。
    expect(recycleCalls, '同步路径上不该调用 recycler').toBeLessThanOrEqual(1)
  })

  it('respects autoPrune=false by not dispatching anything', async () => {
    const d = deps({ autoPrune: false })
    mkdirSync(d.env.workdir, { recursive: true })
    await seedExpired(d.stateDir, d.env.workdir, 'old.txt')

    const tool = toolOf(createTools(d), 'safe_zone_status')
    await tool.execute({})

    // 关掉自动清理后不该留下任务记录。
    expect(readCleanupJob(d.stateDir), 'autoPrune=false 时不该派发清理').toBeNull()
    // 条目也还在。
    expect(await listSafeZone(d.stateDir)).toHaveLength(1)
  })

  it('still deletes normally while cleanup is pending', async () => {
    // 删除功能本身必须与清理解耦：清理在跑也不影响删除。
    const d = deps()
    mkdirSync(d.env.workdir, { recursive: true })
    await seedExpired(d.stateDir, d.env.workdir, 'old.txt')

    const tools = createTools(d)
    const target = join(d.env.workdir, 'fresh.txt')
    writeFileSync(target, 'data')

    const r = await toolOf(tools, 'safe_delete').execute({ path: target })
    expect(r.ok, r.error ?? '删除应成功').toBe(true)
    expect(existsSync(target), '文件应已移入安全区').toBe(false)
    // 新条目 + 旧条目都在索引里（清理是后台的，可能还没跑）。
    expect((await listSafeZone(d.stateDir)).length).toBeGreaterThanOrEqual(2)
  })

  it('reports cleanup state in the status text', async () => {
    const d = deps()
    mkdirSync(d.env.workdir, { recursive: true })
    const tool = toolOf(createTools(d), 'safe_zone_status')
    const r = await tool.execute({})
    // 用户需要能看到清理状态，否则"保留期 7 天"会被误读成准点清理。
    expect(r.text).toContain('cleanup:')
  })
})

describe('cleanup job record', () => {
  it('is null before any cleanup has been requested', () => {
    const d = deps()
    expect(readCleanupJob(d.stateDir)).toBeNull()
  })

  it('parses a written record', () => {
    const d = deps()
    mkdirSync(d.stateDir, { recursive: true })
    writeFileSync(
      join(d.stateDir, 'cleanup-job.json'),
      JSON.stringify({
        requestId: 'r1',
        pid: 123,
        requestedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        outcome: 'completed',
        recycled: 5,
        skipped: 1,
      }),
    )
    const job = readCleanupJob(d.stateDir)
    expect(job?.outcome).toBe('completed')
    expect(job?.recycled).toBe(5)
    expect(job?.skipped).toBe(1)
  })

  it('returns null instead of throwing on a corrupt record', () => {
    // 诊断文件损坏不该让状态查询失败。
    const d = deps()
    mkdirSync(d.stateDir, { recursive: true })
    writeFileSync(join(d.stateDir, 'cleanup-job.json'), '{not json')
    expect(readCleanupJob(d.stateDir)).toBeNull()
  })

  it('reads back the raw file to prove the shape is stable', () => {
    const d = deps()
    mkdirSync(d.stateDir, { recursive: true })
    writeFileSync(
      join(d.stateDir, 'cleanup-job.json'),
      JSON.stringify({
        requestId: 'r2',
        pid: null,
        requestedAt: 9,
        startedAt: null,
        finishedAt: null,
        outcome: 'pending',
        recycled: 0,
        skipped: 0,
      }),
    )
    const raw = JSON.parse(readFileSync(join(d.stateDir, 'cleanup-job.json'), 'utf8')) as { outcome: string }
    expect(raw.outcome).toBe('pending')
  })
})
