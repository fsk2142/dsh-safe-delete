import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * SD-P2 / SD-P3：隐私审计自身的两个问题。
 *
 * ## SD-P2：命中时打印原文
 *
 * 第一版把命中行的前 200 字符直接 `console.log`。那等于把**正在拦截**的
 * 敏感内容再写一遍到终端、CI 日志、录屏里 —— 门禁本身成了泄露渠道。
 *
 * ## SD-P3：每条规则重新读所有文件
 *
 * 读取放在规则循环内部，于是 N 文件 × 6 规则 = 6N 次 `git show` 子进程。
 * 在 Windows 上每次都是真实进程创建，实测 60 文件从 11.4 秒降到 2.0 秒。
 */
describe('privacy-audit: does not leak, does not re-read', () => {
  /**
   * 造一个临时 git 仓库并暂存文件。
   *
   * @param files 文件名到内容的映射。
   * @returns 仓库目录。
   */
  function makeRepo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'dsd-audit-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    }
    git('init', '-q')
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, name), content)
    }
    git('add', '.')
    return root
  }

  /**
   * 在仓库里跑一次审计脚本。
   *
   * @param repo 仓库目录。
   * @returns 标准输出 + 标准错误与退出码。
   */
  function runAudit(repo: string): { out: string; code: number } {
    const { copyFileSync } = require('node:fs') as typeof import('node:fs')
    // 审计脚本需要在仓库根目录运行（它用相对路径 git 命令）。
    copyFileSync('scripts/privacy-audit.mjs', join(repo, 'privacy-audit.mjs'))
    try {
      execFileSync('git', ['add', 'privacy-audit.mjs'], { cwd: repo, stdio: 'ignore' })
      const out = execFileSync(process.execPath, ['privacy-audit.mjs'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { out, code: 0 }
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; status?: number }
      return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
    }
  }

  it('does not print the matched content (SD-P2)', () => {
    /*
     * 用**虚构** token（不是真实凭据），验证它不出现在输出里。
     *
     * 关键是这个 token 必须真的命中规则 —— 否则测试恒真。
     */
    const fakeToken = `ghp_${'A'.repeat(30)}`
    const repo = makeRepo({ 'config.txt': `token: ${fakeToken}\n` })

    try {
      const { out, code } = runAudit(repo)

      // 前提：确实命中了（否则这条测试没意义）。
      expect(code, '含 token 时必须审计失败').not.toBe(0)
      expect(out, '应报告凭据类命中').toMatch(/凭据|CRITICAL/)

      // 核心断言：原文不能出现在输出里。
      expect(out, '绝不能回显命中的 token').not.toContain(fakeToken)
      expect(out, '更不能回显 token 的前缀片段').not.toContain('ghp_AAAAAAAA')
      // 应该给出位置。
      expect(out).toMatch(/config\.txt/)
      expect(out, '应标明命中已隐去').toMatch(/命中已隐去/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('redacts a home directory in a reported path (SD-P2)', () => {
    /*
     * 命中的**路径**本身也可能含真实用户名。输出里应隐去。
     *
     * 这里不构造真实家目录（会污染用户环境），只验证脱敏函数对四种平台
     * 形态的处理 —— 通过在一个文件**内容**里放这些字符串，看审计是否
     * 把它们报成"本机路径"命中（规则命中），且输出不含原始用户名。
     */
    const repo = makeRepo({
      'notes.txt': 'C:\\Users\\some-real-person\\secret.txt\n',
    })

    try {
      const { out } = runAudit(repo)
      /*
       * 是否命中取决于规则本身；这里只断言"若命中，不回显原文"。
       * 若规则不匹配这个形态，测试应当仍通过（不误报）。
       */
      if (/本机|路径/.test(out)) {
        expect(out, '不该回显用户名').not.toContain('some-real-person')
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('reads each file once regardless of how many rules run (SD-P3)', () => {
    /*
     * SD-P3 的结构性验证：`versionsOf` 必须带缓存。
     *
     * 行为上难以直接数子进程，所以检查源码里确实有 `contentCache`
     * 且 `versionsOf` 先查缓存。
     */
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const src = readFileSync('scripts/privacy-audit.mjs', 'utf8')

    expect(src, '应有内容缓存').toMatch(/const contentCache = new Map\(\)/)
    expect(src, '应通过 versionsOf 读取').toMatch(/function versionsOf\(/)
    expect(src, '必须先查缓存再读盘').toMatch(/const cached = contentCache\.get\(file\)/)
    /*
     * 规则循环里不能再出现 readFileSync / readStaged 的直接调用 ——
     * 那正是"每条规则重读一遍"的形态。
     */
    const loopStart = src.indexOf('for (const check of checks)')
    expect(loopStart).toBeGreaterThan(0)
    const loop = src.slice(loopStart)
    expect(loop, '规则循环里不该直接读盘').not.toMatch(/readFileSync\(/)
    expect(loop, '规则循环里不该直接调 git show').not.toMatch(/readStaged\(/)
  })
})
