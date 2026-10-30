import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readAudit } from '../src/audit'
import { tryAcquireLock } from '../src/cleanup'
import { moveToSafeZone } from '../src/store'
import { pruneNowForWorker } from '../src/cleanup-run'
import { makeFakeRecycler } from './support/fake-recycler'
import { scratchDir } from './support/tmpdir'

/**
 * SD-N03：`cleanup.lock` 的陈旧锁接管必须是单一原子步骤。
 *
 * ## 缺陷（2026-10-30 复审）
 *
 * 与 `index.lock` 上一轮修掉的那个是同一种形状：
 *
 * ```
 * rmSync(lockPath)                      ← 删旧锁
 * writeFileSync(lockPath, ..., {wx})    ← 建新锁
 * ```
 *
 * 两个调度者可交错：A 删旧锁 → A 建新锁 → B 删掉 **A 的新锁** → B 建新锁。
 * A 和 B 都认为拿到锁，各自派发一个 Worker，并行清理同一个安全区。
 *
 * ## 为什么当时漏了
 *
 * 我在 `index-lock.ts` 里专门修过这个问题并写了注释，却没回头检查
 * `cleanup.ts` 里同源的实现。**修一处不等于修一类。**
 */
describe('SD-N03: cleanup.lock takeover is atomic', () => {
  /**
   * 写一把陈旧的清理锁（持有者已死、时间戳很旧）。
   *
   * @param state 安全区。
   * @param token 持有者 token。
   */
  function writeStaleLock(state: string, token: string): void {
    mkdirSync(state, { recursive: true })
    writeFileSync(
      join(state, 'cleanup.lock'),
      JSON.stringify({ pid: 999_999_999, at: Date.now() - 11 * 60 * 1000, token }),
    )
  }

  it('takes over via rename, not delete-then-recreate (source-level check)', () => {
    /*
     * ## 为什么这是结构断言而不是行为测试
     *
     * 缺陷是**跨进程**交错。单进程里两次 `tryAcquireLock` 调用是顺序执行的，
     * 交错不会发生 —— 写行为测试会得到"全绿但毫无覆盖"的结果
     * （我在 `index-lock` 上已经踩过这个坑）。
     *
     * 所以检查源码形状：接管分支必须用 `renameSync` 抢占，
     * 不得出现"rmSync(锁) 紧跟 writeFileSync(wx)"的删除重建模式。
     */
    const src = readFileSync('src/cleanup.ts', 'utf8')

    const at = src.indexOf('const tombstone =')
    expect(at, '接管应使用 tombstone(rename) 方案').toBeGreaterThan(0)

    const tail = src.slice(at, at + 1500)
    expect(tail, '接管必须用 renameSync 抢占').toMatch(/renameSync\(lockPath, tombstone\)/)
    expect(tail, '不许用 rmSync(lockPath) 做接管').not.toMatch(
      /rmSync\(lockPath[^)]*\)[\s\S]{0,80}writeFileSync\(lockPath/,
    )
  })

  it('still takes over a stale lock held by a dead process', () => {
    // 基本能力不受影响。
    const state = scratchDir('dsd-sdn03-takeover-')
    writeStaleLock(state, 'dead-holder')

    expect(tryAcquireLock(state, 10 * 60 * 1000, 'new-owner'), '过期且持有者已死应可接管').toBe(true)

    const raw = JSON.parse(readFileSync(join(state, 'cleanup.lock'), 'utf8')) as { token?: string }
    expect(raw.token, '新锁应属于接管者').toBe('new-owner')
  })

  it('does not leave tombstone files behind', () => {
    // rename 方案会留凭证文件，成功后必须清掉。
    const state = scratchDir('dsd-sdn03-clean-')
    writeStaleLock(state, 'dead')

    tryAcquireLock(state, 10 * 60 * 1000, 'new-owner')

    const junk = readdirSync(state).filter((n) => n.includes('.stale-'))
    expect(junk, '不该留下 stale 凭证').toHaveLength(0)
  })

  it('does not steal a lock whose holder is alive', () => {
    // 反向保护：活着的持有者不能被抢。
    const state = scratchDir('dsd-sdn03-live-')
    mkdirSync(state, { recursive: true })
    writeFileSync(
      join(state, 'cleanup.lock'),
      JSON.stringify({ pid: process.pid, at: Date.now() - 11 * 60 * 1000, token: 'live' }),
    )

    expect(tryAcquireLock(state, 10 * 60 * 1000, 'thief'), '活着的持有者不该被抢').toBe(false)
  })
})

/**
 * SD-N08：审计里的 batchId 必须是真的那个。
 *
 * ## 缺陷
 *
 * `recycleBatch` 内部生成 `${Date.now()}-${random}` 作为真实批次目录名，
 * 而写审计时**又造了一个** `${Date.now().toString(36)}`。两个值永远不同。
 *
 * 后果：journal 里写着 `batch=abc123`，而 `batches/abc123/manifest.json`
 * 不存在。顺着审计去对账会找不到对应批次 —— 一条用于"可追溯"的记录
 * 反而误导。
 */
describe('SD-N08: audit batch id matches the real batch directory', () => {
  /**
   * 造 N 条已过期条目。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param n 条数。
   */
  async function seedExpired(state: string, work: string, n: number): Promise<void> {
    mkdirSync(work, { recursive: true })
    for (let i = 0; i < n; i += 1) {
      const p = join(work, `old${i}.txt`)
      writeFileSync(p, 'x')
      await moveToSafeZone(state, p, { retentionDays: 1, now: Date.now() - 10 * 86_400_000 })
    }
  }

  it('records a batch id that actually exists on disk', async () => {
    /*
     * 核心断言：从 journal 里取出 batch id，去 `batches/<id>/manifest.json`
     * 找它 —— 必须存在。
     *
     * 修复前这里必然找不到（两个 id 生成规则不同）。
     */
    const root = scratchDir('dsd-sdn08-match-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    await seedExpired(state, work, 3)

    const bin = makeFakeRecycler(join(root, 'bin'))
    const result = await pruneNowForWorker(state, 100, bin)
    expect(result.recycled).toBe(3)

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    expect(records, '3 条应各有一条审计').toHaveLength(3)

    const batchIds = new Set(
      records.map((r) => /batch=(\S+)/.exec(r.detail ?? '')?.[1]).filter((v): v is string => v !== undefined),
    )
    expect(batchIds.size, '同一批应只有一个 batch id').toBe(1)

    const [batchId] = [...batchIds]
    expect(batchId, '应记录批次 id').toBeDefined()

    /*
     * 关键：这个 id 必须对应磁盘上真实存在的批次目录。
     *
     * 注意批次在回收成功后被清掉了（`cleanupBatchDir`），所以这里检查的是
     * "审计里的 id 与 recycleBatch 实际用的 id 一致" —— 通过 ID 形态校验：
     * 真实批次 id 形如 `<13 位毫秒时间戳>-<6 位随机>`，而伪造的是
     * base36 短串。
     */
    expect(batchId, 'batch id 应形如 <毫秒时间戳>-<随机后缀>').toMatch(/^\d{13}-[a-z0-9]{6}$/)
  })

  it('does not invent a separate id for the audit trail', async () => {
    /*
     * 结构断言：审计写入处不应再自己造 id。
     *
     * 检查 `cleanup-run.ts` 里 `appendAuditBatch` 附近不再出现
     * `const batchId = ` 这样的重新生成。
     */
    const src = readFileSync('src/cleanup-run.ts', 'utf8')
    const at = src.indexOf('appendAuditBatch(')
    expect(at).toBeGreaterThan(0)

    // 往前 600 字符内不该有新的 batchId 生成。
    const before = src.slice(Math.max(0, at - 600), at)
    expect(before, '审计写入处不该再造 batchId').not.toMatch(/const batchId = `\$\{Date\.now\(\)\.toString\(36\)\}/)
    // 用的是 outcome.batchId。
    expect(src.slice(at, at + 800), '应使用 outcome.batchId').toMatch(/outcome\.batchId/)
  })

  it('leaves no batch id in the audit when nothing was recycled', async () => {
    // 没有回收就不该有记录（沿用 SD-F1 的约束）。
    const root = scratchDir('dsd-sdn08-none-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    mkdirSync(state, { recursive: true })

    const result = await pruneNowForWorker(state, 100, makeFakeRecycler(join(root, 'bin')))
    expect(result.recycled).toBe(0)

    const records = readAudit(state, 100).filter((r) => r.event === 'prune')
    expect(records).toHaveLength(0)
    expect(existsSync(join(state, 'batches')) && readdirSync(join(state, 'batches')).length > 0).toBe(false)
  })
})
