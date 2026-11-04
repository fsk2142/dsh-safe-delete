/*
 * 参数校验的一致性（2026-11-04 自检）。
 *
 * ## 发现的问题
 *
 * `exclude` 混入非字符串 → 报错（注释写着「静默忽略的后果是删得比用户预期多」）。
 * `paths`  混入非字符串 → 原实现用 `filter` 静默丢弃。
 *
 * 后果：用户传 4 个路径，工具报告「删了 2 个」，而没有任何提示说明另外 2 个
 * 被忽略了。对删除工具来说「少删」不造成数据损失，但会让人以为事情做完了。
 *
 * 两者现在统一为报错。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTools } from '../src/tools'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-args-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function safeDelete() {
  const deps = {
    stateDir: join(root, 'state'),
    env: {
      home: join(root, 'home'),
      workdir: join(root, 'work'),
      dshHome: join(root, 'home', '.dsh'),
      safeZoneDir: join(root, 'state'),
      tmpdir: join(root, 'notemp'),
    },
    retentionDays: 1,
    confirmFileCount: 0,
    confirmBytes: 0,
    crossVolumeCopy: false,
    requestApproval: async () => 'allowed-once',
  }
  const tool = createTools(deps as never).find((t) => t.name === 'safe_delete')
  if (tool === undefined) throw new Error('safe_delete not found')
  return tool
}

describe('paths 与 exclude 的校验一致性', () => {
  it('paths 混入非字符串要报错，不静默丢弃', async () => {
    const f = join(root, 'a.txt')
    writeFileSync(f, 'x')

    const result = (await safeDelete().execute({ paths: [f, 123, null] } as never)) as {
      ok: boolean
      error?: string
    }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/paths/)
  })

  it('paths 混入空字符串也要报错', async () => {
    const f = join(root, 'b.txt')
    writeFileSync(f, 'x')

    const result = (await safeDelete().execute({ paths: [f, '   '] } as never)) as {
      ok: boolean
      error?: string
    }

    expect(result.ok).toBe(false)
  })

  it('exclude 混入非字符串同样报错（两边一致）', async () => {
    const result = (await safeDelete().execute({ root, match: '*.log', exclude: ['keep/**', 42] } as never)) as {
      ok: boolean
      error?: string
    }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/exclude/)
  })

  it('纯字符串数组照常工作', async () => {
    const files = ['c.txt', 'd.txt'].map((n) => {
      const p = join(root, n)
      writeFileSync(p, 'x')
      return p
    })

    const result = (await safeDelete().execute({ paths: files } as never)) as { ok: boolean }
    expect(result.ok).toBe(true)
  })
})
