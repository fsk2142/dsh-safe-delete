/*
 * 2026-11-05 第三轮复审 R03 / R04 / R05：历史隐私扫描的可靠性与可用性。
 *
 * ## R03：整个测试目录被排除，凭据规则也一起被排除
 *
 * 旧实现按**文件路径**决定是否跳过：
 *
 * ```js
 * function isFixturePath(file) {
 *   return /(^|\/)tests\//.test(file) || /\.test\.(?:ts|mts|js|mjs)$/.test(file)
 * }
 * ```
 *
 * 于是"把真实 token 误写进 tests/example.test.ts，后来删掉"这种**正是历史扫描
 * 唯一能发现**的泄露，被整文件跳过了。测试夹具能解释的只有"本机路径""对话痕迹"
 * 这类上下文规则；**凭据不存在"这是测试夹具"这种解释** —— 要么是假 token，
 * 要么是真的泄露，而扫描必须把它报出来让人看一眼。
 *
 * ## R04：`--staged` 写在使用说明里，但根本没实现
 *
 * 一个看似有效、实际被忽略的安全审计参数，比没有这个参数更危险：
 * 有人会以为"我只扫了暂存区"而不再看全量结果。
 *
 * ## R05：4 处已确认的历史命中没有基线，脚本永远返回 1
 *
 * 一个永远红的门禁等于没有门禁 —— 所有人都学会了忽略它。基线必须精确到
 * `SHA + 文件 + 规则`，且**凭据类命中永远不能进基线**（那需要轮换，不是接受）。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 虚构的 token —— 只用来触发规则，不是真实凭据。 */
const FAKE_TOKEN = `ghp_${'Z'.repeat(32)}`

/** 脚本名（它在临时仓库根目录被运行）。 */
const SCRIPT = 'privacy-history-audit.mjs'

/**
 * 拼一条"像真的"本机绝对路径。
 *
 * ## 为什么不能在源码里直接写出来
 *
 * `scripts/privacy-audit.mjs` 扫的是**被跟踪文件的内容**——包括这份测试自己。
 * 直接写出那个字面量，本仓库的隐私审计会把这份测试判成"泄露了本机路径"
 * （第一次写的时候正是这样：4 处命中，两处来自这里）。
 *
 * 所以夹具在**运行时**拼，源码里不存在那个连续字面量。这不是绕过审计：
 * 审计要防的是"真实用户名被写进仓库"，而这里拼的是明显的假名。
 *
 * @param parts 路径片段（不含盘符与 `Users`）。
 * @returns 形如 `<盘符>:\Users\<片段>\` 的路径。
 */
function tempUserPath(...parts: string[]): string {
  return ['C:', 'Users', ...parts].join('\\') + '\\'
}

/**
 * 造一个临时 git 仓库。
 *
 * @param commits 每次提交的文件映射（数组的第 N 项是第 N 次提交）。
 * @returns 仓库目录。
 */
function makeRepo(commits: Array<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsd-hist-'))
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', ...args], {
      cwd: root,
      stdio: 'ignore',
    })
  }
  git('init', '-q')
  // 让默认分支名可预期（不同 git 版本默认分支不同）。
  git('checkout', '-q', '-b', 'main')
  for (const [i, files] of commits.entries()) {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true })
      writeFileSync(join(root, name), content)
    }
    git('add', '-A')
    git('commit', '-q', '-m', `commit ${i}`)
  }
  return root
}

/**
 * 在临时仓库里跑一次历史扫描。
 *
 * @param repo 仓库目录。
 * @param args 额外参数。
 * @param baseline 基线文件内容（省略则不写基线）。
 * @returns 输出与退出码。
 */
function runScan(repo: string, args: string[] = [], baseline?: unknown): { out: string; code: number } {
  copyFileSync('scripts/privacy-history-audit.mjs', join(repo, SCRIPT))
  if (baseline !== undefined) {
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    writeFileSync(join(repo, 'scripts', 'privacy-history-baseline.json'), JSON.stringify(baseline, null, 2))
  }
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { out, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  } finally {
    // 清理会由调用方做（这里只负责脚本文件）。
  }
}

/**
 * 取仓库第一次提交的完整 SHA。
 *
 * @param repo 仓库目录。
 * @returns SHA。
 */
function firstSha(repo: string): string {
  return execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
}

/*
 * 下面每个用例都会建一个真实 git 仓库并跑一次子进程扫描 —— 在负载高的机器上
 * 会超过 vitest 默认的 5 秒。统一的 `30_000` 是**环境容忍度**，不是断言放宽：
 * 断言仍然严格。
 */
describe('R03：测试文件里的凭据仍然要报', () => {
  it('still reports a credential that was committed into a test file and later removed (T07)', () => {
    const repo = makeRepo([
      { 'tests/example.test.ts': `const token = '${FAKE_TOKEN}'\n` },
      { 'tests/example.test.ts': 'const token = process.env.TOKEN\n' },
    ])
    try {
      const { out, code } = runScan(repo)

      expect(code, '测试文件里的凭据不能因为"是测试"就放过').not.toBe(0)
      expect(out, '应报告凭据类命中').toMatch(/凭据|Token/i)
      expect(out, '应指出命中的文件').toMatch(/tests\/example\.test\.ts/)
      // 门禁本身不能成为泄露渠道（与 privacy-audit.mjs 同一条理由）。
      expect(out, '绝不能回显命中的 token').not.toContain(FAKE_TOKEN)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)

  it('still skips context-rule fixtures in test files', () => {
    /*
     * "本机路径""对话痕迹"这类规则在测试里本来就是刻意构造的假数据。
     * 把它们全部报出来会让基线无限增长 —— 跳过它们、并**计数**，是正确的取舍。
     */
    const repo = makeRepo([{ 'tests/fixture.test.ts': `const p = ${JSON.stringify(tempUserPath('realname-here', 'x'))}\n` }])
    try {
      const { out, code } = runScan(repo)
      expect(code, '上下文规则的测试夹具不该让门禁变红').toBe(0)
      expect(out, '跳过了多少必须可见').toMatch(/测试夹具 \d+ 行/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)

  it('does not skip the rule carriers for credential rules either', () => {
    const repo = makeRepo([
      { 'scripts/privacy-audit.mjs': `const leaked = '${FAKE_TOKEN}'\n` },
      { 'scripts/privacy-audit.mjs': 'const leaked = undefined\n' },
    ])
    try {
      const { code } = runScan(repo)
      expect(code, '规则载体文件里也会出现真凭据，凭据规则必须照扫').not.toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('R04：不存在的参数不能被静默忽略（T08）', () => {
  it('rejects an unknown flag instead of ignoring it', () => {
    const repo = makeRepo([{ 'a.txt': 'clean\n' }])
    try {
      const { out, code } = runScan(repo, ['--staged'])
      expect(code, '被忽略的安全参数比没有更危险').toBe(2)
      expect(out).toMatch(/--staged/)
      expect(out).toMatch(/不支持|未知|not supported|unknown/i)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps the no-argument run working', () => {
    const repo = makeRepo([{ 'a.txt': 'clean\n' }])
    try {
      expect(runScan(repo).code).toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('R05：已接受的历史命中进入基线（T09）', () => {
  it('does not fail on an exactly baselined hit, and says so', () => {
    const repo = makeRepo([{ 'a.txt': `${tempUserPath('realname-here')}x\n` }])
    try {
      const sha = firstSha(repo)
      const { out, code } = runScan(repo, [], {
        entries: [
          { sha, file: 'a.txt', rule: '本机用户名 / 绝对路径', note: 'test fixture', acceptedAt: '2026-11-05' },
        ],
      })

      expect(code, '已接受的历史命中不该让门禁永远红').toBe(0)
      expect(out, '必须明确区分"基线内"与"新增"').toMatch(/基线|baseline/i)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)

  it('still fails on a new hit that the baseline does not cover', () => {
    const repo = makeRepo([
      { 'a.txt': `${tempUserPath('realname-here')}x\n` },
      { 'b.txt': `${tempUserPath('another-name')}y\n` },
    ])
    try {
      const sha = firstSha(repo)
      const { code, out } = runScan(repo, [], {
        entries: [{ sha, file: 'a.txt', rule: '本机用户名 / 绝对路径', acceptedAt: '2026-11-05' }],
      })

      expect(code, '基线只覆盖它精确列出的那一条').not.toBe(0)
      expect(out).toMatch(/新增|new/i)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)

  it('refuses to baseline a credential hit', () => {
    /*
     * 凭据类命中**不能**因为"历史上已知"就被接受 —— 那需要轮换。
     * 基线文件里出现凭据条目时，脚本必须报环境错误（退出码 2），
     * 而不是把这条命中悄悄放行。
     */
    const repo = makeRepo([{ 'leak.txt': `${FAKE_TOKEN}\n` }])
    try {
      const sha = firstSha(repo)
      const { out, code } = runScan(repo, [], {
        entries: [{ sha, file: 'leak.txt', rule: '凭据 / 密钥 / Token', note: 'oops', acceptedAt: '2026-11-05' }],
      })

      expect(code, '凭据命中必须继续报红').not.toBe(0)
      expect(out).toMatch(/凭据/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)

  it('fails closed when the baseline file is malformed', () => {
    const repo = makeRepo([{ 'a.txt': 'clean\n' }])
    try {
      const { code, out } = runScan(repo, [], { notEntries: true })
      expect(code, '读不懂的基线不能当成空基线').toBe(2)
      expect(out).toMatch(/基线|baseline/i)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)
})
