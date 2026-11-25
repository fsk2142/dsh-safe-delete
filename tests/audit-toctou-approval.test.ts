import { describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describeTarget } from '../src/describe'
import { createTools } from '../src/tools'
import { scratchDir } from './support/tmpdir'

function snapshotFor(target: string) {
  const st = lstatSync(target)
  const description = describeTarget(target)
  return {
    target,
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    mode: st.mode,
    isDirectory: st.isDirectory(),
    isSymbolicLink: st.isSymbolicLink(),
    fileCount: description.fileCount,
    bytes: description.bytes,
  }
}

function toolFor(options: {
  stateDir: string
  workdir: string
  snapshot: unknown
  recyclerMany: (paths: readonly string[]) => { ok: boolean; recycled: number; succeededPaths?: string[] }
}) {
  const tool = createTools({
    stateDir: options.stateDir,
    env: {
      home: options.workdir,
      workdir: options.workdir,
      dshHome: options.workdir,
      safeZoneDir: options.stateDir,
      tmpdir: options.workdir,
    },
    retentionDays: 1,
    confirmFileCount: 0,
    confirmBytes: 0,
    destination: 'recycle-bin',
    permanentDeleteRisk: { status: 'risky', risky: true, reason: 'test policy permanently deletes' },
    requestApproval: async () => 'allowed-once',
    recyclerMany: options.recyclerMany,
    executionSnapshot: () => options.snapshot,
  } as never).find((t) => t.name === 'safe_delete')!
  return {
    execute(args: Record<string, unknown>) {
      return (tool.execute as (a: Record<string, unknown>, c?: unknown) => Promise<{ ok: boolean; text: string; error?: string }>)(args, {})
    },
  }
}

describe('recycle-bin approval is bound to the executed call', { timeout: 30_000 }, () => {
  it('refuses a newly discovered permanent-delete risk that the hook did not approve', async () => {
    const root = scratchDir('dsd-toctou-single-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const file = join(work, 'a.txt')
    writeFileSync(file, 'x')
    let recycled = false

    const tool = toolFor({
      stateDir: state,
      workdir: work,
      snapshot: { destination: 'recycle-bin', targets: [snapshotFor(file)], gateApproved: false, recycleRiskApproved: false },
      recyclerMany: (paths) => {
        recycled = true
        return { ok: true, recycled: paths.length, succeededPaths: [...paths] }
      },
    })

    const result = await tool.execute({ path: file })

    expect(result.ok).toBe(false)
    expect(recycled).toBe(false)
    expect(existsSync(file)).toBe(true)
    expect(result.error).toMatch(/not approved|changed|risk/i)
  })

  it('allows the risk when the hook approval snapshot covers it', async () => {
    const root = scratchDir('dsd-toctou-approved-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const file = join(work, 'a.txt')
    writeFileSync(file, 'x')
    let recycled = false

    const tool = toolFor({
      stateDir: state,
      workdir: work,
      snapshot: { destination: 'recycle-bin', targets: [snapshotFor(file)], gateApproved: false, recycleRiskApproved: true },
      recyclerMany: (paths) => {
        recycled = true
        return { ok: true, recycled: paths.length, succeededPaths: [...paths] }
      },
    })

    const result = await tool.execute({ path: file })

    expect(result.ok).toBe(true)
    expect(recycled).toBe(true)
  })

  it('refuses when the approved target is replaced before execution', async () => {
    const root = scratchDir('dsd-toctou-replaced-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const file = join(work, 'a.txt')
    writeFileSync(file, 'small')
    const approved = snapshotFor(file)
    rmSync(file)
    writeFileSync(file, 'replacement with a different size')
    let recycled = false

    const tool = toolFor({
      stateDir: state,
      workdir: work,
      snapshot: { destination: 'recycle-bin', targets: [approved], gateApproved: true, recycleRiskApproved: true },
      recyclerMany: (paths) => {
        recycled = true
        return { ok: true, recycled: paths.length, succeededPaths: [...paths] }
      },
    })

    const result = await tool.execute({ path: file })

    expect(result.ok).toBe(false)
    expect(recycled).toBe(false)
    expect(existsSync(file)).toBe(true)
    expect(result.error).toMatch(/changed|approval/i)
  })

  it('refuses a target replaced after the execution-time check', async () => {
    const root = scratchDir('dsd-toctou-await-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const file = join(work, 'a.txt')
    writeFileSync(file, 'approved content')
    let recycled = false

    const tool = createTools({
      stateDir: state,
      env: { home: root, workdir: work, dshHome: root, safeZoneDir: state, tmpdir: root },
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      destination: 'recycle-bin',
      /*
       * 这两处正是「核对通过之后、真正回收之前」之间的异步/耗时步骤：
       * 判永久删除风险与服务端策略读取。用 getter 在同路径替换文件，
       * 模拟宿主在审批后、执行中被另一进程改掉目标。
       */
      get permanentDeleteRisk() {
        rmSync(file)
        writeFileSync(file, 'replacement content')
        return { status: 'safe' as const, risky: false }
      },
      requestApproval: async () => 'allowed-once',
      recyclerMany: (paths: readonly string[]) => {
        recycled = true
        return { ok: true, recycled: paths.length, succeededPaths: [...paths] }
      },
      executionSnapshot: () => ({ targets: [snapshotFor(file)], gateApproved: true, recycleRiskApproved: true, destination: 'recycle-bin' }),
    } as never).find((t) => t.name === 'safe_delete')!

    const result = await tool.execute({ path: file })

    expect(result.ok).toBe(false)
    expect(recycled).toBe(false)
    expect(existsSync(file)).toBe(true)
    expect(result.error).toMatch(/changed|approval/i)
  })

  it('still deletes the existing path when another path in the batch is missing', async () => {
    const root = scratchDir('dsd-toctou-missing-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const real = join(work, 'real.txt')
    const missing = join(work, 'missing.txt')
    writeFileSync(real, 'x')

    const tool = createTools({
      stateDir: state,
      env: { home: root, workdir: work, dshHome: root, safeZoneDir: state, tmpdir: root },
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      destination: 'recycle-bin',
      permanentDeleteRisk: { status: 'safe', risky: false },
      requestApproval: async () => 'allowed-once',
      recyclerMany: (paths: readonly string[]) => {
        for (const p of paths) rmSync(p)
        return { ok: true, recycled: paths.length, succeededPaths: [...paths] }
      },
      executionSnapshot: () => ({ targets: [snapshotFor(real)], gateApproved: false, recycleRiskApproved: false, destination: 'recycle-bin' }),
    } as never).find((t) => t.name === 'safe_delete')!

    const result = await tool.execute({ paths: [real, missing] })

    expect(result.ok).toBe(true)
    expect(existsSync(real)).toBe(false)
    expect(result.text).toContain(missing)
  })

  it('applies the same fail-closed rule to a batch', async () => {
    const root = scratchDir('dsd-toctou-batch-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const a = join(work, 'a.txt')
    const b = join(work, 'b.txt')
    writeFileSync(a, 'x')
    writeFileSync(b, 'y')
    let recycled = false

    const tool = toolFor({
      stateDir: state,
      workdir: work,
      snapshot: {
        destination: 'recycle-bin',
        targets: [snapshotFor(a), snapshotFor(b)],
        gateApproved: true,
        recycleRiskApproved: false,
      },
      recyclerMany: (paths) => {
        recycled = true
        return { ok: true, recycled: paths.length, succeededPaths: [...paths] }
      },
    })

    const result = await tool.execute({ paths: [a, b] })

    expect(result.ok).toBe(false)
    expect(recycled).toBe(false)
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(true)
  })
})
