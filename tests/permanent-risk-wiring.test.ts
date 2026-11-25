import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools } from '../src/tools'
import { scratchDir } from './support/tmpdir'

describe('permanent-delete risk wiring', () => {
  it('the single-path route consults the injected risk reader', async () => {
    const root = scratchDir('dsd-risk-single-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    const file = join(work, 'a.txt')
    writeFileSync(file, 'x')
    let reads = 0
    let recycled = false

    const tool = createTools({
      stateDir: state,
      env: { home: root, workdir: work, dshHome: root, safeZoneDir: state, tmpdir: root },
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      destination: 'recycle-bin',
      permanentDeleteRisk: () => {
        reads += 1
        return { status: 'risky', risky: true, reason: 'policy permanently deletes' }
      },
      requestApproval: async () => 'rejected',
      recyclerMany: () => {
        recycled = true
        return { ok: true, recycled: 1 }
      },
    } as never).find((t) => t.name === 'safe_delete')!

    const result = await tool.execute({ path: file })

    expect(reads).toBe(1)
    expect(recycled).toBe(false)
    expect(existsSync(file)).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('the batch route consults the same injected risk reader', async () => {
    const root = scratchDir('dsd-risk-batch-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(work, { recursive: true })
    const a = join(work, 'a.txt')
    const b = join(work, 'b.txt')
    writeFileSync(a, 'x')
    writeFileSync(b, 'y')
    let reads = 0
    let recycled = false

    const tool = createTools({
      stateDir: state,
      env: { home: root, workdir: work, dshHome: root, safeZoneDir: state, tmpdir: root },
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      destination: 'recycle-bin',
      permanentDeleteRisk: () => {
        reads += 1
        return { status: 'risky', risky: true, reason: 'policy permanently deletes' }
      },
      requestApproval: async () => 'rejected',
      recyclerMany: () => {
        recycled = true
        return { ok: true, recycled: 2 }
      },
    } as never).find((t) => t.name === 'safe_delete')!

    const result = await tool.execute({ paths: [a, b] })

    expect(reads).toBe(1)
    expect(recycled).toBe(false)
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(true)
    expect(result.ok).toBe(false)
  })
})
