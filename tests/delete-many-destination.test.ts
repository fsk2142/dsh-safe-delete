import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTools } from '../src/tools'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-many-'))
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

/** 找到 safe_delete 工具定义。 */
function safeDelete(tools: ReturnType<typeof createTools>) {
  const tool = tools.find((t) => t.name === 'safe_delete')
  if (tool === undefined) throw new Error('safe_delete tool not found')
  return tool
}

describe('safe_delete with paths in recycle-bin mode', () => {
  it('hands every path to the recycler in a single call', async () => {
    const files = ['a.txt', 'b.txt', 'c.txt'].map((n) => {
      const p = join(root, n)
      writeFileSync(p, 'x')
      return p
    })
    const calls: string[][] = []

    const tool = safeDelete(
      createTools(
        deps({
          recyclerMany: (paths: readonly string[]) => {
            calls.push([...paths])
            return { ok: true, recycled: paths.length }
          },
        }) as never,
      ),
    )

    const result = (await tool.execute({ paths: files } as never)) as {
      ok: boolean
      text: string
    }

    expect(calls.length).toBe(1)
    expect(calls[0]).toHaveLength(3)
    expect(result.ok).toBe(true)
    expect(result.text).toMatch(/recycle bin/i)
  })

  it('skips the recursive walk for directory targets in recycle-bin mode', async () => {
    const dir = join(root, 'dir')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'deep.txt'), 'x')

    const tool = safeDelete(
      createTools(
        deps({
          recyclerMany: (paths: readonly string[]) => ({ ok: true, recycled: paths.length }),
        }) as never,
      ),
    )

    const result = (await tool.execute({ paths: [dir] } as never)) as { text: string }

    // 统计被跳过时不能声称「0 entries」—— 那是在谎报目标为空。
    expect(result.text).not.toMatch(/\b0 entries\b/)
  })

  it('falls back to the safe zone when the recycler fails', async () => {
    const file = join(root, 'd.txt')
    writeFileSync(file, 'x')

    const tool = safeDelete(
      createTools(
        deps({
          recyclerMany: () => ({ ok: false, reason: 'bin unavailable', recycled: 0 }),
        }) as never,
      ),
    )

    const result = (await tool.execute({ paths: [file] } as never)) as {
      ok: boolean
      text: string
    }

    expect(result.ok).toBe(true)
    expect(result.text).toMatch(/safe zone/i)
  })
})
