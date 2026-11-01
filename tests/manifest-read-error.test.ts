import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { batchDirOf, readDirState, readManifest, recoverBatch } from '../src/batch-manifest'
import { scratchDir } from './support/tmpdir'

/**
 * SD-01 / RV-10（第一轮 + 第二轮审查）：批次恢复不能把"读不到"当成"空目录"。
 *
 * ## 原始缺陷
 *
 * ```
 * const leftovers = existsSync(staged) ? listDirSafe(staged) : []
 * if (leftovers.length === 0) rmSync(bDir, { recursive: true })
 * ```
 *
 * `listDirSafe` 遇到**任何**读取错误返回 `[]`。于是"枚举批次内容时遇到瞬时
 * EIO"被当成"里面是空的"，随后递归删除把唯一的用户副本删掉。
 *
 * **读取失败不是空目录的证明。**
 *
 * ## 第二轮审查 RV-10：第一轮的 EIO 测试是**假绿**
 *
 * 那版把注入写进独立 `.cjs` 探针并 `require('../lib/batch-manifest.js')`。
 * 三个独立原因让它从未执行断言：
 *
 * 1. 探针在临时目录，`../lib/...` 相对位置不对 → `MODULE_NOT_FOUND`；
 * 2. `lib/batch-manifest.js` **不存在** —— tsdown 把它 bundle 进了 hash
 *    chunk（本轮实测确认）；
 * 3. 注入点是 `batches/<id>/items/<entryId>`，而实现读的是**父目录**
 *    `batches/<id>/items` → 即使能加载也命中不了。
 *
 * 失败处理是打印 `SKIP` + `exit(0)`，测试看到 SKIP 就 `return` —— 一直"通过"。
 *
 * ## 现在的做法
 *
 * 不再试图 patch 全局 `readdirSync`（实测无效：ESM 的命名导入绑定直接连到
 * 内置模块，patch CJS 导出对象命中数为 0）。改为：
 *
 * 1. **导出 `readDirState`**，直接测三态语义 —— 包括用 chmod 制造真实
 *    的 EACCES，不需要任何注入；
 * 2. `recoverBatch` 的保留行为用**真实可复现的失败**验证：
 *    `state/items` 是文件 → 搬回必然失败 → 内容必须留在批次里。
 *
 * 没有任何 SKIP 分支：拿不到东西就直接失败。
 */
describe('SD-01 / RV-10: a failed directory read is not proof of an empty directory', () => {
  describe('readDirState three-state semantics', () => {
    it('reports empty for a directory with no entries', () => {
      const dir = join(scratchDir('dsd-rd-'), 'empty')
      mkdirSync(dir, { recursive: true })
      expect(readDirState(dir)).toEqual({ kind: 'empty' })
    })

    it('reports nonempty with the entry names', () => {
      const dir = join(scratchDir('dsd-rd-'), 'full')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'a.txt'), 'a')
      const state = readDirState(dir)
      expect(state.kind).toBe('nonempty')
      if (state.kind === 'nonempty') expect(state.names).toContain('a.txt')
    })

    it('reports empty for a genuinely missing directory (ENOENT)', () => {
      // ENOENT 与"读失败"不同：目录确实不在，可以当空。
      const dir = join(scratchDir('dsd-rd-'), 'does-not-exist')
      expect(readDirState(dir), 'ENOENT 可以当空').toEqual({ kind: 'empty' })
    })

    it('reports error for a permission failure, never empty', () => {
      /*
       * 真实 EACCES：把目录权限去掉。
       *
       * POSIX 上有效；Windows 上 chmod 对目录基本无效，所以那里跳过 ——
       * 但**不能**静默跳过整条测试，所以用平台断言明确说明。
       */
      const dir = join(scratchDir('dsd-rd-'), 'denied')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'secret.txt'), 'x')

      if (process.platform === 'win32') {
        /*
         * Windows：用"路径指向一个文件"制造非 ENOENT 的读失败
         * （ENOTDIR），仍然必须是 error 而不是 empty。
         */
        const asFile = join(scratchDir('dsd-rd-'), 'a-file')
        writeFileSync(asFile, 'x')
        const state = readDirState(asFile)
        expect(state.kind, '目录位置是文件 → 读失败，不是空').toBe('error')
        return
      }

      chmodSync(dir, 0o000)
      try {
        const state = readDirState(dir)
        expect(state.kind, '权限失败必须是 error').toBe('error')
      } finally {
        chmodSync(dir, 0o755)
      }
    })

    it('is exported so this semantics can be tested at all', async () => {
      /*
       * 结构性：RV-10 的根因之一是"没法直接测"。导出这件事本身要钉住 ——
       * 否则以后有人改回私有，这套测试就只能又退回去做全局注入。
       */
      const mod = (await import('../src/batch-manifest')) as Record<string, unknown>
      expect(typeof mod['readDirState'], 'readDirState 必须导出').toBe('function')
    })
  })

  describe('recoverBatch keeps the only copy when the outcome is unknown', () => {
    /**
     * 造一个"搬到一半"的批次。
     *
     * @param opts 选项。
     * @returns 路径与 id。
     */
    function setupBatch(opts: { emptyStaged?: boolean; blockMoveBack?: boolean } = {}): {
      state: string
      batchId: string
      entryId: string
      stagedRoot: string
      bDir: string
    } {
      const root = scratchDir('dsd-sd01-')
      const state = join(root, 'state')
      const batchId = 'leftover-batch'
      const entryId = '20261030-120000-abcdef'
      const bDir = batchDirOf(state, batchId)
      const stagedRoot = join(bDir, 'items')

      if (opts.emptyStaged !== true) {
        mkdirSync(join(stagedRoot, entryId), { recursive: true })
        writeFileSync(join(stagedRoot, entryId, 'precious.txt'), 'ONLY-COPY')
      } else {
        mkdirSync(stagedRoot, { recursive: true })
      }

      if (opts.blockMoveBack === true) {
        // `state/items` 变成文件 → 搬回必然失败（最危险：内容留在批次里）。
        writeFileSync(join(state, 'items'), 'not-a-directory')
      } else {
        mkdirSync(join(state, 'items'), { recursive: true })
      }

      writeFileSync(
        join(bDir, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          batchId,
          createdAt: Date.now(),
          status: 'staging',
          entries: [{ id: entryId, originalPath: 'C:/work/precious.txt', bytes: 9 }],
        }),
      )

      return { state, batchId, entryId, stagedRoot, bDir }
    }

    it('keeps the batch when content cannot be moved back', () => {
      /*
       * 这是可**真实复现**的"不确定归宿"：搬回失败。
       *
       * 只要有任一条不是确定归宿，目录就不能删 —— 那正是 SD-01 的承诺。
       */
      const { state, batchId, bDir, stagedRoot, entryId } = setupBatch({ blockMoveBack: true })

      const result = recoverBatch(state, batchId)

      expect(result.batchRemoved, '搬回失败时不能删批次').toBe(false)
      expect(existsSync(bDir), '批次目录必须保留').toBe(true)
      expect(existsSync(join(stagedRoot, entryId, 'precious.txt')), '唯一副本必须留在批次里').toBe(
        true,
      )
      expect(
        result.entries.some((e) => e.outcome === 'recovery-failed'),
        '应记录为未确定归宿',
      ).toBe(true)
    })

    it('removes the batch when the staged directory is genuinely empty', () => {
      /*
       * 反向：真空目录 → 允许清理。否则"保留"会变成永不清理。
       *
       * 注意 manifest 也必须是空的 —— 若还列着条目，实现会去搬它、
       * 结果是 `missing` 而不是"目录为空"。这两种语义不同，不能混。
       */
      const root = scratchDir('dsd-sd01-empty-')
      const state = join(root, 'state')
      const batchId = 'empty-batch'
      const bDir = batchDirOf(state, batchId)
      mkdirSync(join(bDir, 'items'), { recursive: true })
      mkdirSync(join(state, 'items'), { recursive: true })
      writeFileSync(
        join(bDir, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          batchId,
          createdAt: Date.now(),
          status: 'staging',
          entries: [],
        }),
      )

      const result = recoverBatch(state, batchId)

      expect(result.batchRemoved, '真空目录可以删').toBe(true)
      expect(existsSync(bDir), '批次目录应被清理').toBe(false)
    })

    it('moves content back when the move can succeed', () => {
      // 正常路径：内容回到 items/，批次被清理。
      const { state, batchId, entryId, bDir } = setupBatch()

      const result = recoverBatch(state, batchId)

      expect(result.batchRemoved, '成功后应清理批次').toBe(true)
      expect(existsSync(bDir)).toBe(false)
      expect(existsSync(join(state, 'items', entryId, 'precious.txt')), '内容应回到 items/').toBe(true)
    })
  })

  describe('manifest validation', () => {
    /**
     * 给校验用例用的最小批次。
     *
     * @returns 状态目录、批次 id、批次目录。
     */
    function setupBatchLocal(): { state: string; batchId: string; bDir: string } {
      const root = scratchDir('dsd-mv-')
      const state = join(root, 'state')
      const batchId = 'validate-batch'
      const bDir = batchDirOf(state, batchId)
      mkdirSync(join(bDir, 'items'), { recursive: true })
      return { state, batchId, bDir }
    }

    it('returns null for a manifest with a mismatched batchId', () => {
      /*
       * 契约是**返回 null**，不是抛错 —— 调用方据此保留目录。
       * （我第一版断言 toThrow，是错的；这里按真实契约测。）
       */
      const { state, batchId, bDir } = setupBatchLocal()
      writeFileSync(
        join(bDir, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          batchId: 'some-other-batch',
          createdAt: Date.now(),
          status: 'staging',
          entries: [],
        }),
      )
      expect(readManifest(state, batchId), 'batchId 不符应判为损坏').toBeNull()
    })

    it('returns null for an unknown schemaVersion', () => {
      const { state, batchId, bDir } = setupBatchLocal()
      writeFileSync(
        join(bDir, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 99,
          batchId,
          createdAt: Date.now(),
          status: 'staging',
          entries: [],
        }),
      )
      expect(readManifest(state, batchId), '未知 schemaVersion 应判为损坏').toBeNull()
    })

    it('returns null for an invalid entry id, and never touches the batch', () => {
      /*
       * 越界 id 是最危险的一条：`id = '../..'` 会让恢复操作逃出 items/。
       * 判为损坏 ⇒ 保留批次。
       */
      const { state, batchId, bDir } = setupBatchLocal()
      mkdirSync(join(bDir, 'items', 'whatever'), { recursive: true })
      writeFileSync(
        join(bDir, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          batchId,
          createdAt: Date.now(),
          status: 'staging',
          entries: [{ id: '../../escape', originalPath: 'C:/x', bytes: 1 }],
        }),
      )

      expect(readManifest(state, batchId), '越界 id 应判为损坏').toBeNull()

      const result = recoverBatch(state, batchId)
      expect(result.batchRemoved, 'manifest 损坏时不能删批次').toBe(false)
      expect(existsSync(join(bDir, 'items', 'whatever')), '内容必须保留').toBe(true)
    })
  })
})
