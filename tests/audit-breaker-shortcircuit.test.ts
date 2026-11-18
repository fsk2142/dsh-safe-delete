/*
 * 2026-11-18：熔断短路时，工具把整批判成 UNKNOWN，而且**丢掉了原因**。
 *
 * ## 用户看到的
 *
 * ```
 * Outcome UNKNOWN (122) — check the recycle bin before retrying
 * Moved 0 item(s) to the system recycle bin.
 * ```
 *
 * 审计里是 `outcome=UNKNOWN (the shell did not report this path)`。
 *
 * 真相是：`recycleManyToSystemBin` 因为熔断**根本没有调用 shell**，它返回的
 * `reason` 明写着 "recycle bin unavailable after 3 consecutive failures"。
 * 但 `tools.ts` 把它扔掉了 —— 于是用户去查回收站容量、权限、junction，
 * 查的全是无关的地方。
 *
 * ## 正确行为
 *
 * 短路是**确定没做**，不是 unknown。按既有的「回收失败回落安全区」设计：
 * 内容进安全区（可恢复），并且输出必须说清是熔断、不是"shell 没回报路径"。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  recordRecycleFailure,
  recycleBreakerThreshold,
  recycleManyToSystemBin,
  resetRecycleBreaker,
} from '../src/recycle'
import { createTools } from '../src/tools'

describe('熔断短路必须说清原因，而不是报 unknown', { timeout: 30_000 }, () => {
  beforeEach(() => {
    resetRecycleBreaker()
  })

  it('marks the short-circuit as not-attempted and keeps the reason', async () => {
    const threshold = recycleBreakerThreshold()
    for (let i = 0; i < threshold; i += 1) recordRecycleFailure()

    const dir = mkdtempSync(path.join(tmpdir(), 'dsd-short-'))
    const a = path.join(dir, 'a.txt')
    const b = path.join(dir, 'b.txt')
    writeFileSync(a, 'x')
    writeFileSync(b, 'y')

    const outcome = await recycleManyToSystemBin([a, b])

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.notAttempted, '短路不等于"shell 没回报路径"').toBe(true)
    expect(outcome.skippedByBreaker).toBe(true)
    expect(outcome.reason, '原因必须保留').toMatch(/consecutive failures/i)
    expect(outcome.reason, '必须说清会自动重试').toMatch(/retry|retrying/i)
    expect(outcome.recycled).toBe(0)
  })

  it('explains the breaker instead of claiming UNKNOWN, and still cleans up', async () => {
    const threshold = recycleBreakerThreshold()
    for (let i = 0; i < threshold; i += 1) recordRecycleFailure()

    const dir = mkdtempSync(path.join(tmpdir(), 'dsd-short-tool-'))
    const stateDir = path.join(dir, 'state')
    const targets: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const p = path.join(dir, `f${i}.txt`)
      writeFileSync(p, 'x')
      targets.push(p)
    }

    const tool = createTools({
      stateDir,
      env: { home: dir, workdir: dir, dshHome: dir, safeZoneDir: stateDir },
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      destination: 'recycle-bin',
      requestApproval: async () => 'allowed-once',
      now: () => Date.now(),
    } as never).find((t) => t.name === 'safe_delete')

    const result = (await tool!.execute({ paths: targets } as never)) as { ok: boolean; text: string }

    /*
     * 这一次的判据是**用户能不能看懂发生了什么**，而不是某个布尔：
     *
     * - 不能说 "UNKNOWN"（那会让人去查容量/权限/junction）；
     * - 必须写出熔断与自动重试；
     * - 必须说清这四条去了哪里。
     */
    expect(result.text, '不该再让用户以为"shell 没回报路径"').not.toMatch(/UNKNOWN/i)
    expect(result.text, '必须给出真实原因').toMatch(/consecutive failures|recycle bin unavailable/i)
    expect(result.text, '必须给出下一步').toMatch(/retry|retrying|restart/i)

    /*
     * 既有的「回收失败回落安全区」设计在这里照常生效：四条应已离开原路径，
     * 并且可恢复。若回落也失败（例如安全区不可写），则必须 `ok:false`。
     */
    const stillPresent = targets.filter((t) => existsSync(t))
    if (stillPresent.length === 0) {
      expect(result.ok, '全部进了安全区（可恢复）算成功').toBe(true)
      expect(result.text, '必须说清回落到了安全区').toMatch(/safe zone/i)
    } else {
      expect(result.ok, '还有文件原封不动，不能报成功').toBe(false)
      expect(result.text, '必须说清哪些没处理').toMatch(/not handled|still|failed/i)
    }
  })
})
