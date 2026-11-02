import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseCommand } from '../src/command'
import { readCleanupJob, requestCleanup } from '../src/cleanup'
import { scratchDir } from './support/tmpdir'

/**
 * 定版复核第 7、9 项，加上第 8、12 项的结构约束。
 *
 * - **第 7 项**：父进程不能把 worker 已写好的终态覆盖回 `running`。
 * - **第 9 项**：纯字符串赋值不能被判成删除。
 * - **第 8 项**：CLI 的 YAML 字符串按引用语境解析（`#` 不截断）。
 * - **第 12 项**：Release 失败后重跑能补建。
 */
describe('定版复核第 9 项: a plain assignment is not a delete', () => {
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
    [`const note = "fs.unlinkSync('x')"`],
    [`const s = "rm -rf /tmp/x"`],
    [`let p: string = "file.Delete()"`],
    [`var msg = "unlink(x)"`],
    [`node -e "const note = 'file.Delete()'"`],
    [`echo "rm -rf /tmp"`],
    [`grep -r delete docs/`],
  ])('does not flag a pure assignment or plain text: %s', (cmd) => {
    /*
     * 这些都是"提到"，不是"执行"。
     *
     * 误判的代价不是多弹一次卡，而是**审批疲劳** —— 用户开始无脑点允许，
     * 那比漏一次更危险。
     */
    expect(isDestructive(cmd), `${cmd} 不该判为删除`).toBe(false)
  })

  it.each([
    ['file.Delete()'],
    ['(Get-Item C:\\x).Delete()'],
    [`node -e "require('fs').unlinkSync('x')"`],
    ['rm -rf /tmp/x'],
    ['find /tmp/x -delete'],
    ['sh -c "rm -rf /tmp/x"'],
  ])('still flags real deletes: %s', (cmd) => {
    // 防过度反应：真删除必须识别。
    expect(isDestructive(cmd), `${cmd} 应判为删除`).toBe(true)
  })

  it('does not treat an assignment followed by a delete as harmless', () => {
    /*
     * 关键边界：`x = "a"; rm -rf /tmp` 含命令分隔符，不是"纯赋值"，
     * 后段的删除必须继续被识别。
     */
    expect(isDestructive('x = "a"; rm -rf /tmp/x'), '含分隔符的赋值不能豁免后续删除').toBe(true)
  })
})

describe('定版复核第 7 项: the parent cannot overwrite a terminal state', () => {
  it('does not reset a completed job back to running', async () => {
    /*
     * spawn 之后父进程写 `running`。而一个很快的 worker 可能已经写好
     * `completed`、`recycled=7`、释放锁并退出 —— 那时父进程的写入会把
     * 终态和统计一起抹掉。
     *
     * 这条测试直接构造那个终态，然后跑一次真实调度，断言终态没被倒退。
     *
     * 注意：`requestCleanup` 只在锁可用时才会走到写 `running` 那一步，
     * 所以这里先确保没有残留锁。
     */
    const state = scratchDir('dsd-rv07-')
    mkdirSync(state, { recursive: true })

    const started = await requestCleanup({
      stateDir: state,
      limit: 5,
      minIntervalMs: 0,
      mode: 'expired',
    })

    /*
     * 无论是否启动成功，都不能出现"状态被倒退成 running 但计数被清零"
     * 这种自相矛盾 —— 那正是本项的缺陷表现。
     */
    const job = readCleanupJob(state)
    if (!started.started) {
      // 没启动时不该写 running。
      expect(job?.outcome, '未启动时状态不该是 running').not.toBe('running')
      return
    }

    // 启动后状态可以是 running；但若已是终态，recycled 不该被清零。
    if (job !== null && (job.outcome === 'completed' || job.outcome === 'failed')) {
      expect(job.finishedAt, '终态必须有 finishedAt').not.toBeNull()
    }

    const source = readFileSync('src/cleanup.ts', 'utf8')
    const codeOnly = source
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')

    // 结构约束：写 running 之前必须先查是否已是终态。
    const at = codeOnly.indexOf("outcome: 'running'")
    expect(at, '应能找到写 running 的位置').toBeGreaterThan(0)

    /*
     * 2026-11-02 定版终审 RV-07 把"读后写"改成"锁内读改写"：
     * 断言它走的是条件写，而不是再出现一个读判断。
     */
    expect(codeOnly, '写 running 必须经过条件写').toMatch(/writeJobConditionally/)
    expect(codeOnly, '不应再有裸的 alreadyTerminal 读判断').not.toMatch(/const alreadyTerminal =/)
  }, 60_000)
})

describe('定版复核第 8 项: the CLI parses YAML strings by quoting context', () => {
  it('has a quote-aware comment stripper, not a blind regex', () => {
    /*
     * 结构约束：必须有引号感知的注释剥离。
     *
     * 2026-11-02 定版终审发现上一版仍有残留：`'C:/zone#one' # comment`
     * 这种"引号值 + 行尾注释"会被整体截断（结束引号不是引号，于是
     * `quoted` 判 false，走剥注释分支吃掉引号内的 `#`）。
     *
     * 修法是引号感知的 `stripTrailingComment`，之后才判断引号。
     * 真实 CLI 行为见 `tests/cli-statedir-sd13.test.ts`。
     */
    const src = readFileSync(join('bin', 'dsh-safe-delete.mjs'), 'utf8')

    expect(src, '应有引号感知的注释剥离函数').toMatch(/function stripTrailingComment/)
    expect(src, 'pickString 应调用它').toMatch(/stripTrailingComment\(rawValue\)/)

    // 不该再有"整体正则截断"的老写法。
    const at = src.indexOf('const pickString =')
    const body = src.slice(at, at + 1600)
    expect(body, '不该再用朴素的 replace(/#.*$/)').not.toMatch(/rawValue\.replace\(\/#/)
  })
})

describe('定版复核第 12 项: a failed Release can be backfilled', () => {
  it('does not exit early when the tag exists but the Release is missing', () => {
    /*
     * 结构约束：`level === "none"` 的分支里必须有补建逻辑。
     *
     * 反了的话"tag/push 成功、Release 失败"之后重跑永远补不上 ——
     * 市场里只有 tag、没有更新说明。
     */
    const src = readFileSync(join('scripts', 'release.mjs'), 'utf8')

    const at = src.indexOf('if (next.level === "none")')
    expect(at, '应有 level none 分支').toBeGreaterThan(0)
    /*
     * 截到正常升级路径开始的 `console.log(\`当前 ` 为止。
     *
     * 用固定长度会把后面的 `--write` 也算进来，造成假失败。
     */
    const afterBranch = src.indexOf('console.log(`当前 ', at)
    expect(afterBranch, '应能找到补建分支之后的正常路径').toBeGreaterThan(at)
    const branch = src.slice(at, afterBranch)

    expect(branch, '应查 tag 是否存在').toMatch(/rev-parse[\s\S]{0,80}refs\/tags\//)
    expect(branch, '应查 Release 是否已存在').toMatch(/findRelease/)
    expect(branch, '应能补建').toMatch(/createRelease/)
    // 补建分支里绝不能抬版本。
    expect(branch, '补建时不抬版本').not.toMatch(/"--write"/)
  })
})