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
    const d = deps({ now: () => clock})
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

  it('prunes as soon as an entry expires, with no interval gate', async () => {
    /*
     * 语义变更记录：旧实现在两次清理之间有一个「检查间隔」，未到间隔就不清。
     * 那个间隔参数已移除 —— 现在每次工具调用只看"有没有过期条目"。
     *
     * 为什么去掉：容量层移除后，一次清理只是"读索引、挑过期项"，开销很小，
     * 再为此维护计时器与它的持久化反而更复杂。
     */
    let clock = 0
    const d = deps({ now: () => clock })
    const tools = createTools(d)

    // 先跑一次建立基线（此时安全区是空的）。
    await toolOf(tools, 'safe_zone_status').execute({})

    const dir = join(d.env.workdir, 'old')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    await moveToSafeZone(d.stateDir, dir, { retentionDays: 1, now: 0 })
    expect(await listSafeZone(d.stateDir)).toHaveLength(1)

    // 时间推过保留期：下一次工具调用就应清掉。
    clock = 2 * DAY
    await toolOf(tools, 'safe_zone_status').execute({})

    expect(await listSafeZone(d.stateDir), '过期即清，没有间隔门槛').toHaveLength(0)
  })

  it('skips scheduling entirely when autoPrune is off', async () => {
    let clock = 0
    const d = deps({ now: () => clock, autoPrune: false})
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
    const d = deps({ now: () => clock})
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
