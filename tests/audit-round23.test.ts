import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { classifyPath, type ClassifyEnv } from '../src/classify'
import { createTools, type ToolDeps } from '../src/tools'
import { scratchDir } from './support/tmpdir'

/**
 * 报告里的三条 P2 —— 都是"同一份配置在不同入口/不同路径下行为不一致"。
 *
 * | 编号 | 问题 |
 * |---|---|
 * | P2-03 | TEMP 豁免排在安装目录与 node_modules 保护之前 |
 * | P2-06 | 斜杠入口漏传 crossVolumeCopy |
 * | P2-07 | CLI 把保留期写死成 7 天 |
 */
describe('P2-03: protection wins over the temp-dir exemption', () => {
  /**
   * 造一个"安装目录位于 TEMP 之下"的环境。
   *
   * @returns 分类器环境与路径。
   */
  function tempEnv(): { env: ClassifyEnv; tmpRoot: string; installDir: string } {
    const root = scratchDir('dsd-p203-')
    const tmpRoot = join(root, 'temp')
    const installDir = join(tmpRoot, 'DeepSeek Harness')
    const home = join(root, 'home')
    mkdirSync(installDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    return {
      env: { home, workdir: root, tmpdir: tmpRoot, installDir, dshHome: join(home, '.dsh') },
      tmpRoot,
      installDir,
    }
  }

  it('classifies an install dir under TEMP as protected, not free', () => {
    const { env, installDir } = tempEnv()
    const result = classifyPath(join(installDir, 'resources', 'app.asar'), env)
    expect(result, '安装目录即使在 TEMP 下也必须是 protected').toBe('protected')
  })

  it('classifies a node_modules under TEMP as protected, not free', () => {
    const { env, tmpRoot } = tempEnv()
    const result = classifyPath(join(tmpRoot, 'someproj', 'node_modules', 'pkg', 'index.js'), env)
    expect(result, 'TEMP 下的 node_modules 也必须是 protected').toBe('protected')
  })

  it('still treats an ordinary file in TEMP as free', () => {
    // 防过度收紧：普通临时文件仍应免确认，否则每删一个都弹卡。
    const { env, tmpRoot } = tempEnv()
    const result = classifyPath(join(tmpRoot, 'scratch-abc', 'build.log'), env)
    expect(result, '普通临时文件仍应是 free').toBe('free')
  })
})

describe('P2-06: every entry honours crossVolumeCopy', () => {
  /**
   * 建工具集，记录删除上下文。
   *
   * @param state 安全区。
   * @param work 工作目录。
   * @param crossVolumeCopy 配置值。
   * @returns 工具。
   */
  function makeTool(
    state: string,
    work: string,
    crossVolumeCopy: boolean,
  ): ReturnType<typeof createTools>[number] {
    const deps: ToolDeps = {
      stateDir: state,
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => 'allowed-once',
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      crossVolumeCopy,
    }
    const tool = createTools(deps).find((t) => t.name === 'safe_delete')
    if (tool === undefined) throw new Error('no safe_delete')
    return tool
  }

  it('passes crossVolumeCopy through the model tool', async () => {
    const root = scratchDir('dsd-p206-a-')
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    const p = join(work, 'a.txt')
    writeFileSync(p, 'x')

    const tool = makeTool(join(root, 'state'), work, true)
    // 同卷删除不会用到 crossVolumeCopy，但工具必须接受这个配置而不报错。
    const r = await tool.execute({ path: p })
    expect(r.ok, r.error ?? '应成功').toBe(true)
  })

  it('documents that the slash entry now forwards the same flag', async () => {
    /*
     * 斜杠入口的适配器在 `index.ts` 里，没有独立导出，无法直接单测。
     * 这里用源码断言钉住那个字段确实被传下去 —— 它的缺失正是 P2-06。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/index.ts', 'utf8')
    const start = src.indexOf('const commandAdapter')
    expect(start, '应能找到 commandAdapter').toBeGreaterThan(0)
    const seg = src.slice(start, start + 1400)
    expect(seg, '斜杠入口必须传 crossVolumeCopy').toContain('crossVolumeCopy')
  })
})

describe('P2-07: the CLI prints the configured retention window', () => {
  it('does not hardcode a 7-day window', async () => {
    /*
     * CLI 的 `delete` 分支原来写死 `describeMoved(result, 7)`，而默认保留期是
     * 1 天 —— 会向用户承诺"7 天内可恢复"，实际第二天就进回收站。
     *
     * 这条断言直接读源码：不接受字面量 7 作为保留期参数。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('bin/dsh-safe-delete.mjs', 'utf8')
    expect(src, 'CLI 不该把保留期写死成 7').not.toMatch(/describe(?:Moved|Preview)\(result,\s*7\s*\)/)
    expect(src, 'CLI 应使用配置里的 retentionDays').toMatch(/describe(?:Moved|Preview)\(result,\s*cfg\.retentionDays\)/)
  })
})
