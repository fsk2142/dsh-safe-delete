/*
 * R24-2 / R24-3 回归（2026-11-04 第 24 次审查）。
 *
 * ## R24-2
 *
 * `recycleManyToSystemBin` 在部分成功时返回 `{ ok:true, recycled, failed }`，
 * 但上一版没有任何调用方读 `failed` —— 99 条成功 + 1 条失败会把 **100 条**
 * 都写进审计并上报成功。
 *
 * ## R24-3
 *
 * README 承诺「回收站模式下条目数/大小确认不生效」，但上一版只有单路径
 * `deletePath` 归零阈值；批量路径与 pre-execute 钩子仍用原始阈值。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTools } from '../src/tools'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-r24-'))
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

describe('R24-2 部分成功时审计与输出要区分', () => {
  it('失败的条目不该被记成已删除', async () => {
    const files = ['ok1.txt', 'bad.txt', 'ok2.txt'].map((n) => {
      const p = join(root, n)
      writeFileSync(p, 'x')
      return p
    })

    const tool = createTools(
      deps({
        recyclerMany: (paths: readonly string[]) => ({
          ok: true,
          recycled: paths.length - 1,
          failed: [`${files[1]} : denied`],
        }),
      }) as never,
    ).find((t) => t.name === 'safe_delete')!

    const result = (await tool.execute({ paths: files } as never)) as { ok: boolean; text: string }

    // 失败的条目必须在输出里被点名
    expect(result.text).toMatch(/bad\.txt/)
    expect(result.text, '不能把失败的说成 success').toMatch(/Not recycled|not recycled/i)
  })
})

describe('R24-3 回收站模式下批量阈值不生效', () => {
  it('批量删几千个条目不因 confirmFileCount 弹卡', async () => {
    /*
     * 造 3 个文件，但把阈值设成 1 —— 安全区模式会弹，回收站模式不该弹。
     */
    const files = ['a.txt', 'b.txt', 'c.txt'].map((n) => {
      const p = join(root, n)
      writeFileSync(p, 'x')
      return p
    })

    let asked = false
    const tool = createTools(
      deps({
        confirmFileCount: 1,
        requestApproval: async () => {
          asked = true
          return 'allowed-once'
        },
        recyclerMany: (paths: readonly string[]) => ({ ok: true, recycled: paths.length }),
      }) as never,
    ).find((t) => t.name === 'safe_delete')!

    await tool.execute({ paths: files } as never)

    expect(asked, '回收站模式下 confirmFileCount 应失效').toBe(false)
  })

  it('安全区模式下同一个阈值仍然生效', async () => {
    const files = ['a.txt', 'b.txt', 'c.txt'].map((n) => {
      const p = join(root, n)
      writeFileSync(p, 'x')
      return p
    })

    let asked = false
    const tool = createTools(
      deps({
        destination: 'safe-zone',
        confirmFileCount: 1,
        requestApproval: async () => {
          asked = true
          return 'allowed-once'
        },
      }) as never,
    ).find((t) => t.name === 'safe_delete')!

    await tool.execute({ paths: files } as never)

    expect(asked, '安全区模式下阈值必须仍然生效').toBe(true)
  })
})

describe('R24-3 钩子代码按目的地归零', () => {
  it('钩子的两处阈值都看 destination', () => {
    const src = readFileSync('src/index.ts', 'utf8')
    // 单条 gate
    expect(src).toMatch(/confirmFileCount: recycleMode \? 0 :/)
    expect(src).toMatch(/confirmBytes: recycleMode \? 0 :/)
    // 合计阈值
    expect(src).toMatch(/const countLimit = recycleMode \? 0 :/)
    expect(src).toMatch(/const bytesLimit = recycleMode \? 0 :/)
  })
})
