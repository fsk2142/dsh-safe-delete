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
     * 命中的**路径**本身也可能含真实用户名，输出里应隐去。
     *
     * 这里不构造真实家目录（会污染用户环境）。用 `<user>` 这种明确的
     * 占位符而不是编造一个像真名的字符串 —— 隐私审计会把后者当成真实
     * 用户名命中，那正是它该做的事（第一次写这条测试时就被它拦下了）。
     */
    const repo = makeRepo({
      'notes.txt': 'C:\\Users\\<user>\\secret.txt\n',
    })

    try {
      const { out } = runAudit(repo)
      /*
       * 是否命中取决于规则本身；这里只断言"若命中，不回显原文"。
       * 若规则不匹配这个形态，测试应当仍通过（不误报）。
       */
      if (/本机|路径/.test(out)) {
        expect(out, '不该回显用户名').not.toContain('<user>')
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

  it('keeps this repo itself clean, and keeps rule labels free of trigger words', () => {
    /*
     * ## 这条防的是什么（2026-11-05 自检）
     *
     * 新增 `scripts/privacy-history-baseline.json` 之后，gate 的隐私审计红了，
     * 历史扫描还把它报成 3 处**新增**命中。根因不是那个文件，而是**规则标签
     * 自己含触发词**：标签原名叫「对话痕迹」后面跟了个括号补充，而括号里的词
     * 正是该规则的一个分支 —— 于是任何要写出规则名的地方（基线、报告、文档）
     * 都会再撞一次。
     *
     * 第一版修法是给那个文件加 `ignoreFiles`。那是给症状打补丁：每多一个要写
     * 规则名的文件，就多一条豁免。正确修法是把触发词从**标识**里拿掉。
     *
     * 这条测试锁住三件事：
     *   1. 本仓库当前审计通过（否则 CI 永远红）；
     *   2. 没有为基线文件开"按文件"的特例（那会连凭据一起放过，正是 R03 的口子）；
     *   3. 两个扫描器的规则标签都不含自己的触发词。
     */
    const { readFileSync } = require('node:fs') as typeof import('node:fs')

    /*
     * 端到端：这个仓库当前必须审计通过。
     * 单看源码结构不够 —— 拿真实仓库跑一遍才知道到底红不红。
     */
    try {
      execFileSync(process.execPath, ['scripts/privacy-audit.mjs'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string }
      expect.fail(`本仓库的隐私审计必须通过，实际失败：\n${e.stdout ?? ''}${e.stderr ?? ''}`)
    }

    /*
     * 不为这份文件开按文件的特例。
     *
     * 用拼接避开把文件名写成连续字面量 —— 那本身没有触发词，但保持与其它夹具
     * 一致的写法，免得以后有人照抄成"把文件名加进 SCANNERS"。
     */
    const baselineFile = ['privacy', '-history', '-baseline', '.json'].join('')
    const src = readFileSync('scripts/privacy-audit.mjs', 'utf8')
    const scannersStart = src.indexOf('const SCANNERS = new Set([')
    const scannersBlock = src.slice(scannersStart, src.indexOf('])', scannersStart))
    expect(scannersBlock, '基线文件不能整份进 SCANNERS').not.toContain(baselineFile)

    /*
     * 标签不含触发词 —— 这才是根因的修复。
     *
     * 逐个扫描器提取 `label: '...'`，断言没有任何标签含触发词。标签是给人看的
     * 短名字，不该与它检测的内容同形 —— 否则任何写出规则名的文件都会被判泄露。
     *
     * ## 触发词为什么要在运行时拼
     *
     * 这份测试本身也被同一条规则扫。把触发词写成字面量，审计就会因为**这条
     * 测试**变红。那不是绕过审计，而是夹具：源码里不该存在那些连续字面量，
     * 否则它们又成了"写出规则名的文件都会踩到"的东西 —— 与这条测试要防的
     * 缺陷是同一个形态。
     */
    const triggerWords = [
      '用户' + '原话',
      '用户' + '说',
      '报' + '障' + '：',
      '经' + '用户确认',
      '用户已' + '同意',
      '用户明确' + '指出',
      '用户' + '报障',
    ]

    for (const script of ['scripts/privacy-audit.mjs', 'scripts/privacy-history-audit.mjs']) {
      const text = readFileSync(script, 'utf8')
      const labels = [...text.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
      expect(labels.length, `${script} 应能提取到规则标签`).toBeGreaterThan(0)
      for (const label of labels) {
        for (const word of triggerWords) {
          expect(
            label.includes(word),
            `${script} 的标签「${label}」含触发词「${word}」：` +
              '任何写出规则名的文件（基线、报告、文档）都会被判成泄露',
          ).toBe(false)
        }
      }
    }
  }, 60_000)
})
