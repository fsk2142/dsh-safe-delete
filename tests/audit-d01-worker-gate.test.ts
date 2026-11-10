/*
 * D01：后台自动清理（Worker）在不检查系统策略和配额的情况下调用回收站。
 *
 * ## 缺陷
 *
 * `safe_delete` 进回收站前会调 `detectPermanentDeleteRisk`（NoRecycleFiles /
 * NukeOnDelete）与 `assessQuota`（每卷容量），命中就弹审批。
 *
 * 而安全区条目**到期之后**由后台 Worker 送进回收站，那条路径**完全不查**这两组
 * 检测（`cleanup-run.ts` 里 grep 不到任何一个）。后果：用户以为"安全区到期后还有
 * 系统回收站这层保险"，实际在 `NukeOnDelete=1` 或配额不足的机器上，Worker 会在
 * 无人值守的深夜把内容永久删掉。
 *
 * ## 修法
 *
 * Worker 在真正调用 recycler **之前**加一道闸门：能证明「可恢复」才回收，
 * 否则留在安全区、记 blocked 原因。保守方向与直接删除入口一致：
 * `unknown` 不当作 `safe`。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { pruneNowForWorker } from '../src/cleanup-run'
import { moveToSafeZone } from '../src/store'

const roots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsd-d01-'))
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

/** 造一个安全区条目：文件移入安全区，返回 stateDir 与 id。 */
async function stageEntry(stateDir: string, name: string): Promise<string> {
  const src = path.join(stateDir, '..', name)
  mkdirSync(path.dirname(src), { recursive: true })
  writeFileSync(src, Buffer.alloc(64, 0x41))
  const entry = await moveToSafeZone(stateDir, src, { retentionDays: 1, now: 0 })
  return entry.id
}

/**
 * 跑一轮 Worker，把 recycler 与风险检测都换成替身。
 *
 * @param gate 风险检测的返回值。
 * @returns recycler 是否被调用，以及结果。
 */
async function runWorker(options: {
  recycleRisk?: 'safe' | 'risky' | 'unknown'
  quota?: 'within' | 'over' | 'unknown'
}) {
  const root = scratch()
  const stateDir = path.join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  await stageEntry(stateDir, 'victim.bin')

  let recyclerCalls = 0
  const result = await pruneNowForWorker(
    stateDir,
    10,
    (batchPath) => {
      recyclerCalls += 1
      /*
       * 模拟"真的回收成功"：内容必须从批次目录消失。
       *
       * 生产代码在 `ok:true` 之后还会核实"批次目录真的空了"，否则按
       * "报告成功但内容还在" 回滚 —— 那是正确处理，但不该由这条测试去验。
       */
      rmSync(batchPath, { recursive: true, force: true })
      return { ok: true }
    },
    () => 1_000_000_000_000, // 时间推远，让条目过期
    'expired',
    {
      // 与生产接线一致：返回三态「永久删除风险」结论。
      detectPermanentDeleteRisk: () => {
        const status = options.recycleRisk ?? 'safe'
        return { status, risky: status === 'risky', reason: status === 'safe' ? undefined : 'test double' }
      },
      assessQuota: () => {
        const status = options.quota ?? 'within'
        return { status, ...(status === 'within' ? {} : { reason: 'test double' }) }
      },
    },
  )
  return { recyclerCalls, result, stateDir }
}

describe('D01：Worker 必须在调用回收站前检查策略与配额', () => {
  it('recycles when both checks prove it is recoverable', async () => {
    const { recyclerCalls, result } = await runWorker({})
    expect(recyclerCalls, '确认可恢复时就该回收').toBe(1)
    expect(result.recycled).toBe(1)
  })

  it('does not touch the system API when the policy deletes permanently', async () => {
    const { recyclerCalls, result } = await runWorker({ recycleRisk: 'risky' })
    expect(recyclerCalls, '策略命中时绝不能调用回收站').toBe(0)
    expect(result.recycled).toBe(0)
    expect(result.skipped, '数据必须留在安全区').toBe(1)
  })

  it('does not touch the system API when the policy cannot be read', async () => {
    const { recyclerCalls, result } = await runWorker({ recycleRisk: 'unknown' })
    expect(recyclerCalls, 'unknown 不是 safe').toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('does not touch the system API when the quota is exceeded', async () => {
    const { recyclerCalls, result } = await runWorker({ quota: 'over' })
    expect(recyclerCalls, '配额不足时回收站会永久删除').toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('does not touch the system API when the quota cannot be read', async () => {
    const { recyclerCalls, result } = await runWorker({ quota: 'unknown' })
    expect(recyclerCalls).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('keeps the entry restorable after a blocked round', async () => {
    const { stateDir } = await runWorker({ recycleRisk: 'risky' })
    const { listSafeZone } = await import('../src/store')
    const entries = await listSafeZone(stateDir)
    expect(entries.length, '被拦下的条目必须还在安全区').toBe(1)
  })

  it('reports why the round was blocked', async () => {
    const { result } = await runWorker({ recycleRisk: 'risky' })
    expect(result.blockedReason, '无人值守的跳过必须留下原因').toBeTruthy()
  })
})
