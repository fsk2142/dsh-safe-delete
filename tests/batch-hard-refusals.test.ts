import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTools } from '../src/tools'

/*
 * 硬拒绝必须在**批量路径**上也生效。
 *
 * ## 为什么这条测试重要（2026-11-04 审查 Important-4）
 *
 * `isDriveRoot` / `isInsideStateDir` 原来只在 `deletePath` 里。批量走
 * `deleteMany`，两条都没有；而回收站分支又跳过了 `stageInto` 自带的自保护。
 *
 * 后果：`paths: [stateDir]` 在改前会被逐条拒绝，改后只要一次审批就能把
 * **安全区自己**（旧删除的唯一副本）送进回收站。这是数据丢失级别的回归。
 */
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-guard-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function deps(overrides: Record<string, unknown> = {}) {
  return {
    stateDir: join(root, 'state'),
    env: {
      home: join(root, 'home'),
      workdir: join(root, 'work'),
      dshHome: join(root, 'home', '.dsh'),
      safeZoneDir: join(root, 'state'),
      tmpdir: join(root, 'not-the-temp'),
    },
    retentionDays: 1,
    confirmFileCount: 0,
    confirmBytes: 0,
    crossVolumeCopy: false,
    destination: 'recycle-bin',
    requestApproval: async () => 'allowed-once',
    ...overrides,
  }
}

function safeDelete(overrides: Record<string, unknown> = {}) {
  const tools = createTools(deps(overrides) as never)
  const tool = tools.find((t) => t.name === 'safe_delete')
  if (tool === undefined) throw new Error('safe_delete not found')
  return tool
}

describe('hard refusals on the batch route', () => {
  it('refuses to recycle the safe zone itself', async () => {
    const stateDir = join(root, 'state')
    const calls: string[][] = []

    const tool = safeDelete({
      stateDir,
      recyclerMany: (paths: readonly string[]) => {
        calls.push([...paths])
        return { ok: true, recycled: paths.length }
      },
    })

    const result = (await tool.execute({ paths: [stateDir] } as never)) as { ok: boolean; text: string; error?: string }

    // 一个文件都不许进回收站。
    expect(calls).toEqual([])
    expect(result.ok).toBe(false)
    expect(`${result.text}${result.error ?? ''}`).toMatch(/safe zone/i)
  })

  it('refuses to recycle a path inside the safe zone', async () => {
    const stateDir = join(root, 'state')
    const inner = join(stateDir, 'items', 'x')
    const calls: string[][] = []

    const tool = safeDelete({
      stateDir,
      recyclerMany: (paths: readonly string[]) => {
        calls.push([...paths])
        return { ok: true, recycled: paths.length }
      },
    })

    const result = (await tool.execute({ paths: [inner] } as never)) as { ok: boolean; text: string; error?: string }

    expect(calls).toEqual([])
    expect(result.ok).toBe(false)
  })

  it('refuses to recycle a filesystem root', async () => {
    const calls: string[][] = []
    const tool = safeDelete({
      recyclerMany: (paths: readonly string[]) => {
        calls.push([...paths])
        return { ok: true, recycled: paths.length }
      },
    })

    const result = (await tool.execute({ paths: ['C:\\'] } as never)) as { ok: boolean; text: string; error?: string }

    expect(calls).toEqual([])
    expect(result.ok).toBe(false)
    expect(`${result.text}${result.error ?? ''}`).toMatch(/root/i)
  })

  it('still allows an ordinary file in the same batch as a refused path', async () => {
    const stateDir = join(root, 'state')
    const good = join(root, 'ok.txt')
    writeFileSync(good, 'x')
    const calls: string[][] = []

    const tool = safeDelete({
      stateDir,
      recyclerMany: (paths: readonly string[]) => {
        calls.push([...paths])
        return { ok: true, recycled: paths.length }
      },
    })

    await tool.execute({ paths: [stateDir, good] } as never)

    // 被拒的那条不进回收站，正常的照常处理。
    expect(calls).toEqual([[good]])
  })
})
