import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { describeTarget } from '../src/describe'
import { moveToSafeZone } from '../src/store'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-stage-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('safe zone move uses the caller-supplied description', () => {
  it('records the supplied bytes instead of re-measuring the target', async () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'hello')

    const stateDir = join(root, 'state')
    /*
     * 故意给一个**不等于真实大小**的 bytes。
     *
     * 真实大小是 5 字节；如果 `stageInto` 又自己调了一次 `describeTarget`，
     * 索引里就会记 5。只有它真的用了传入值，才会记 4242 —— 这就是
     * 「只描述一次」的行为证据，不需要 mock 模块。
     */
    const description = { ...describeTarget(file), bytes: 4242 }

    await moveToSafeZone(stateDir, file, {
      retentionDays: 1,
      now: Date.now(),
      description,
    })

    const index = JSON.parse(readFileSync(join(stateDir, 'index.json'), 'utf8')) as Array<{ bytes: number }>
    expect(index[0]?.bytes).toBe(4242)
  })

  it('still measures the target when no description is supplied', async () => {
    const file = join(root, 'b.txt')
    writeFileSync(file, 'hello')

    const stateDir = join(root, 'state2')
    await moveToSafeZone(stateDir, file, { retentionDays: 1, now: Date.now() })

    const index = JSON.parse(readFileSync(join(stateDir, 'index.json'), 'utf8')) as Array<{ bytes: number }>
    expect(index[0]?.bytes).toBe(5)
  })
})
