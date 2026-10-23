import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

function deps(over: Partial<ToolDeps> = {}): ToolDeps & { approvals: number } {
  const root = scratchDir('dsd-thresh-')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  const approvals = { count: 0 }
  const d: ToolDeps & { approvals: number } = {
    stateDir: join(root, 'state'),
    env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
    requestApproval: async () => {
      approvals.count += 1
      return 'allowed-once'
    },
    retentionDays: 7,
    maxBytes: 20 * 1024 ** 3,
    ...over,
    approvals: 0,
  }
  // 让测试能读到调用次数
  Object.defineProperty(d, 'approvals', { get: () => approvals.count })
  return d
}

function toolOf(list: ReturnType<typeof createTools>, name: string) {
  const found = list.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

describe('confirmation thresholds', () => {
  it('does not ask when the target is under both thresholds', async () => {
    const d = deps({ confirmFileCount: 100, confirmBytes: 1024 * 1024 })
    const file = join(d.env.workdir, 'small.txt')
    writeFileSync(file, 'x')
    const result = await toolOf(createTools(d), 'safe_delete').execute({ path: file })
    expect(result.ok).toBe(true)
    expect(d.approvals).toBe(0)
  })

  it('asks when the file count exceeds the threshold', async () => {
    const d = deps({ confirmFileCount: 2, confirmBytes: 1024 ** 3 })
    const dir = join(d.env.workdir, 'many')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `f${i}.txt`), 'x')
    const result = await toolOf(createTools(d), 'safe_delete').execute({ path: dir })
    expect(d.approvals).toBe(1)
    expect(result.ok).toBe(true)
  })

  it('asks when the byte size exceeds the threshold', async () => {
    const d = deps({ confirmFileCount: 1000, confirmBytes: 10 })
    const file = join(d.env.workdir, 'big.txt')
    writeFileSync(file, 'x'.repeat(100))
    await toolOf(createTools(d), 'safe_delete').execute({ path: file })
    expect(d.approvals).toBe(1)
  })

  it('respects a rejection from the threshold prompt', async () => {
    const d = deps({
      confirmFileCount: 1,
      confirmBytes: 1,
      requestApproval: async () => 'rejected',
    })
    const file = join(d.env.workdir, 'x.txt')
    writeFileSync(file, 'x'.repeat(100))
    const result = await toolOf(createTools(d), 'safe_delete').execute({ path: file })
    expect(result.ok).toBe(false)
    expect(await listSafeZone(d.stateDir)).toHaveLength(0)
  })

  it('combines with path classification: either reason is enough to ask', async () => {
    // 危险路径 + 阈值同时命中，只应问一次。
    const d = deps({ confirmFileCount: 1, confirmBytes: 1 })
    const home = d.env.home
    mkdirSync(home, { recursive: true })
    const file = join(home, 'x.txt')
    writeFileSync(file, 'x'.repeat(100))
    await toolOf(createTools(d), 'safe_delete').execute({ path: file })
    expect(d.approvals).toBe(1)
  })

  it('does not ask for a threshold when both thresholds are disabled (0)', async () => {
    const d = deps({ confirmFileCount: 0, confirmBytes: 0 })
    const dir = join(d.env.workdir, 'many')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `f${i}.txt`), 'x')
    await toolOf(createTools(d), 'safe_delete').execute({ path: dir })
    expect(d.approvals).toBe(0)
  })

  it('states which threshold triggered the prompt', async () => {
    let captured = ''
    const d = deps({
      confirmFileCount: 2,
      confirmBytes: 0,
      requestApproval: async (reason) => {
        captured = reason
        return 'allowed-once'
      },
    })
    const dir = join(d.env.workdir, 'many')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `f${i}.txt`), 'x')
    await toolOf(createTools(d), 'safe_delete').execute({ path: dir })
    // 用户需要知道自己在为什么签字。
    expect(captured).toMatch(/exceeds the limit of 2/)
  })

  it('shows the thresholds in safe_zone_status', async () => {
    const d = deps({ confirmFileCount: 1234, confirmBytes: 5 * 1024 * 1024 })
    const status = await toolOf(createTools(d), 'safe_zone_status').execute({})
    expect(status.text).toMatch(/1234 entries/)
    expect(status.text).toMatch(/5\.0 MB/)
  })

  it('reports disabled thresholds as disabled', async () => {
    const d = deps({ confirmFileCount: 0, confirmBytes: 0 })
    const status = await toolOf(createTools(d), 'safe_zone_status').execute({})
    // 输出标签在 token 优化里缩短为 `confirm over:`（原来是整句）。
    expect(status.text).toMatch(/confirm over: disabled/)
  })
})
