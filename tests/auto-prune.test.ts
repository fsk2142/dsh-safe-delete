import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

const DAY = 24 * 60 * 60 * 1000

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  const root = scratchDir('dsd-autoprune-')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  return {
    stateDir: join(root, 'state'),
    env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
    requestApproval: async () => 'allowed-once',
    retentionDays: 7,
    maxBytes: 20 * 1024 ** 3,
    // 替身：测试绝不能真的调系统回收站（慢，而且会往回收站里扔东西）。
    // 生产路径不传 recycler，默认走真实实现。
    recycler: fakeRecycler(),
    ...over,
  }
}

/**
 * 一个「总是成功」的回收站替身：只把路径从原位置移走，模拟真实行为。
 *
 * @returns 回收站替身。
 */
function fakeRecycler(): (absPath: string) => { ok: true } {
  return (absPath: string) => {
    rmSync(absPath, { recursive: true, force: true })
    return { ok: true }
  }
}

function toolOf(list: ReturnType<typeof createTools>, name: string) {
  const found = list.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

describe('scheduled auto-prune', () => {
  it('prunes expired entries when the interval has elapsed', async () => {
    let clock = 0
    const d = deps({ now: () => clock, autoPruneIntervalMs: DAY })
    const dir = join(d.env.workdir, 'old')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    // 直接放进安全区，并把时间推到过期之后
    await moveToSafeZone(d.stateDir, dir, { retentionDays: 1, now: 0 })
    expect(await listSafeZone(d.stateDir)).toHaveLength(1)

    // 时间推进 2 天：既过期，又超过清理间隔
    clock = 2 * DAY
    const tools = createTools(d)
    // 触发一次工具调用，让调度器有机会运行
    await toolOf(tools, 'safe_zone_status').execute({})

    expect(await listSafeZone(d.stateDir)).toHaveLength(0)
  })

  it('does not prune before the interval elapses', async () => {
    let clock = 0
    const d = deps({ now: () => clock, autoPruneIntervalMs: 10 * DAY })
    const tools = createTools(d)

    // 先跑一次建立基线：首次调用会清理一次，此时安全区里还没有东西。
    await toolOf(tools, 'safe_zone_status').execute({})

    const dir = join(d.env.workdir, 'old')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    await moveToSafeZone(d.stateDir, dir, { retentionDays: 1, now: 0 })

    clock = 2 * DAY // 已过期，但距上次清理只有 2 天，没到 10 天间隔
    await toolOf(tools, 'safe_zone_status').execute({})

    expect(await listSafeZone(d.stateDir)).toHaveLength(1)
  })

  it('skips scheduling entirely when autoPrune is off', async () => {
    let clock = 0
    const d = deps({ now: () => clock, autoPrune: false, autoPruneIntervalMs: 1 })
    const dir = join(d.env.workdir, 'old')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    await moveToSafeZone(d.stateDir, dir, { retentionDays: 1, now: 0 })

    clock = 10 * DAY
    const tools = createTools(d)
    await toolOf(tools, 'safe_zone_status').execute({})

    expect(await listSafeZone(d.stateDir)).toHaveLength(1)
  })

  it('does not run twice within one interval', async () => {
    let clock = 0
    const d = deps({ now: () => clock, autoPruneIntervalMs: DAY })
    const tools = createTools(d)
    clock = 2 * DAY
    await toolOf(tools, 'safe_zone_status').execute({})
    // 再放一条已过期的进去，紧接着调用 —— 不应被同一次间隔清理掉
    const dir = join(d.env.workdir, 'again')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    await moveToSafeZone(d.stateDir, dir, { retentionDays: 1, now: 0 })
    await toolOf(tools, 'safe_zone_status').execute({})
    expect(await listSafeZone(d.stateDir)).toHaveLength(1)
  })
})
