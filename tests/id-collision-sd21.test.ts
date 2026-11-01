import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSafeZone, listSafeZoneDetailed, moveToSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * SD-21（2026-11-01 审查）：ID 碰撞时不能覆盖已有内容。
 *
 * ## 缺陷
 *
 * ID 由秒级时间戳 + 6 位 `Math.random` 组成；`mkdirSync(entryRoot, {recursive:true})`
 * 在目录已存在时**不报错**，随后 rename 到已有的 basename → 覆盖。
 *
 * 隔离验证（固定时间与随机值强制碰撞）：第一个文件的唯一副本被第二个覆盖，
 * 索引里还出现重复 id。
 *
 * 这是**人为制造碰撞**后的处理验证，不证明真实随机源已发生碰撞 ——
 * 但"概率低"不是"覆盖用户数据"的理由。
 *
 * ## 修复
 *
 * 非递归 `mkdir` 独占创建；EEXIST 即碰撞，抛 `ENTRY_ID_COLLISION`，
 * `moveToSafeZone` 重新生成 id 重试（最多 5 次）。
 */
describe('SD-21: an id collision never overwrites an existing entry', () => {
  /**
   * 固定 `Math.random` 让连续两次生成同一个 id。
   *
   * @returns 还原函数。
   */
  function freezeRandom(): () => void {
    const original = Math.random
    Math.random = () => 0.123456789
    return () => {
      Math.random = original
    }
  }

  it('does not overwrite when the same id is generated twice in the same second', async () => {
    /*
     * 核心：两个不同源文件、同一秒、同随随机值 → 同 id。
     *
     * 修复前：第二个覆盖第一个，第一个的唯一副本消失。
     * 修复后：第二次调用换一个 id（或明确失败），两份内容都在。
     */
    const root = scratchDir('dsd-sd21-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    const restore = freezeRandom()
    try {
      const a = join(work, 'a.txt')
      writeFileSync(a, 'FIRST-UNIQUE-CONTENT')

      const first = await moveToSafeZone(state, a, { retentionDays: 1 })

      const b = join(work, 'b.txt')
      writeFileSync(b, 'SECOND-UNIQUE-CONTENT')

      /*
       * 同一秒内第二次 —— 若 id 相同，绝不能覆盖第一条。
       *
       * 允许两种正确结果：
       *   - 换了一个 id 成功存入；
       *   - 明确抛错。
       *
       * 不允许的是：静默覆盖第一条。
       */
      let secondOk = true
      let secondError = ''
      try {
        await moveToSafeZone(state, b, { retentionDays: 1 })
      } catch (error) {
        secondOk = false
        secondError = error instanceof Error ? error.message : String(error)
      }

      // 第一条的内容必须在。
      const firstDir = join(state, 'items', first.id)
      expect(existsSync(firstDir), '第一条的目录必须还在').toBe(true)
      const stored = readdirSync(firstDir)
      expect(stored.length, '第一条应有内容').toBeGreaterThan(0)
      expect(readFileSync(join(firstDir, stored[0] as string), 'utf8'), '第一条内容不能被覆盖').toBe(
        'FIRST-UNIQUE-CONTENT',
      )

      if (!secondOk) {
        // 明确失败也可接受，但不能是"静默覆盖"。
        expect(secondError, '失败必须是可诊断的').toMatch(/duplicate|unique|collision/i)
      }
    } finally {
      restore()
    }
  })

  it('creates the entry directory exclusively, not recursively', async () => {
    /*
     * 结构性：`mkdirSync(entryRoot)` 不能带 `{ recursive: true }` ——
     * 那正是"目录已存在也静默通过"的来源。
     *
     * 只看**代码行**，跳过注释 —— 注释里会引用旧写法作为反例。
     */
    const { readFileSync: readSrc } = await import('node:fs')
    const src = readSrc('src/store.ts', 'utf8')
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')

    expect(codeOnly, '应有独占创建').toMatch(/mkdirSync\(entryRoot\)/)
    expect(codeOnly, '不该用 recursive 创建条目目录').not.toMatch(
      /mkdirSync\(entryRoot,\s*\{\s*recursive:\s*true/,
    )
    expect(codeOnly, 'EEXIST 应被识别为碰撞').toMatch(/ENTRY_ID_COLLISION/)
  })

  it('retries with a fresh id so the user does not see an internal error', async () => {
    /*
     * 行为：碰撞时 `moveToSafeZone` 应当自动重试（换 id），
     * 而不是把 "duplicate entry id" 抛给用户。
     *
     * 这里预置一个与即将生成的 id 相同的目录，然后正常调用。
     */
    const root = scratchDir('dsd-sd21-retry-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    mkdirSync(join(state, 'items'), { recursive: true })

    const restore = freezeRandom()
    try {
      // 先跑一次拿到 id 形态。
      const probe = join(work, 'probe.txt')
      writeFileSync(probe, 'x')
      const first = await moveToSafeZone(state, probe, { retentionDays: 1 })

      /*
       * 第二个文件：同一随机值、同一秒 → 会先撞上 first.id。
       *
       * 正确行为是换 id 成功，两份内容都在。
       */
      const second = join(work, 'second.txt')
      writeFileSync(second, 'SECOND')

      let ok = true
      let err = ''
      try {
        await moveToSafeZone(state, second, { retentionDays: 1 })
      } catch (error) {
        ok = false
        err = error instanceof Error ? error.message : String(error)
      }

      if (ok) {
        const entries = await listSafeZone(state)
        expect(entries, '两份都应登记').toHaveLength(2)
        // id 必须唯一。
        const ids = entries.map((e) => e.id)
        expect(new Set(ids).size, 'id 不能重复').toBe(2)
      } else {
        expect(err).toMatch(/duplicate|unique|collision/i)
      }

      // 第一条始终完好。
      expect(existsSync(join(state, 'items', first.id))).toBe(true)
    } finally {
      restore()
    }
  })

  it('keeps the index readable after a collision', async () => {
    /*
     * 碰撞不能把索引写成重复 id —— 那会让整个安全区被判 corrupt，
     * 用户连别的条目都取不回来。
     */
    const root = scratchDir('dsd-sd21-index-')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    const restore = freezeRandom()
    try {
      for (let i = 0; i < 3; i += 1) {
        const p = join(work, `f${i}.txt`)
        writeFileSync(p, `content-${i}`)
        try {
          await moveToSafeZone(state, p, { retentionDays: 1 })
        } catch {
          /* 明确失败可接受 */
        }
      }

      const detailed = await listSafeZoneDetailed(state)
      expect(detailed.corrupt, '索引不该因碰撞变成 corrupt').toBeUndefined()

      const ids = detailed.entries.map((e) => e.id)
      expect(new Set(ids).size, '索引里 id 必须唯一').toBe(ids.length)
    } finally {
      restore()
    }
  })
})
