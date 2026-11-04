import { afterEach, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { moveToSafeZone } from '../src/store'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    renameSync(from: string, to: string) {
      if (to.endsWith('index.json')) throw new Error('injected index write failure')
      actual.renameSync(from, to)
    },
  }
})
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('rolls a dangling junction back to its original location when the index write fails', async () => {
  const workspace = 'C:/Users/FSK/Documents/Codex/2026-11-01/c-work-dsh-plug-in-dsh-3/work'
  mkdirSync(workspace, { recursive: true })
  const root = mkdtempSync(join(workspace, 'nov4-storage-rollback-'))
  roots.push(root)
  const state = join(root, 'state')
  const link = join(root, 'dangling')
  symlinkSync(join(root, 'missing-target'), link, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(moveToSafeZone(state, link, {
    retentionDays: 7,
    description: { exists: true, isDirectory: false, bytes: 0, fileCount: 1, topEntries: [], truncated: false },
  })).rejects.toThrow('injected index write failure')
  expect(lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true)
  expect(readdirSync(join(state, 'items'))).toEqual([])
})
