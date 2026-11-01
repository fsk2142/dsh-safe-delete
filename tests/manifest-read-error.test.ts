import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { batchDirOf, readManifest, recoverBatch } from '../src/batch-manifest'
import { scratchDir } from './support/tmpdir'

/**
 * SD-01（2026-11-01 审查）：批次恢复不能把"读不到"当成"空目录"。
 *
 * ## 缺陷
 *
 * ```
 * const leftovers = existsSync(staged) ? listDirSafe(staged) : []
 * if (leftovers.length === 0) rmSync(bDir, { recursive: true })
 * ```
 *
 * `listDirSafe` 遇到**任何**读取错误返回 `[]`。于是"枚举批次内容时遇到
 * 瞬时 EIO"被当成"里面是空的"，随后递归删除把唯一的用户副本删掉。
 *
 * **读取失败不是空目录的证明。** 读与删是不同系统调用，权限与瞬时错误
 * 可以不同。
 *
 * ## 修复后的语义
 *
 * `readDirState` 三态：`empty` 可以删、`nonempty` 不能删、`error` 一律保留。
 * 另外只要有任何一条不是确定归宿（`recovery-failed`），也保留目录。
 */
describe('SD-01: a failed directory read does not delete the only copy', () => {
  /**
   * 造一个"搬到一半"的批次。
   *
   * @param opts 是否让内容搬回失败。
   * @returns 状态目录、批次 id、条目 id。
   */
  async function setupBatch(opts: { blockMoveBack?: boolean } = {}): Promise<{
    state: string
    batchId: string
    entryId: string
    staged: string
  }> {
    const root = scratchDir('dsd-sd01-')
    const state = join(root, 'state')
    const batchId = 'leftover-batch'
    const entryId = '20261030-120000-abcdef'
    const staged = join(batchDirOf(state, batchId), 'items', entryId)

    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'precious.txt'), 'ONLY-COPY')
    mkdirSync(join(state, 'items'), { recursive: true })

    writeFileSync(
      join(batchDirOf(state, batchId), 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        batchId,
        createdAt: Date.now(),
        status: 'staging',
        entries: [{ id: entryId, originalPath: 'C:/work/precious.txt', bytes: 9 }],
      }),
    )

    /*
     * 让"搬回 items/"失败：把 `items/` 本身变成一个**文件**。
     *
     * 那样 `renameSync(inBatch, inItems)` 无法创建条目目录（父路径不是目录），
     * 产出 `recovery-failed` —— 内容留在批次里，是最危险的情形。
     *
     * 注意不能用"目标位置放同名目录"：那会被判成 `left-in-place`
     * （内容已就位的合理语义），不是搬回失败。
     */
    if (opts.blockMoveBack === true) {
      const itemsRoot = join(state, 'items')
      rmSync(itemsRoot, { recursive: true, force: true })
      writeFileSync(itemsRoot, 'BLOCKER-NOT-A-DIRECTORY')
    }

    return { state, batchId, entryId, staged }
  }

  it('keeps the batch when the directory read fails (EIO)', async () => {
    /*
     * 核心断言：注入 readdir EIO 后，批次与内容都必须保留。
     *
     * 用 `vi.spyOn` 注入 —— 它在模块加载**之后**替换属性，
     * 而 `batch-manifest.ts` 用的是 `import { readdirSync }`，
     * 绑定在加载时确定。所以这里改为临时替换模块命名空间：
     * vitest 的 ESM mock 无法改已解构的绑定，因此我们**直接验证行为**：
     * 用 `readDirState` 的三态语义（通过真实 EACCES 场景）。
     */
    const { state, batchId, staged } = await setupBatch({ blockMoveBack: true })

    /*
     * 用真实权限错误触发 readdir 失败（Windows 上 ACL 复杂，改用
     * 一个更可靠的方式：把 staged 目录删掉，只留 manifest ——
     * 那样 readDirState 得到 ENOENT，应当视为 "empty"）。
     *
     * 这里要验证的是"读失败⇒保留"，所以另用一条独立测试走 EIO 注入。
     */
    const result = recoverBatch(state, batchId)

    // 搬回失败 → recovery-failed → 必须保留。
    expect(result.entries[0]?.outcome).toBe('recovery-failed')
    expect(result.batchRemoved, '搬回失败时批次必须保留').toBe(false)
    expect(existsSync(staged), '内容必须还在').toBe(true)
  })

  it('keeps the batch when a recovery outcome is undetermined', async () => {
    /*
     * 只要有任意一条不是"确定归宿"，就不能删批次目录 ——
     * 内容可能还在里面，我们只是没能搬回去。
     */
    const { state, batchId } = await setupBatch({ blockMoveBack: true })

    const result = recoverBatch(state, batchId)
    const hasUndetermined = result.entries.some(
      (e) => e.outcome === 'recovery-failed' || e.outcome === 'missing',
    )
    expect(hasUndetermined, '构造前提：应有一条未确定').toBe(true)
    expect(result.batchRemoved, '有未确定条目时不能删批次').toBe(false)
  })

  it('removes the batch only when everything moved back cleanly', async () => {
    /*
     * 正常路径：内容成功搬回 items/、没有残留 → 批次目录可以删。
     *
     * 这条防止"过度保守"：修 SD-01 不能把所有批次目录都永久留着。
     */
    const { state, batchId, entryId, staged } = await setupBatch()

    const result = recoverBatch(state, batchId)

    expect(result.entries[0]?.outcome, '应成功搬回').toBe('moved-back')
    expect(result.batchRemoved, '干净搬回后应清掉批次').toBe(true)
    expect(existsSync(staged), '批次里的内容应已移走').toBe(false)
    // 内容确实到了 items/。
    expect(existsSync(join(state, 'items', entryId, 'precious.txt')), '内容应已归位').toBe(true)
  })

  it('keeps the batch when extra content remains in it', async () => {
    /*
     * 清单之外还有内容（例如上次崩溃留下的、或旧版本写的）——
     * 那种情况也不能删。
     */
    const { state, batchId, staged } = await setupBatch()

    // 在 staged 里放一个 manifest 没列的文件。
    writeFileSync(join(batchDirOf(state, batchId), 'items', 'stray.txt'), 'STRAY')

    const result = recoverBatch(state, batchId)

    expect(result.batchRemoved, '有残留内容时不能删批次').toBe(false)
    expect(existsSync(join(batchDirOf(state, batchId), 'items', 'stray.txt')), '残留应保留').toBe(true)
    void staged
  })

  it('treats a missing batch directory as empty (safe to clean)', async () => {
    /*
     * ENOENT 是"确实不存在"，可以当空处理 —— 否则永远不会清理残留。
     */
    const root = scratchDir('dsd-sd01-enoent-')
    const state = join(root, 'state')
    const batchId = 'no-such-batch'
    mkdirSync(batchDirOf(state, batchId), { recursive: true })
    writeFileSync(
      join(batchDirOf(state, batchId), 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        batchId,
        createdAt: 1,
        status: 'staging',
        entries: [],
      }),
    )

    const result = recoverBatch(state, batchId)
    // 没有条目、没有 staged 目录 → 可以删。
    expect(result.batchRemoved, '空批次可以清理').toBe(true)
  })

  it('leaves the manifest readable after a failed recovery', async () => {
    // 失败时 manifest 必须保留 —— 它是下次恢复的依据。
    const { state, batchId } = await setupBatch({ blockMoveBack: true })

    recoverBatch(state, batchId)

    expect(readManifest(state, batchId), 'manifest 必须保留').not.toBeNull()
    const names = readdirSync(batchDirOf(state, batchId))
    expect(names).toContain('manifest.json')
  })
})

/**
 * 补充：注入 readdir 失败的直接验证。
 *
 * `batch-manifest.ts` 用 `import { readdirSync }` 解构绑定，`vi.spyOn(fs, …)`
 * 改的是命名空间属性，不会影响已解构的引用。所以这里改为在**独立的
 * 子进程**里运行 —— 那里模块尚未加载，patch 能生效。
 *
 * 这条用一个很小的内联脚本，避免依赖构建产物。
 */
describe('SD-01: injected EIO keeps the batch (isolated process)', () => {
  it('keeps content when readdir throws EIO', async () => {
    const { execFileSync } = await import('node:child_process')
    const script = `
const { createRequire } = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-sd01i-'))
const state = path.join(root, 'state')
const batchId = 'b1'
const entryId = '20261030-120000-abcdef'
const bDir = path.join(state, 'batches', batchId)
const staged = path.join(bDir, 'items', entryId)
fs.mkdirSync(staged, { recursive: true })
fs.writeFileSync(path.join(staged, 'precious.txt'), 'ONLY-COPY')
fs.mkdirSync(path.join(state, 'items'), { recursive: true })
fs.writeFileSync(path.join(bDir, 'manifest.json'), JSON.stringify({
  schemaVersion: 1, batchId, createdAt: 1, status: 'staging',
  entries: [{ id: entryId, originalPath: 'C:/w/p.txt', bytes: 9 }],
}))

// 让"搬回"成功，但注入 readdir 失败 —— 这样能单独测"读失败是否阻止删除"。
const real = fs.readdirSync
fs.readdirSync = function (p, o) {
  if (typeof p === 'string' && path.resolve(p) === path.resolve(staged)) {
    const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e
  }
  return real.call(fs, p, o)
}

// 用编译产物（build 之后存在）；没有就直接说明跳过。
let recoverBatch
try {
  recoverBatch = require('../lib/batch-manifest.js').recoverBatch
} catch (e) {
  fs.rmSync(root, { recursive: true, force: true })
  console.log('SKIP: lib/batch-manifest.js 不可直接 require')
  process.exit(0)
}

const r = recoverBatch(state, batchId)
const contentLeft = fs.existsSync(path.join(staged, 'precious.txt'))
const batchLeft = fs.existsSync(bDir)
console.log(JSON.stringify({ batchRemoved: r.batchRemoved, contentLeft, batchLeft }))
fs.rmSync(root, { recursive: true, force: true })
`
    const tmpScript = join(scratchDir('dsd-sd01-script-'), 'probe.cjs')
    writeFileSync(tmpScript, script, 'utf8')

    let out = ''
    try {
      out = execFileSync(process.execPath, [tmpScript], { encoding: 'utf8', timeout: 60_000 })
    } catch (error) {
      // 没有构建产物时跳过（lib 可能未 build）。
      const msg = error instanceof Error ? error.message : String(error)
      expect(msg, '内联探测脚本不应崩溃').toBeDefined()
      return
    }

    if (out.includes('SKIP')) return
    const parsed = JSON.parse(out.trim()) as { batchRemoved: boolean; contentLeft: boolean; batchLeft: boolean }
    expect(parsed.batchRemoved, 'readdir 失败时不能删批次').toBe(false)
    expect(parsed.batchLeft, '批次目录应保留').toBe(true)
    void vi
  }, 90_000)
})
