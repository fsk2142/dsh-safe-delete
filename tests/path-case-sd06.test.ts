import { describe, expect, it } from 'vitest'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isStrictlyUnder, listSafeZone, moveToSafeZone } from '../src/store'
import { classifyPath } from '../src/classify'
import { scratchDir } from './support/tmpdir'

/**
 * SD-06（2026-11-01 审查）：路径比较必须按平台大小写规则。
 *
 * ## 缺陷
 *
 * `isStrictlyUnder` / `isUnder` / `isInsideStateDir` 都用
 * `resolved.startsWith(parent + sep)` —— 区分大小写的字符串比较。
 *
 * Windows 的文件系统默认**大小写无关**：`C:\X\STATE` 与 `C:\X\state` 是
 * 同一个目录。于是自保护能被大写路径绕过：
 *
 * ```
 * items 根：C:\work\.dsh-safe-delete\items
 * 传入：   C:\WORK\.DSH-SAFE-DELETE\ITEMS\entry-a   ← 同一位置
 * startsWith → false                                 ← 检查放行
 * ```
 *
 * 隔离验证：大写路径确实被判为"不在 items 之内"。
 *
 * ## 修复
 *
 * `classify.ts` 早就有 `normalize()`（Windows 上转小写）。现在把它导出，
 * `store.ts` 与 `delete-core.ts` 都复用它 —— 一处实现，不会漂移。
 */
describe('SD-06: path comparison follows platform case rules', () => {
  /**
   * 当前平台是否大小写无关。
   */
  const caseInsensitive = process.platform === 'win32'

  it('normalizes through a single shared implementation', async () => {
    /*
     * 结构性：三个位置都应当用同一个 normalize，而不是各自 resolve。
     *
     * 这防的是"改了一处、漏了另两处" —— 本次缺陷正是这么来的。
     */
    const { readFileSync } = await import('node:fs')

    const store = readFileSync('src/store.ts', 'utf8')
    expect(store, 'store.ts 应复用 classify 的 normalize').toMatch(
      /import \{ normalize as normalizeForCompare \} from '\.\/classify'/,
    )

    const core = readFileSync('src/delete-core.ts', 'utf8')
    expect(core, 'delete-core.ts 应复用同一个 normalize').toMatch(/normalize as normalizeForCompare/)

    const classify = readFileSync('src/classify.ts', 'utf8')
    expect(classify, 'normalize 应被导出').toMatch(/export function normalize\(/)
  })

  it('treats case variants as the same subtree on Windows', () => {
    /*
     * 核心断言：同一个路径的大写写法必须被判为"在内部"。
     *
     * 这条只在 Windows 上有意义 —— POSIX 上大写是真不同的目录，
     * 判 false 才正确。
     */
    const parent = process.platform === 'win32' ? 'C:\\work\\items' : '/tmp/items'
    const childExact = process.platform === 'win32' ? 'C:\\work\\items\\entry-a' : '/tmp/items/entry-a'
    const childUpper =
      process.platform === 'win32' ? 'C:\\WORK\\ITEMS\\ENTRY-A' : '/tmp/items/entry-a'

    expect(isStrictlyUnder(childExact, parent), '精确写法应在内部').toBe(true)

    if (caseInsensitive) {
      expect(isStrictlyUnder(childUpper, parent), '大写写法也应在内部（Windows）').toBe(true)
    } else {
      // POSIX：不同大小写是不同目录，不应判为在内部。
      expect(isStrictlyUnder('/TMP/ITEMS/entry-a', parent)).toBe(false)
    }
  })

  it('still rejects the parent itself and unrelated paths', () => {
    // 回归：不能因为归一化把"等于自己"或无关路径也判进来。
    const parent = process.platform === 'win32' ? 'C:\\work\\items' : '/tmp/items'
    expect(isStrictlyUnder(parent, parent), '等于自己不算在内部').toBe(false)

    const unrelated = process.platform === 'win32' ? 'C:\\other\\thing' : '/other/thing'
    expect(isStrictlyUnder(unrelated, parent), '无关路径不在内部').toBe(false)

    // 前缀相同但不是子目录（`items-extra` vs `items`）。
    const sibling = process.platform === 'win32' ? 'C:\\work\\items-extra' : '/tmp/items-extra'
    expect(isStrictlyUnder(sibling, parent), '同前缀的兄弟目录不在内部').toBe(false)
  })

  it('classifies a case-variant of dshHome as not free', () => {
    /*
     * 端到端：DSH home（安全区在它下面）的路径应当被归为**受保护**，
     * 而不是 free —— 大小写变体也不行。
     *
     * `ClassifyEnv` 用的是 `dshHome` 字段：安全区默认是
     * `<dshHome>/.dsh-safe-delete`，所以保护由它承担。
     */
    const root = scratchDir('dsd-sd06-cls-')
    const dshHome = join(root, 'dsh-home')
    mkdirSync(dshHome, { recursive: true })
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'a.txt'), 'x')

    const env = { home: join(root, 'home'), workdir: work, tmpdir: join(root, 'tmp'), dshHome }

    // 精确写法：在 dshHome 下 → 不该是 free。
    const exact = classifyPath(join(dshHome, '.dsh-safe-delete', 'items'), env)
    expect(exact, 'dshHome 之下不该是 free').not.toBe('free')

    if (caseInsensitive) {
      const upper = join(dshHome, '.DSH-SAFE-DELETE', 'ITEMS')
      const variant = classifyPath(upper, env)
      expect(variant, '大写写法也不该是 free').not.toBe('free')
    }
  })

  it('does not let a case variant escape the safe-zone self-protection', () => {
    /*
     * 真实后果：若 case variant 被判为"不在 items 之下"，
     * `destroyEntry` 的自保护就放行了"删掉整个 items"。
     *
     * 这里直接验证 isStrictlyUnder 对大小写变体的判定（上面已覆盖），
     * 并额外确认 items 根与它自己的大小写变体不被判为"严格在其下"。
     */
    const state = join(scratchDir('dsd-sd06-self-'), 'state')
    const itemsRoot = join(state, 'items')

    expect(isStrictlyUnder(itemsRoot, itemsRoot), '相等不算在内').toBe(false)

    if (caseInsensitive) {
      const upper = itemsRoot.toUpperCase()
      expect(isStrictlyUnder(upper, itemsRoot), '大小写变体与自己相等，不算在内').toBe(false)
    }
  })

  it('keeps working for a real entry round-trip', async () => {
    // 回归：正常删除不受影响。
    const root = scratchDir('dsd-sd06-ok-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    const p = join(work, 'normal.txt')
    writeFileSync(p, 'x')
    await moveToSafeZone(state, p, { retentionDays: 1 })

    const entries = await listSafeZone(state)
    expect(entries).toHaveLength(1)
    expect(readdirSync(join(state, 'items', entries[0]!.id)).length).toBeGreaterThan(0)
  })
})
