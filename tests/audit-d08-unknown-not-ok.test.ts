/*
 * D08：批量回收结果 `UNKNOWN` 时，工具仍返回 `ok: true`。
 *
 * ## 缺陷
 *
 * 回收脚本超时或异常时 `recycleManyToSystemBin` 返回
 * `{ ok: false, recycled: 0, reason }` —— **没有逐项清单**。`deleteMany`
 * 于是把全部目标归进 `unknownPlans`，然后走到 `return { ok: true, ... }`。
 *
 * 实测（注入 `recyclerMany: () => ({ ok: false, recycled: 0, reason: 'timeout' })`）：
 *
 * ```
 * ok = true
 * text: Outcome UNKNOWN (2) — check the recycle bin before retrying
 * ```
 *
 * 模型只看 `ok` 就会认为删成功了，继续往下做 —— 而文件可能还在原地，
 * 也可能已进回收站，谁都不知道。
 *
 * ## 修法
 *
 * `unknown > 0` 时 `ok` 必须是 `false`。文本里仍然保留"UNKNOWN"的明细，
 * 但**结构化字段不能撒谎**：`ok` 是模型判断的唯一依据。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createTools } from '../src/tools'

const roots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsd-d08-'))
  roots.push(dir)
  return dir
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

function makeTargets(count: number): { root: string; targets: string[] } {
  const root = scratch()
  const targets: string[] = []
  for (let i = 0; i < count; i += 1) {
    const p = path.join(root, `f${i}.bin`)
    writeFileSync(p, Buffer.alloc(16, 0x41))
    targets.push(p)
  }
  return { root, targets }
}

const env = (root: string) => ({ home: root, workdir: root, dshHome: root, safeZoneDir: path.join(root, 'state') })

describe('D08：结果不明时 ok 必须是 false', () => {
  it('reports failure when the recycler times out without per-path results', async () => {
    const { root, targets } = makeTargets(2)
    const stateDir = path.join(root, 'state')
    const tool = createTools({
      stateDir,
      env: env(root),
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      destination: 'recycle-bin',
      requestApproval: async () => 'allowed-once',
      recyclerMany: () => ({ ok: false, recycled: 0, reason: 'timeout' }),
    } as never).find((t) => t.name === 'safe_delete')

    const result = (await tool!.execute({ paths: targets } as never)) as { ok: boolean; text: string }

    expect(result.ok, '两项状态不明，不能报告成功').toBe(false)
    expect(result.text, '仍要告诉模型发生了什么').toMatch(/UNKNOWN/i)
  })

  it('reports partial success as a failure, not a success', async () => {
    const { root, targets } = makeTargets(2)
    const stateDir = path.join(root, 'state')
    const tool = createTools({
      stateDir,
      env: env(root),
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      destination: 'recycle-bin',
      requestApproval: async () => 'allowed-once',
      // 一条确定成功，另一条没在清单里 —— 状态不明。
      recyclerMany: (paths: string[]) => ({
        ok: true,
        recycled: 1,
        succeededPaths: [paths[0]],
        failedPaths: [],
      }),
    } as never).find((t) => t.name === 'safe_delete')

    const result = (await tool!.execute({ paths: targets } as never)) as { ok: boolean; text: string }
    expect(result.ok, '有一条状态不明，整体就不能算成功').toBe(false)
  })

  it('still reports success when every path is accounted for', async () => {
    const { root, targets } = makeTargets(2)
    const stateDir = path.join(root, 'state')
    const tool = createTools({
      stateDir,
      env: env(root),
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      destination: 'recycle-bin',
      requestApproval: async () => 'allowed-once',
      recyclerMany: (paths: string[]) => ({
        ok: true,
        recycled: paths.length,
        succeededPaths: [...paths],
        failedPaths: [],
      }),
    } as never).find((t) => t.name === 'safe_delete')

    const result = (await tool!.execute({ paths: targets } as never)) as { ok: boolean }
    expect(result.ok, '逐项都有结论时才是真的成功').toBe(true)
  })
})
