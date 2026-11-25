import { describe, expect, it } from 'vitest'
import { lstatSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { pruneNowForWorker } from '../src/cleanup-run'
import { moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

describe('cleanup byte measurement does not follow links', { timeout: 30_000 }, () => {
  it('measures only the staged entry, not a junction target outside it', async () => {
    const root = scratchDir('dsd-cleanup-link-')
    const work = join(root, 'work')
    const state = join(root, 'state')
    const outside = join(root, 'outside')
    const source = join(work, 'entry')
    mkdirSync(work, { recursive: true })
    mkdirSync(outside, { recursive: true })
    mkdirSync(source, { recursive: true })

    writeFileSync(join(source, 'local.txt'), '123')
    writeFileSync(join(outside, 'outside.bin'), Buffer.alloc(4096, 0x78))
    const link = join(source, 'external')
    symlinkSync(outside, link, 'junction')
    const linkBytes = lstatSync(link).size

    await moveToSafeZone(state, source, {
      retentionDays: 1,
      now: Date.now() - 10 * 86_400_000,
    })

    let measuredBytes: number | undefined
    const fakeBin = join(root, 'fake-bin')
    mkdirSync(fakeBin)
    let seq = 0
    const result = await pruneNowForWorker(
      state,
      10,
      (batchPath) => {
        seq += 1
        renameSync(batchPath, join(fakeBin, `batch-${seq}`))
        return { ok: true }
      },
      () => Date.now(),
      'expired',
      {
        detectPermanentDeleteRisk: () => ({ status: 'safe', risky: false }),
        assessQuota: (bytes) => {
          measuredBytes = bytes
          return { status: 'within' }
        },
      },
    )

    expect(result.recycled).toBe(1)
    expect(measuredBytes, 'junction 外部内容不属于这批，不能计入配额').toBe(3 + linkBytes)
  })
})
