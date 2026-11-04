import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { decideGate, deletePath, type DeleteContext } from '../src/delete-core'
import { listSafeZone, restoreFromSafeZone } from '../src/store'
const workspace = 'C:/Users/FSK/Documents/Codex/2026-11-01/c-work-dsh-plug-in-dsh-3/work'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(workspace, { recursive: true })
  const root = mkdtempSync(join(workspace, 'nov4-storage-'))
  roots.push(root)
  const stateDir = join(root, 'parent', 'state')
  const workdir = join(root, 'work')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(workdir)
  const recycler = vi.fn(() => ({ ok: true as const, recycled: 1 }))
  const ctx: DeleteContext = {
    stateDir, env: { home: join(root, 'home'), workdir, dshHome: join(root, 'dsh'), safeZoneDir: stateDir, tmpdir: join(root, 'tmp') },
    retentionDays: 7, confirmFileCount: 0, confirmBytes: 0,
    now: () => Date.now(), requestApproval: async () => 'allowed-once', recycler,
  }
  return { root, ctx, recycler, workdir }
}
it('refuses recycling an ancestor that contains the safe zone', async () => {
  const { root, ctx, recycler } = fixture()
  const result = await deletePath({ path: join(root, 'parent') }, { ...ctx, destination: 'recycle-bin' })
  expect(result.ok).toBe(false)
  expect(recycler).not.toHaveBeenCalled()
})
it('deletes and restores a dangling directory junction without touching its target', async () => {
  const { root, ctx, workdir } = fixture()
  const target = join(root, 'missing-target')
  const link = join(workdir, 'dangling')
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await deletePath({ path: link }, ctx)
  expect(result.ok).toBe(true)
  expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
  const entries = await listSafeZone(ctx.stateDir)
  expect(entries).toHaveLength(1)
  const restored = await restoreFromSafeZone(ctx.stateDir, entries[0]!.id)
  expect(restored.restoredTo).toBe(link)
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(existsSync(target)).toBe(false)
})

it('requires approval when target statistics are incomplete even when size gates are disabled', () => {
  const { ctx, workdir } = fixture()
  const description = { exists: true, isDirectory: true, bytes: 0, fileCount: 0, topEntries: [], truncated: false, statsIncomplete: true }
  const gate = decideGate(join(workdir, 'unreadable-tree'), description, ctx)
  expect(gate.needsApproval).toBe(true)
  expect(gate.reasons.join(' ')).toMatch(/incomplete/i)
})