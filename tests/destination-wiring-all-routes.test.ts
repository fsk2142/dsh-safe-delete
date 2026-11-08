/*
 * `deleteDestination` 必须在**每一条**删除通道上生效（2026-11-08）。
 *
 * ## 缺陷一：斜杠命令与 CLI 静默忽略这个设置
 *
 * `commandAdapter.delete`（`src/index.ts`）和 `bin/dsh-safe-delete.mjs` 都调
 * `deletePath`，但**都没有传 `destination`**。它在那两个地方是可选的，缺省
 * `safe-zone` —— 于是用户把设置改成 `recycle-bin` 之后：
 *
 * ```text
 * safe_delete 工具     → 进回收站  ✅
 * /safe-delete <路径>  → 进安全区  ❌ 该进回收站
 * CLI delete <路径>    → 进安全区  ❌ 该进回收站
 * ```
 *
 * 更糟的是预览文案读的是**真实配置**，所以它会说「会直接移入系统回收站」，
 * 而实际执行却进了安全区 —— 承诺与行为相反。
 *
 * ## 缺陷二：回收站模式下目录一律 needing approval
 *
 * `deletePath` 与 `deleteMany` 都用 `assessQuota(bytes, { sizeIsLowerBound })`
 * 判配额。回收站模式只量顶层，所以目录恒为 `unknown` → 要审批。CLI 的
 * `requestApproval` 恒 `rejected`，于是**CLI 删不了任何目录**，哪怕它只有
 * 几 MB、而回收站上限有几十 GB。
 *
 * 修法与钩子层一致：下界不足以判定时做一次有界早退枚举。
 */
import { readFileSync } from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deletePath } from '../src/delete-core'
import { createSharedMeasure } from '../src/describe'
import { resetQuotaCache } from '../src/recycle'

const roots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsd-dest-'))
  roots.push(dir)
  return dir
}

function writeSized(file: string, bytes: number): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.alloc(bytes, 0x41))
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  }
})

beforeEach(() => {
  resetQuotaCache()
})

describe('配置接线：每条通道都必须把 destination 传下去', () => {
  it('the slash command adapter forwards the configured destination', () => {
    const src = readFileSync('src/index.ts', 'utf8')
    const start = src.indexOf('const commandAdapter')
    expect(start, '应能找到 commandAdapter').toBeGreaterThan(0)
    const block = src.slice(start, start + 2000)
    expect(block, 'commandAdapter 必须传 destination，否则它永远走安全区').toMatch(
      /destination:\s*normalizeDestination\(unwrap\(raw\['deleteDestination'\]\)\)/,
    )
  })

  it('the CLI forwards the configured destination', () => {
    const src = readFileSync('bin/dsh-safe-delete.mjs', 'utf8')
    const start = src.indexOf("case 'delete'")
    expect(start, '应能找到 CLI 的 delete 分支').toBeGreaterThan(0)
    const block = src.slice(start, start + 3000)
    expect(block, 'CLI 必须传 destination，否则它永远走安全区').toMatch(/destination/)
  })

  it('the CLI reads deleteDestination from the profile patch', () => {
    const src = readFileSync('bin/dsh-safe-delete.mjs', 'utf8')
    expect(src, '配置读取必须包含 deleteDestination').toMatch(/deleteDestination/)
  })
})

describe('回收站模式 + 目录：有界枚举之后可以真的删掉', () => {
  it('a directory that provably fits is not sent to approval', async () => {
    const root = scratch()
    const target = path.join(root, 'build')
    writeSized(path.join(target, 'a.dcp'), 1024)
    writeSized(path.join(target, 'deep', 'b.dcp'), 2048)

    let asked = 0
    const result = await deletePath({ path: target }, {
      stateDir: path.join(root, 'state'),
      env: { home: root, workdir: root, dshHome: root, safeZoneDir: path.join(root, 'state') },
      retentionDays: 1,
      destination: 'recycle-bin',
      confirmFileCount: 0,
      confirmBytes: 0,
      requestApproval: async () => {
        asked += 1
        return 'rejected'
      },
      // 测试替身：真实回收站会污染系统回收站。
      recycler: (paths) => ({ ok: true, recycled: paths.length, succeededPaths: [...paths], failedPaths: [] }),
      now: () => Date.now(),
    })

    expect(result.ok, '几 MB 的目录对着几十 GB 的上限，不该被拒').toBe(true)
    expect(asked, '有界枚举已证明放得下，不该再问').toBe(0)
  })

  it('a directory that provably exceeds the limit still needs approval', async () => {
    const root = scratch()
    const target = path.join(root, 'huge')
    writeSized(path.join(target, 'big.dcp'), 4096)

    let asked = 0
    const result = await deletePath({ path: target }, {
      stateDir: path.join(root, 'state'),
      env: { home: root, workdir: root, dshHome: root, safeZoneDir: path.join(root, 'state') },
      retentionDays: 1,
      destination: 'recycle-bin',
      confirmFileCount: 0,
      confirmBytes: 0,
      // 上限压到 1 KB：那棵树的确超了。
      measureBounded: () => ({ kind: 'over', bytes: 8192 }),
      requestApproval: async () => {
        asked += 1
        return 'rejected'
      },
      recycler: (paths) => ({ ok: true, recycled: paths.length, succeededPaths: [...paths], failedPaths: [] }),
      now: () => Date.now(),
    })

    expect(asked, '真的超了，必须问').toBe(1)
    expect(result.ok, '用户拒绝之后不能删').toBe(false)
  })

  it('an unmeasurable directory stays at the conservative default', async () => {
    const root = scratch()
    const target = path.join(root, 'unreadable')
    writeSized(path.join(target, 'a.bin'), 10)

    let asked = 0
    await deletePath({ path: target }, {
      stateDir: path.join(root, 'state'),
      env: { home: root, workdir: root, dshHome: root, safeZoneDir: path.join(root, 'state') },
      retentionDays: 1,
      destination: 'recycle-bin',
      confirmFileCount: 0,
      confirmBytes: 0,
      measureBounded: () => ({ kind: 'incomplete', reason: 'access denied' }),
      requestApproval: async () => {
        asked += 1
        return 'allowed-once'
      },
      recycler: (paths) => ({ ok: true, recycled: paths.length, succeededPaths: [...paths], failedPaths: [] }),
      now: () => Date.now(),
    })

    expect(asked, '测量不出来就不能当成安全').toBe(1)
  })

  it('does not pay for a measurement when the destination is the safe zone', async () => {
    const root = scratch()
    const target = path.join(root, 'dir')
    writeSized(path.join(target, 'a.bin'), 10)

    let measured = 0
    await deletePath({ path: target }, {
      stateDir: path.join(root, 'state'),
      env: { home: root, workdir: root, dshHome: root, safeZoneDir: path.join(root, 'state') },
      retentionDays: 1,
      destination: 'safe-zone',
      confirmFileCount: 0,
      confirmBytes: 0,
      measureBounded: () => {
        measured += 1
        return { kind: 'exact', bytes: 10 }
      },
      requestApproval: async () => 'allowed-once',
      now: () => Date.now(),
    })

    // 安全区模式已经做了全树统计，没有「下界」问题。
    expect(measured).toBe(0)
  })
})

describe('createSharedMeasure 属于 describe，不再困在 index 里', () => {
  it('is importable without pulling the plugin entrypoint', () => {
    const measure = createSharedMeasure(1000)
    const result = measure(path.join(scratch(), 'missing'), 1024)
    expect(result.kind).toBe('incomplete')
  })
})
