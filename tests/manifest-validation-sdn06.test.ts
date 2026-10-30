import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { batchDirOf, readManifest, recoverBatch, writeManifest } from '../src/batch-manifest'
import { listSafeZone, moveToSafeZone } from '../src/store'
import { recoverResidualBatches } from '../src/cleanup-run'
import { scratchDir } from './support/tmpdir'

/**
 * SD-N06：manifest 是磁盘数据，必须严格校验。
 *
 * ## 缺陷（2026-10-30 复审）
 *
 * `readManifest` 只检查 `batchId` 是字符串、`entries` 是数组，然后直接
 * 当成 `BatchManifest` 返回。而 `recoverBatch` 会拿 `entry.id` 拼路径：
 *
 * ```
 * join(staged, entry.id)        // entry 是 null → TypeError，整个 Worker 中止
 * join(stateDir, 'items', id)   // id 是 '../..' → 恢复操作越界
 * ```
 *
 * manifest 可能被崩溃写坏、人工编辑、旧版本写坏。一个 `entries: [null]`
 * 就足以让清理进程抛异常中止 —— 而它本该安静地跳过这个批次。
 */
describe('SD-N06: manifest validation', () => {
  /**
   * 造一个带合法条目的安全区，并写一个自定义 manifest。
   *
   * @param manifest 要写入的 manifest 内容（原样写）。
   * @returns 状态目录、条目 id、批次目录。
   */
  async function zoneWith(manifest: unknown): Promise<{ state: string; id: string; batchId: string }> {
    const root = scratchDir('dsd-sdn06-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    const p = join(work, 'a.txt')
    writeFileSync(p, 'CONTENT')
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    const batchId = 'test-batch'
    const dir = batchDirOf(state, batchId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    return { state, id, batchId }
  }

  /**
   * 一条合法的 manifest 条目。
   *
   * @param over 覆盖字段。
   * @returns 条目对象。
   */
  function goodEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: '20261030-120000-abcdef',
      originalPath: 'C:\\x\\a.txt',
      bytes: 10,
      ...over,
    }
  }

  /**
   * 一份合法的 manifest。
   *
   * @param over 覆盖字段。
   * @returns manifest 对象。
   */
  function goodManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 1,
      batchId: 'test-batch',
      createdAt: 1_700_000_000_000,
      status: 'staging',
      entries: [goodEntry()],
      ...over,
    }
  }

  it('accepts a well-formed manifest', async () => {
    // 防过度反应。
    const { state } = await zoneWith(goodManifest())
    expect(readManifest(state, 'test-batch')).not.toBeNull()
  })

  it.each([
    ['null 条目', { entries: [null] }],
    ['条目是数字', { entries: [42] }],
    ['条目是字符串', { entries: ['x'] }],
    ['条目是数组', { entries: [['a']] }],
    ['缺 id', { entries: [{ originalPath: 'p', bytes: 1 }] }],
    ['id 为空', { entries: [goodEntry({ id: '' })] }],
    ['id 是 .', { entries: [goodEntry({ id: '.' })] }],
    ['id 是 ../ 遍历', { entries: [goodEntry({ id: '../escape' })] }],
    ['id 含斜杠', { entries: [goodEntry({ id: 'a/b' })] }],
    ['bytes 为负', { entries: [goodEntry({ bytes: -1 })] }],
    ['bytes 非数', { entries: [goodEntry({ bytes: 'x' })] }],
    ['重复 id', { entries: [goodEntry(), goodEntry()] }],
    ['缺 originalPath', { entries: [{ id: '20261030-120000-abcdef', bytes: 1 }] }],
    ['schemaVersion 错', { schemaVersion: 2 }],
    ['schemaVersion 缺失', { schemaVersion: undefined }],
    ['status 非法', { status: 'whatever' }],
    ['createdAt 非数', { createdAt: 'x' }],
    ['batchId 与目录不符', { batchId: 'other-batch' }],
    ['batchId 为空', { batchId: '' }],
  ])('rejects a malformed manifest: %s', async (_label, over) => {
    const { state } = await zoneWith(goodManifest(over))
    expect(readManifest(state, 'test-batch'), `${_label} 应被判损坏`).toBeNull()
  })

  it('rejects entries that are not an array', async () => {
    const { state } = await zoneWith(goodManifest({ entries: 'not-array' }))
    expect(readManifest(state, 'test-batch')).toBeNull()
  })

  it('does not throw on a corrupt manifest during recovery', async () => {
    /*
     * 最重要的一条：坏 manifest 不能让恢复**崩溃**。
     *
     * 第一版遇到 `entries: [null]` 会在 `recoverBatch` 里抛 TypeError，
     * 整个 `recoverResidualBatches` 中止 —— 于是清理完全停摆，
     * 而原因只是一个坏掉的批次目录。
     */
    const { state, id } = await zoneWith(goodManifest({ entries: [null] }))

    await expect(recoverResidualBatches(state), '坏 manifest 不该让恢复抛异常').resolves.toBeDefined()

    // 索引必须原样保留 —— 不能因为"manifest 读不出来"就推断条目丢失。
    const entries = await listSafeZone(state)
    expect(entries.map((e) => e.id), '索引不该被动过').toContain(id)
  })

  it('keeps the batch directory when its manifest is corrupt', async () => {
    /*
     * 读不出 manifest 时**不能删目录** —— 里面可能有用户内容。
     */
    const { state, batchId } = await zoneWith(goodManifest({ entries: [null] }))
    const dir = batchDirOf(state, batchId)

    const result = recoverBatch(state, batchId)

    expect(result.batchRemoved, '损坏的批次目录不能被删').toBe(false)
    expect(existsSync(dir), '目录应保留').toBe(true)
    expect(existsSync(join(dir, 'manifest.json')), 'manifest 也应保留').toBe(true)
  })

  it('never moves files based on an illegal id from a manifest', async () => {
    /*
     * 路径越界防护：manifest 里 `id: '../escape'` 时，绝不能拿它去拼路径做 rename。
     *
     * 校验在读阶段就拒绝，`recoverBatch` 看到 null 直接返回。
     */
    const { state, batchId } = await zoneWith(goodManifest({ entries: [goodEntry({ id: '../escape' })] }))
    const staged = join(batchDirOf(state, batchId), 'items')
    mkdirSync(staged, { recursive: true })
    // 在安全区外面放一个"目标"，若发生越界 rename 它会消失。
    const outside = join(state, 'escape')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'canary.txt'), 'CANARY')

    recoverBatch(state, batchId)

    expect(existsSync(join(outside, 'canary.txt')), '安全区外的文件不能被移动').toBe(true)
    expect(readFileSync(join(outside, 'canary.txt'), 'utf8')).toBe('CANARY')
  })

  it('leaves a valid manifest readable and recoverable', async () => {
    // 回归：合法 manifest 仍能正常恢复。
    const root = scratchDir('dsd-sdn06-valid-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    const p = join(work, 'b.txt')
    writeFileSync(p, 'CONTENT')
    await moveToSafeZone(state, p, { retentionDays: 1 })
    const id = (await listSafeZone(state))[0]!.id

    const batchId = 'valid-batch'
    writeManifest(state, {
      schemaVersion: 1,
      batchId,
      createdAt: Date.now(),
      status: 'staging',
      entries: [{ id, originalPath: p, bytes: 7 }],
    })

    // 把内容搬进批次（模拟"搬到一半"）。
    const staged = join(batchDirOf(state, batchId), 'items')
    mkdirSync(staged, { recursive: true })
    const { renameSync } = await import('node:fs')
    renameSync(join(state, 'items', id), join(staged, id))

    await recoverResidualBatches(state)

    // 内容应被搬回 items/，条目仍在索引里。
    expect(readdirSync(join(state, 'items', id)).length, '内容应已归位').toBeGreaterThan(0)
    expect((await listSafeZone(state)).map((e) => e.id)).toContain(id)
  })
})
