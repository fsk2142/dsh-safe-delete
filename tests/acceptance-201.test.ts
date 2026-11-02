import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseCommand } from '../src/command'
import { readCleanupJob, requestCleanup } from '../src/cleanup'
import { scratchDir } from './support/tmpdir'

/**
 * 2026-11-02 定版验收（2.0.1）的 2 项 P1 与 2 项次级残留。
 *
 * 这里的每一项都是我前几轮修复引起的回归或未闭环，不是新需求。
 */
describe('验收 P1-2: backticks are command substitution in Bash', () => {
  /**
   * 判断是否判为删除。
   *
   * @param cmd 命令。
   * @returns 判为删除返回 true。
   */
  function isDestructive(cmd: string): boolean {
    return (parseCommand(cmd) as { destructive?: boolean })?.destructive === true
  }

  it.each([
    ['result=`rm -rf /tmp/x`', 'plain rm'],
    ['result=`find /tmp -delete`', 'argument-level delete'],
    ['result=`fs.rmSync("x")`', 'method call'],
    ['const s = `x ${require("fs").rmSync("y")}`', 'interpolation'],
  ])('detects a delete inside a backtick block: %s', (cmd) => {
    /*
     * 在 Bash 里反引号是命令替换，会被执行。上一版只按 JavaScript 规则
     * 判断（"无插值就是纯字面量"），于是 `result=`rm -rf /tmp/x`` 被判无害。
     */
    expect(isDestructive(cmd), `${cmd} 的反引号部分会被执行`).toBe(true)
  })

  it.each([
    ['const s = `plain text`'],
    ['const s = `hello world`'],
    ['const t = `a b c`'],
  ])('does not flag a backtick block with no delete content: %s', (cmd) => {
    // 反引号里没有删除内容时仍是纯字面量，不误拦。
    expect(isDestructive(cmd), `${cmd} 不该判为删除`).toBe(false)
  })

  it('still detects $() substitution', () => {
    // 回归：`$(...)` 与反引号是同一能力的两种写法，两条都要识别。
    expect(isDestructive('result=$(rm -rf /tmp/x)')).toBe(true)
  })
})

describe('验收 P2: a trailing semicolon does not make a literal assignment a delete', () => {
  /**
   * 判断是否判为删除。
   *
   * @param cmd 命令。
   * @returns 判为删除返回 true。
   */
  function isDestructive(cmd: string): boolean {
    return (parseCommand(cmd) as { destructive?: boolean })?.destructive === true
  }

  it.each([
    ['const note = "rm -rf /tmp";'],
    [`const s = 'fs.unlinkSync(x)';`],
    ['let n = 42;'],
    ['const x = "a"  ;'],
  ])('allows a trailing semicolon on a literal assignment: %s', (cmd) => {
    /*
     * 上一版第一行就是 `/[;&|\n\r]/` 直接拒绝 —— 后面"允许一个尾分号"
     * 的逻辑因此永远不可达。普通赋值多一个分号就弹审批。
     */
    expect(isDestructive(cmd), `${cmd} 只是赋值加收尾分号`).toBe(false)
  })

  it.each([
    ['x = "a"; rm -rf /tmp'],
    ['const s = "a"; fs.rmSync("x")'],
  ])('still flags a delete that follows the semicolon: %s', (cmd) => {
    // 分号后还有语句时必须继续判定 —— 不能因为放行尾分号就放过真实删除。
    expect(isDestructive(cmd), `${cmd} 分号后有真删除`).toBe(true)
  })
})

describe('验收 RV-07: only the worker writes cleanup state', () => {
  it('has a single state writer (the worker)', () => {
    /*
     * 三轮修补都失败，最终确认方向错了：只给一侧加锁挡不住不拿锁的另一侧。
     *
     * 现在收成**单写者** —— worker 持有清理锁，也只有它写 running 和终态。
     */
    const read = (p: string): string =>
      readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')

    const parent = read('src/cleanup.ts')
    expect(parent, '父进程不该写 running').not.toMatch(/outcome: 'running'/)
    expect(parent, '父进程不该写 completed').not.toMatch(/outcome: 'completed'/)

    const worker = read('src/cleanup-worker.ts')
    expect(worker, 'worker 应写 running').toMatch(/outcome: 'running'/)
    expect(worker, 'worker 应写终态').toMatch(/outcome: 'completed'/)
  })

  it('records a failure when the worker dies before writing any state', async () => {
    /*
     * 单写者的代价：worker 在写 running 之前就崩溃时，没人写状态。
     *
     * 父进程的 exit 处理器因此必须按 `requestId` 归属兜底 ——
     * 不再要求"状态已经是 running"（那条件在新架构下永不成立）。
     */
    const state = scratchDir('dsd-acc-rv07-')
    mkdirSync(state, { recursive: true })

    const started = await requestCleanup({
      stateDir: state,
      limit: 5,
      minIntervalMs: 0,
      mode: 'expired',
    })

    if (!started.started) {
      // 没启动就什么都不该写。
      expect(readCleanupJob(state)?.outcome, '未启动时不该写状态').not.toBe('running')
      return
    }

    // 启动后等它跑完（worker 会写终态）。
    const deadline = Date.now() + 25_000
    let outcome: string | undefined
    while (Date.now() < deadline) {
      outcome = readCleanupJob(state)?.outcome
      if (outcome === 'completed' || outcome === 'failed') break
      await new Promise((r) => setTimeout(r, 100))
    }

    expect(['completed', 'failed'], '必须收敛到终态，不能停在 running').toContain(outcome)
    // 锁必须释放。
    const leftovers = readdirSync(state).filter((n) => n === 'cleanup.lock')
    expect(leftovers, '结束后不该残留清理锁').toHaveLength(0)
  }, 60_000)

  it('does not leave a lock behind when the worker cannot even load', () => {
    /*
     * 这条守住"操作失败但系统可继续"：锁必须被释放，
     * 否则下一次清理会被卡住。
     */
    const state = scratchDir('dsd-acc-lock-')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'cleanup.lock'), JSON.stringify({
      pid: 999_999_999,
      at: Date.now() - 3600_000,
      token: 'dead',
    }))

    // 陈旧锁不再被接管（2.0 起的策略）；确认它原样保留且可诊断。
    const before = readFileSync(join(state, 'cleanup.lock'), 'utf8')
    return requestCleanup({ stateDir: state, limit: 5, minIntervalMs: 0, mode: 'expired' }).then(
      (r) => {
        expect(r.started, '陈旧锁不该被接管').toBe(false)
        expect(readFileSync(join(state, 'cleanup.lock'), 'utf8'), '锁内容不能变').toBe(before)
        expect(existsSync(join(state, 'cleanup.lock'))).toBe(true)
      },
    )
  }, 60_000)
})
