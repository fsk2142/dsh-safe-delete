/*
 * 自检发现的三个遗漏（2026-11-04 自检）。
 *
 * 这三个都是「修审查时只修了单路径 / 只修了审批卡」留下的同类错误。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTools } from '../src/tools'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-self-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function base(overrides: Record<string, unknown> = {}) {
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
    recyclerMany: (paths: readonly string[]) => ({ ok: true, recycled: paths.length }),
    ...overrides,
  }
}

function safeDelete(overrides: Record<string, unknown> = {}) {
  const tool = createTools(base(overrides) as never).find((t) => t.name === 'safe_delete')
  if (tool === undefined) throw new Error('safe_delete not found')
  return tool
}

describe('batch preview in recycle mode', () => {
  it('does not claim 0 entries for a directory whose contents were not measured', async () => {
    const dir = join(root, 'dir')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'deep.txt'), 'x')

    const tool = safeDelete()
    const result = (await tool.execute({ paths: [dir], preview: true } as never)) as {
      ok: boolean
      text: string
    }

    // 统计被跳过时旧文案会打印「dir, 0 entries, 0 B」——谎报目录为空。
    expect(result.text).not.toMatch(/0 entries/)
    expect(result.text).toMatch(/top-level entries/)
  })
})

describe('batch quota check wiring', () => {
  it('consults the quota risk inside deleteMany too', () => {
    /*
     * 静态断言：造一个真超过 50 GB 的文件代价太大，而这里的缺陷形态就是
     * 「某一侧忘了调用」，静态断言正好覆盖。
     */
    const src = readFileSync('src/tools.ts', 'utf8')
    const manyStart = src.indexOf('async function deleteMany')
    expect(manyStart).toBeGreaterThan(-1)
    expect(src.slice(manyStart)).toMatch(/detectQuotaRisk/)
  })
})

describe('confirm thresholds in recycle mode', () => {
  it('does not fire confirmBytes for a single big file', async () => {
    const file = join(root, 'big.bin')
    writeFileSync(file, Buffer.alloc(4096))

    let asked = false
    const tool = safeDelete({
      confirmBytes: 1,
      requestApproval: async () => {
        asked = true
        return 'allowed-once'
      },
    })

    await tool.execute({ path: file } as never)

    // 回收站模式下两个阈值都失效 —— 用户明确选了这个取舍。
    expect(asked).toBe(false)
  })

  it('still fires confirmBytes in safe-zone mode', async () => {
    const file = join(root, 'big2.bin')
    writeFileSync(file, Buffer.alloc(4096))

    let asked = false
    const tool = safeDelete({
      destination: 'safe-zone',
      confirmBytes: 1,
      requestApproval: async () => {
        asked = true
        return 'allowed-once'
      },
    })

    await tool.execute({ path: file } as never)

    expect(asked).toBe(true)
  })
})
