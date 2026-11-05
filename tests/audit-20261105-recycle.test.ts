/*
 * 2026-11-05 复审 A05 / A06 的回归：回收站结果必须**逐条对账**。
 *
 * ## A05：Shell 部分成功后整批被标记失败
 *
 * `SHFileOperationW` 返回非零或 `fAnyOperationsAborted` 时，PowerShell 脚本把
 * `$present` 全体记成失败，**不检查每条路径是否实际上已经移走**。于是
 * `recycleManyToSystemBin` 返回 `ok:false, recycled:0`，工具对**全部**原目标
 * 重新走 `moveManyToSafeZone`：已经进回收站的那些此时不存在，报 "not found"，
 * 用户看到「回落安全区」，实际一部分已在回收站 —— 去向说明与审计都与事实不符。
 *
 * ## A06：调用方还在解析人类可读字符串
 *
 * 结构化字段 `failedPaths` 早就有了，但 `deleteMany` 仍用
 * `line.split(' : ')[0]` 从错误文案反推路径。路径含 ` : ` 时截断 → 失败被记成成功。
 */
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTools } from '../src/tools'
import { parseRecycleManyOutput } from '../src/recycle'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-audit-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function stateDir(): string {
  return join(root, 'state')
}

function journal(): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(stateDir(), 'journal.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    return []
  }
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    stateDir: stateDir(),
    env: {
      home: join(root, 'home'),
      workdir: join(root, 'work'),
      dshHome: join(root, 'home', '.dsh'),
      safeZoneDir: stateDir(),
      tmpdir: join(root, 'not-the-temp'),
    },
    retentionDays: 1,
    confirmFileCount: 0,
    confirmBytes: 0,
    crossVolumeCopy: false,
    destination: 'recycle-bin',
    requestApproval: async () => 'allowed-once',
    ...overrides,
  }
}

function safeDelete(overrides: Record<string, unknown> = {}) {
  const tool = createTools(deps(overrides) as never).find((t) => t.name === 'safe_delete')
  if (tool === undefined) throw new Error('safe_delete not found')
  return tool
}

describe('A06: per-path identity comes from structured fields, not from error text', () => {
  it('does not record a path as recycled when the report says it failed', async () => {
    /*
     * 路径里**不能**用 ` : ` 来构造用例：那是 Windows 非法文件名字符，
     * `rename` 会 EINVAL（实测），测的就不是身份判定了。
     *
     * 真正要锁的行为是：`ok: true` 只是批级汇总，**逐条失败清单**才是身份。
     * 旧代码只读 `ok`，于是 `{ ok: true, recycled: 0, failedPaths: [target] }`
     * 这条会被记成「已进回收站」并返回 kind:'recycled'。
     */
    const target = join(root, 'plain.txt')
    writeFileSync(target, 'x')

    const tool = safeDelete({
      recyclerMany: () => ({
        ok: true,
        recycled: 0,
        failed: [`${target} : not found`],
        failedPaths: [target],
      }),
    })

    const result = (await tool.execute({ path: target } as never)) as { ok: boolean; text: string }

    expect(result.text, '回落后应说明去了安全区').toMatch(/safe zone/i)
    const deletes = journal().filter((r) => r.event === 'delete')
    const claimedRecycled = deletes.some(
      (r) => r.target === target && String(r.detail ?? '').includes('destination=recycle-bin cls='),
    )
    expect(claimedRecycled, '没进回收站的路径不能被记成已回收').toBe(false)
    expect(
      deletes.some((r) => String(r.detail ?? '').includes('fell back to safe zone')),
      '必须留下一条回落记录',
    ).toBe(true)
  })

  it('only falls back to the safe zone for the paths that really failed', async () => {
    const a = join(root, 'a.txt')
    const b = join(root, 'b.txt')
    writeFileSync(a, 'x')
    writeFileSync(b, 'y')

    const tool = safeDelete({
      recyclerMany: (paths: readonly string[]) => ({
        ok: true,
        recycled: paths.length - 1,
        failed: [`${b} : locked by another process`],
        failedPaths: [b],
      }),
    })

    const result = (await tool.execute({ paths: [a, b] } as never)) as { ok: boolean; text: string }
    expect(result.ok).toBe(true)
    expect(result.text).toMatch(/recycle bin/i)
    // 失败的那条要出现在输出里，成功的也要能对上。
    expect(result.text).toContain(b)
    expect(result.text).not.toMatch(/not found/i)
  })
})

describe('A05: the shell report distinguishes moved / failed / unknown', () => {
  const parse = parseRecycleManyOutput

  it('reads a per-path report that includes what actually moved', () => {
    const parsed = parse(
      JSON.stringify({
        ok: 2,
        fail: 1,
        moved: ['C:\\a.txt', 'C:\\b.txt'],
        errors: [{ path: 'C:\\c.txt', message: 'operation aborted by the shell' }],
      }),
    )

    expect(parsed.ok).toBe(2)
    expect(parsed.failedPaths).toEqual(['C:\\c.txt'])
    expect(parsed.succeededPaths).toEqual(['C:\\a.txt', 'C:\\b.txt'])
  })

  it('does not claim zero moved when the shell reports an aborted batch that moved some', () => {
    /*
     * 真实形态：`SHFileOperationW` 返回非零、`fAnyOperationsAborted` 为真，
     * 但其中一部分确实已经进了回收站。脚本对每条路径复核存在性后，
     * 用 `moved` 报告已消失的那些。
     */
    const parsed = parse(
      JSON.stringify({
        ok: 1,
        fail: 2,
        moved: ['C:\\moved.txt'],
        errors: [
          { path: 'C:\\still-there.txt', message: 'SHFileOperation returned 0x1' },
          { path: 'C:\\locked.txt', message: 'SHFileOperation returned 0x1' },
        ],
      }),
    )

    expect(parsed.ok, '已经移走的那一条必须算成功').toBe(1)
    expect(parsed.failedPaths).toHaveLength(2)
    expect(parsed.succeededPaths).toEqual(['C:\\moved.txt'])
  })

  it('rejects a report whose counts do not add up', () => {
    // 声称 ok=5 但只给了 1 条 moved、0 条错误 —— 对不上就不能当成功。
    const parsed = parse(
      JSON.stringify({ ok: 5, fail: 0, moved: ['C:\\only.txt'], errors: [] }),
    )
    expect(parsed.inconsistent).toBe(true)
  })
})
