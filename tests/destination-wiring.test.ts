import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTools } from '../src/tools'

/*
 * 这条测的是**接线**，不是逻辑：配置里的 `deleteDestination` 必须真的流到
 * 工具依赖里。没有它，用户在设置页点的按钮毫无效果，而单元测试全绿 ——
 * 这正是「只在文档里存在的开关」那种缺陷。
 */
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-wire-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('delete destination wiring', () => {
  it('recycle-bin in the dependency set makes safe_delete recycle', async () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'x')
    const calls: string[][] = []

    const tool = createTools({
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
      recyclerMany: (paths: readonly string[]) => {
        calls.push([...paths])
        return { ok: true, recycled: paths.length }
      },
    } as never).find((t) => t.name === 'safe_delete')!

    const result = (await tool.execute({ path: file } as never)) as { ok: boolean; text: string }

    expect(calls).toEqual([[file]])
    expect(result.text).toMatch(/recycle bin/i)
  })

  it('safe-zone in the dependency set keeps the default path', async () => {
    const file = join(root, 'b.txt')
    writeFileSync(file, 'x')
    let recycled = false

    const tool = createTools({
      stateDir: join(root, 'state2'),
      env: {
        home: join(root, 'home'),
        workdir: join(root, 'work'),
        dshHome: join(root, 'home', '.dsh'),
        safeZoneDir: join(root, 'state2'),
        tmpdir: join(root, 'not-the-temp'),
      },
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      crossVolumeCopy: false,
      destination: 'safe-zone',
      requestApproval: async () => 'allowed-once',
      recyclerMany: () => {
        recycled = true
        return { ok: true, recycled: 1 }
      },
    } as never).find((t) => t.name === 'safe_delete')!

    const result = (await tool.execute({ path: file } as never)) as { ok: boolean; text: string }

    expect(recycled).toBe(false)
    expect(result.text).toMatch(/safe zone/i)
  })
})
