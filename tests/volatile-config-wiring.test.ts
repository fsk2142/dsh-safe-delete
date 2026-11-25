import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const requestCleanup = vi.hoisted(() =>
  vi.fn(async (_opts: { stateDir: string; mode?: string; limit?: number }) => ({ started: true })),
)

vi.mock('../src/cleanup', async () => {
  const actual = await vi.importActual<typeof import('../src/cleanup')>('../src/cleanup')
  return { ...actual, requestCleanup }
})

const { apply } = await import('../src/index')
const { moveToSafeZone } = await import('../src/store')
const { scratchDir } = await import('./support/tmpdir')

describe('volatile config updates are wired to the running plugin', () => {
  it('runs a new clean request without remounting the plugin', async () => {
    requestCleanup.mockClear()
    const root = scratchDir('dsd-volatile-clean-')
    const stateDir = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work)
    const file = join(work, 'a.txt')
    writeFileSync(file, 'x')
    await moveToSafeZone(stateDir, file, { retentionDays: 7 })

    const listeners = new Map<string, (payload: unknown) => void>()
    const raw: Record<string, unknown> = { stateDir, cleanRequestedAt: 0, autoPrune: false }
    const ctx = {
      get: (id: string) => id === 'tools' ? { register: () => () => {} } : undefined,
      on: (event: string, handler: (payload: unknown) => void) => {
        listeners.set(event, handler)
        return () => {}
      },
      effect: (fn: () => unknown) => { fn(); return () => {} },
      inject: (_services: string[], cb: (scoped: unknown) => void) => { cb({}); return () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }
    apply(ctx as never, raw as never)
    expect(requestCleanup).not.toHaveBeenCalled()

    raw['cleanRequestedAt'] = Date.now()
    listeners.get('loader/volatile-update')?.(['cleanRequestedAt'])
    // 监听器是 `void maybeRunRequestedClean(...)`：等它真正跑完再断言。
    await vi.waitFor(() => expect(requestCleanup).toHaveBeenCalledTimes(1))
    expect(requestCleanup.mock.calls[0]?.[0]).toMatchObject({ stateDir, mode: 'all' })
  })
})
