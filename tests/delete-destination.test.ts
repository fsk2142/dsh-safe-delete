import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deletePath } from '../src/delete-core'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-dest-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function ctx(overrides: Record<string, unknown> = {}) {
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
    now: () => Date.now(),
    requestApproval: async () => 'allowed-once',
    ...overrides,
  } as never
}

describe('deletePath with the recycle-bin destination', () => {
  it('recycles the real path without creating a safe zone entry', async () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'x')
    const calls: string[][] = []

    const result = await deletePath(
      { path: file },
      ctx({
        recycler: (paths: readonly string[]) => {
          calls.push([...paths])
          return { ok: true, recycled: paths.length }
        },
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.ok && result.kind).toBe('recycled')
    // 真实路径直接交给回收站，不经过暂存目录。
    expect(calls).toEqual([[file]])
  })

  it('falls back to the safe zone when recycling fails', async () => {
    const file = join(root, 'b.txt')
    writeFileSync(file, 'x')

    const result = await deletePath(
      { path: file },
      ctx({
        recycler: () => ({ ok: false, reason: 'bin unavailable', recycled: 0 }),
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.ok && result.kind).toBe('moved')
    expect(existsSync(file)).toBe(false)
  })

  it('abandons the delete when the user declines the permanent-delete warning', async () => {
    const file = join(root, 'c.txt')
    writeFileSync(file, 'x')
    let asked = ''
    let recycled = false

    const result = await deletePath(
      { path: file },
      ctx({
        permanentDeleteRisk: { risky: true, reason: 'NoRecycleFiles is enabled' },
        requestApproval: async (text: string) => {
          asked = text
          return 'rejected'
        },
        recycler: () => {
          recycled = true
          return { ok: true, recycled: 1 }
        },
      }),
    )

    expect(result.ok).toBe(false)
    expect(recycled).toBe(false)
    expect(existsSync(file)).toBe(true)
    expect(asked).toMatch(/permanent/i)
  })

  it('recycles after the user accepts the permanent-delete warning', async () => {
    const file = join(root, 'd.txt')
    writeFileSync(file, 'x')
    let recycled = false

    const result = await deletePath(
      { path: file },
      ctx({
        permanentDeleteRisk: { risky: true, reason: 'NoRecycleFiles is enabled' },
        recycler: () => {
          recycled = true
          return { ok: true, recycled: 1 }
        },
      }),
    )

    expect(recycled).toBe(true)
    expect(result.ok && result.kind).toBe('recycled')
  })

  it('still uses the safe zone by default', async () => {
    const file = join(root, 'e.txt')
    writeFileSync(file, 'x')
    let recycled = false

    const result = await deletePath(
      { path: file },
      ctx({
        destination: 'safe-zone',
        recycler: () => {
          recycled = true
          return { ok: true, recycled: 1 }
        },
      }),
    )

    expect(recycled).toBe(false)
    expect(result.ok && result.kind).toBe('moved')
  })
})
