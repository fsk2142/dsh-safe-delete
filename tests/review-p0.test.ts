import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseCommand } from '../src/command'
import { apply } from '../src/index'
import { makeFakeCtx } from './support/fake-ctx'
import { scratchDir } from './support/tmpdir'

/**
 * 审查报告 P0-1：只读命令开头 + 分隔符 + 删除动词曾经整条放行。
 *
 * 这类绕过不需要任何技巧（`cat list | xargs rm` 是最常见的写法之一），
 * 所以必须有测试钉住。之前所有测试与探针恰好都只覆盖「首词非只读」的管道。
 */
describe('P0-1: a read-only first word must not excuse a later delete', () => {
  const bypasses = [
    'echo hi; rm -rf /tmp/x',
    'echo hi && rm -rf /tmp/x',
    'echo hi || rm -rf /tmp/x',
    'echo hi\nrm -rf /tmp/x',
    'Write-Host "x"; Remove-Item -Recurse C:\\x',
    'cat /tmp/list | xargs rm -rf',
    'Get-Content list.txt | Remove-Item -Recurse',
    'type file.txt & rd /s /q C:\\x',
  ]

  for (const command of bypasses) {
    it(`treats ${JSON.stringify(command)} as destructive`, () => {
      expect(parseCommand(command).destructive).toBe(true)
    })
  }

  const legitimate = [
    'echo "rm -rf /tmp"',
    'grep -rn "rm -rf" docs/',
    '// never run rm -rf here',
    '# rm -rf the old build',
    'cat README.md',
    'Get-Content log.txt',
    'echo done',
    'Write-Host "starting build"',
  ]

  for (const command of legitimate) {
    it(`still allows ${JSON.stringify(command)}`, () => {
      expect(parseCommand(command).destructive).toBe(false)
    })
  }
})

/**
 * 审查报告 P0-2：「单次删除太大量也要确认」在生产接线中曾经完全不生效。
 *
 * 原因：pre-execute 只判路径危险度，而 `deletePath` 内部的阈值确认走
 * `requestApproval`，那个回调在生产里恒返回 allowed-once。两头落空。
 *
 * 这些测试**必须走 `apply()` 接线**，而不是直接调 `deletePath` ——
 * 后者正是之前 `thresholds.test.ts` 的做法，所以它全绿而功能为空。
 */
describe('P0-2: the size threshold must be wired into pre-execute', () => {
  function setup() {
    const root = scratchDir('dsd-p02-')
    const home = join(root, 'home')
    const state = join(root, 'state')
    const work = join(root, 'work')
    mkdirSync(home, { recursive: true })
    mkdirSync(work, { recursive: true })
    mkdirSync(state, { recursive: true })
    return { root, home, state, work }
  }

  it('asks before moving a directory that exceeds confirmFileCount', async () => {
    const { state, work, home } = setup()
    const big = join(work, 'big')
    mkdirSync(big, { recursive: true })
    for (let i = 0; i < 40; i += 1) writeFileSync(join(big, `f${i}.txt`), 'x')

    const ctx = makeFakeCtx({ home, approvalPolicy: 'ask' })
    apply(ctx as never, { stateDir: state, confirmFileCount: 10, confirmBytes: 0 })

    const decision = await ctx.preExecute({ name: 'safe_delete', arguments: { path: big } })
    expect(decision.kind).toBe('ask')
  })

  it('allows a directory below the threshold', async () => {
    const { state, work, home } = setup()
    const small = join(work, 'small')
    mkdirSync(small, { recursive: true })
    writeFileSync(join(small, 'a.txt'), 'x')

    const ctx = makeFakeCtx({ home, approvalPolicy: 'ask' })
    apply(ctx as never, { stateDir: state, confirmFileCount: 10, confirmBytes: 0 })

    const decision = await ctx.preExecute({ name: 'safe_delete', arguments: { path: small } })
    expect(decision.kind).toBe('allow')
  })

  it('never asks during a preview', async () => {
    const { state, work, home } = setup()
    const big = join(work, 'big')
    mkdirSync(big, { recursive: true })
    for (let i = 0; i < 40; i += 1) writeFileSync(join(big, `f${i}.txt`), 'x')

    const ctx = makeFakeCtx({ home, approvalPolicy: 'ask' })
    apply(ctx as never, { stateDir: state, confirmFileCount: 10, confirmBytes: 0 })

    const decision = await ctx.preExecute({
      name: 'safe_delete',
      arguments: { path: big, preview: true },
    })
    expect(decision.kind).toBe('allow')
  })

  it('states which limit was crossed on the card', async () => {
    const { state, work, home } = setup()
    const big = join(work, 'big')
    mkdirSync(big, { recursive: true })
    for (let i = 0; i < 40; i += 1) writeFileSync(join(big, `f${i}.txt`), 'x')

    const ctx = makeFakeCtx({ home, approvalPolicy: 'ask' })
    apply(ctx as never, { stateDir: state, confirmFileCount: 10, confirmBytes: 0 })

    const decision = await ctx.preExecute({ name: 'safe_delete', arguments: { path: big } })
    const reason = String((decision as { reason?: string }).reason)
    expect(reason).toMatch(/exceeds the limit of 10/)
  })

  it('treats 0 as disabled', async () => {
    const { state, work, home } = setup()
    const big = join(work, 'big')
    mkdirSync(big, { recursive: true })
    for (let i = 0; i < 40; i += 1) writeFileSync(join(big, `f${i}.txt`), 'x')

    const ctx = makeFakeCtx({ home, approvalPolicy: 'ask' })
    apply(ctx as never, { stateDir: state, confirmFileCount: 0, confirmBytes: 0 })

    const decision = await ctx.preExecute({ name: 'safe_delete', arguments: { path: big } })
    expect(decision.kind).toBe('allow')
  })
})
