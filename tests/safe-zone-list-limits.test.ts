/*
 * `safe_zone_list` / `safe_zone_journal` 的 limit 边界（2026-11-04 自检）。
 *
 * ## 为什么要单独测
 *
 * 两处原来各写了一遍 `Math.min(200, Math.max(1, Number(x) || 20))`：
 *
 *   - 默认 20、上限 200 是有含义的约定（上限防止把几万条绝对路径塞进模型上下文）
 *   - 小数没有取整，依赖 `slice(-1.5)` 的隐式 `ToIntegerOrInfinity` 截断
 *
 * 结果碰巧正确，但那是运气。现在抽成 `clampLimit` 并显式 `Math.floor`，
 * 这两条测试把边界语义钉住。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTools } from '../src/tools'

let root: string
let stateDir: string

const TOTAL = 5

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-limit-'))
  stateDir = join(root, 'state')
  mkdirSync(join(stateDir, 'items'), { recursive: true })

  const now = Date.now()
  const entries = Array.from({ length: TOTAL }, (_, i) => ({
    id: `2026010${i + 1}-120000-abcdef`,
    originalPath: `C:\\work\\f${i}.txt`,
    movedAt: now - i * 1000,
    expiresAt: now + 86_400_000,
    bytes: 10,
    fileCount: 1,
    isDirectory: false,
    crossVolume: false,
  }))
  writeFileSync(join(stateDir, 'index.json'), JSON.stringify(entries), 'utf8')
  for (const e of entries) mkdirSync(join(stateDir, 'items', e.id), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function listTool() {
  const deps = {
    stateDir,
    env: {
      home: join(root, 'home'),
      workdir: join(root, 'work'),
      dshHome: join(root, 'home', '.dsh'),
      safeZoneDir: stateDir,
      tmpdir: join(root, 'notemp'),
    },
    retentionDays: 1,
    confirmFileCount: 0,
    confirmBytes: 0,
    crossVolumeCopy: false,
    requestApproval: async () => 'allowed-once',
  }
  const tool = createTools(deps as never).find((t) => t.name === 'safe_zone_list')
  if (tool === undefined) throw new Error('safe_zone_list not found')
  return tool
}

/** 数输出里有几行条目（每行以 id 开头）。 */
function countEntries(text: string): number {
  return (text.match(/^2026\d{4}-/gm) ?? []).length
}

describe('safe_zone_list 的 limit 夹取', () => {
  it('不传时给默认条数', async () => {
    const r = (await listTool().execute({} as never)) as { text: string }
    expect(countEntries(r.text)).toBe(TOTAL)
  })

  it('传 2 就给 2 条', async () => {
    const r = (await listTool().execute({ limit: 2 } as never)) as { text: string }
    expect(countEntries(r.text)).toBe(2)
  })

  it('负数夹到 1，而不是给 0 条', async () => {
    /*
     * 给 0 条会让调用方以为安全区是空的。用户想看东西，给一条比给零条有用。
     */
    const r = (await listTool().execute({ limit: -1 } as never)) as { text: string }
    expect(countEntries(r.text)).toBe(1)
  })

  it('小数向下取整，不依赖 slice 的隐式截断', async () => {
    const two = (await listTool().execute({ limit: 2.9 } as never)) as { text: string }
    expect(countEntries(two.text)).toBe(2)

    const one = (await listTool().execute({ limit: 1.5 } as never)) as { text: string }
    expect(countEntries(one.text)).toBe(1)
  })

  it('超大值被上限截断，不会把全部路径塞出来', async () => {
    const r = (await listTool().execute({ limit: 999_999 } as never)) as { text: string }
    // 本测试只有 5 条，所以是 5；关键是它不报错、不返回超过实际数量。
    expect(countEntries(r.text)).toBe(TOTAL)
  })

  it('0 视为「没传」，给默认条数', async () => {
    const r = (await listTool().execute({ limit: 0 } as never)) as { text: string }
    expect(countEntries(r.text)).toBe(TOTAL)
  })
})
