import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { decideGate, deletePath, describeApprovalRequest, type DeleteContext } from '../src/delete-core'
import { describeTarget } from '../src/describe'
import { listSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * `delete-core` 的直接测试。
 *
 * 为什么必须有：它是三条入口（模型工具 / 斜杠命令 / CLI）共用的删除核心。
 * 只测上层就够了吗？不够 —— 上层各自有权重不同的适配，核心本身的行为
 * （禁区判定、阈值、审批、移入顺序）必须有独立证据。
 */

function makeEnv() {
  const root = scratchDir('dsd-core-')
  const home = join(root, 'home')
  const state = join(root, 'state')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  mkdirSync(state, { recursive: true })
  return {
    root,
    home,
    state,
    work,
    env: {
      home,
      workdir: work,
      dshHome: join(home, '.dsh'),
      safeZoneDir: state,
      // 必须隔离：系统临时目录被豁免为 free，不隔离就测不到 confirm 分支。
      tmpdir: join(root, 'not-the-temp'),
    },
  }
}

function makeCtx(over: Partial<DeleteContext> = {}): DeleteContext {
  const { state, env } = makeEnv()
  return {
    stateDir: state,
    env,
    retentionDays: 7,
    confirmFileCount: 0,
    confirmBytes: 0,
    requestApproval: async () => 'allowed-once',
    now: () => Date.now(),
    ...over,
  }
}

describe('deletePath refuses what must never be deleted', () => {
  it('refuses a filesystem root', async () => {
    for (const root of ['C:\\', 'C:/', '/']) {
      const result = await deletePath({ path: root }, makeCtx())
      expect(result.ok, root).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/filesystem root/)
    }
  })

  it('refuses the safe zone state directory and anything inside it', async () => {
    const ctx = makeCtx()
    const inside = join(ctx.stateDir, 'index.json')
    writeFileSync(inside, '[]')

    for (const target of [ctx.stateDir, inside]) {
      const result = await deletePath({ path: target }, ctx)
      expect(result.ok, target).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/safe zone/)
    }
  })

  it('reports a missing path instead of creating anything', async () => {
    const ctx = makeCtx()
    const result = await deletePath({ path: join(ctx.env.workdir, 'nope') }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not found/)
  })

  it('refuses an empty path', async () => {
    const result = await deletePath({ path: '   ' }, makeCtx())
    expect(result.ok).toBe(false)
  })
})

describe('deletePath preview', () => {
  it('changes nothing and reports the gate', async () => {
    const ctx = makeCtx()
    const file = join(ctx.env.workdir, 'a.txt')
    writeFileSync(file, 'hello')

    const result = await deletePath({ path: file, preview: true }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.kind).toBe('preview')
      expect(result.gate.classification).toBe('free')
    }
    expect(existsSync(file)).toBe(true)
    expect(await listSafeZone(ctx.stateDir)).toHaveLength(0)
  })
})

describe('deletePath moves into the safe zone', () => {
  it('moves a file and records it', async () => {
    const ctx = makeCtx()
    const file = join(ctx.env.workdir, 'a.txt')
    writeFileSync(file, 'hello')

    const result = await deletePath({ path: file }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok && result.kind === 'moved') {
      expect(result.entry.originalPath).toBe(file)
      expect(result.entry.bytes).toBe(5)
    }
    expect(existsSync(file)).toBe(false)
    expect(await listSafeZone(ctx.stateDir)).toHaveLength(1)
  })

  it('asks for approval on a dangerous path and honours a rejection', async () => {
    let asked = 0
    const base = makeCtx()
    const ctx: DeleteContext = {
      ...base,
      requestApproval: async () => {
        asked += 1
        return 'rejected'
      },
    }
    const file = join(base.env.home, 'important.txt')
    writeFileSync(file, 'keep me')

    const result = await deletePath({ path: file }, ctx)
    expect(asked).toBe(1)
    expect(result.ok).toBe(false)
    // 被拒绝时必须原样留着。
    expect(existsSync(file)).toBe(true)
    expect(await listSafeZone(base.stateDir)).toHaveLength(0)
  })

  it('records the staged file name under the entry id', async () => {
    const ctx = makeCtx()
    const file = join(ctx.env.workdir, 'named.txt')
    writeFileSync(file, 'x')

    const result = await deletePath({ path: file }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok && result.kind === 'moved') {
      // 安全区里的内容应保留可读的文件名，而不是只剩一串 id。
      const staged = join(ctx.stateDir, 'items', result.entry.id, 'named.txt')
      expect(existsSync(staged)).toBe(true)
    }
  })
})

describe('decideGate', () => {
  it('does not ask when nothing is dangerous and no threshold is crossed', () => {
    const ctx = makeCtx()
    const file = join(ctx.env.workdir, 'a.txt')
    writeFileSync(file, 'x')
    const gate = decideGate(file, describeTarget(file), ctx)
    expect(gate.needsApproval).toBe(false)
    expect(gate.reasons).toHaveLength(0)
  })

  it('states which limit was crossed', () => {
    const ctx = makeCtx({ confirmFileCount: 1 })
    const dir = join(ctx.env.workdir, 'two')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    writeFileSync(join(dir, 'b.txt'), 'x')

    const gate = decideGate(dir, describeTarget(dir), ctx)
    expect(gate.needsApproval).toBe(true)
    expect(gate.reasons.join(' ')).toMatch(/2 entries exceeds the limit of 1/)
  })

  it('reports both a dangerous path and a crossed threshold', () => {
    const ctx = makeCtx({ confirmBytes: 1 })
    const file = join(ctx.env.home, 'x.txt')
    mkdirSync(ctx.env.home, { recursive: true })
    writeFileSync(file, 'xx')

    const gate = decideGate(file, describeTarget(file), ctx)
    expect(gate.classification).toBe('confirm')
    expect(gate.reasons).toHaveLength(2)
    expect(gate.reasons.join(' ')).toMatch(/confirm path/)
    expect(gate.reasons.join(' ')).toMatch(/bytes exceeds/)
  })

  it('treats a threshold of 0 as disabled', () => {
    const ctx = makeCtx({ confirmFileCount: 0, confirmBytes: 0 })
    const dir = join(ctx.env.workdir, 'many')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `f${i}.txt`), 'x')
    expect(decideGate(dir, describeTarget(dir), ctx).needsApproval).toBe(false)
  })
})

describe('describeApprovalRequest', () => {
  it('asks a question and explains why the user is being asked', () => {
    const ctx = makeCtx({ confirmFileCount: 1 })
    const dir = join(ctx.env.workdir, 'many')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a'), 'x')
    writeFileSync(join(dir, 'b'), 'x')

    const text = describeApprovalRequest(dir, describeTarget(dir), decideGate(dir, describeTarget(dir), ctx), 7)
    expect(text).toMatch(/^Delete "/)
    expect(text).toMatch(/Why this needs your OK/)
    expect(text).toMatch(/exceeds the limit/)
    // 说明之后能取回，用户才知道自己在签什么。
    expect(text).toMatch(/restored for 7 days/)
  })
})
