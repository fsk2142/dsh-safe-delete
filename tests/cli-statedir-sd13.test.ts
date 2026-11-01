import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { scratchDir } from './support/tmpdir'

/**
 * SD-13（2026-11-01 审查）：CLI 必须用与插件相同的安全区目录。
 *
 * ## 缺陷
 *
 * CLI 写死 `path.join(dshHome(), '.dsh-safe-delete')`，完全不读配置里的
 * `stateDir`。于是用户在插件里改了安全区位置后：
 *
 * ```
 * CLI list/undo  → 看默认安全区（空的）→ "没有可恢复的条目"
 * CLI delete     → 往默认安全区写 → 与插件用的那个完全不是一处
 * ```
 *
 * DSH 起不来时，CLI 是唯一能救数据的东西 —— 指错地方等于救援通道失效。
 *
 * ## 修复后的优先级
 *
 * 1. `--state-dir <路径>` 显式覆盖（救援时最可靠，不依赖配置）
 * 2. 配置里的 `stateDir`
 * 3. `<DSH_HOME>/.dsh-safe-delete`
 */
describe('SD-13: the CLI uses the configured safe zone', () => {
  const CLI = join('bin', 'dsh-safe-delete.mjs')

  /**
   * 在假 DSH 环境里跑一次 CLI。
   *
   * @param home 假 DSH_HOME。
   * @param profile profile 名（空串表示不设）。
   * @param args 参数。
   * @returns 输出文本。
   */
  function run(home: string, profile: string, args: string[]): string {
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    env['DSH_HOME'] = home
    if (profile === '') delete env['DSH_PROFILE']
    else env['DSH_PROFILE'] = profile

    try {
      return execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env,
        timeout: 30_000,
      })
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string }
      return `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
  }

  /**
   * 造一个带 stateDir 配置的假 DSH home。
   *
   * @param layout `list`（`- id:` 形态）或 `key`（映射键形态）。
   * @returns home、自定义安全区路径与 profile 名。
   */
  function makeHome(layout: 'list' | 'key'): { home: string; custom: string; profile: string } {
    const root = scratchDir('dsd-sd13-')
    const home = join(root, 'dsh-home')
    const profile = 'test-profile'
    const custom = join(root, 'custom-zone', 'safe-zone')

    mkdirSync(join(home, 'profiles', profile), { recursive: true })
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(custom, 'index.json'), '[]')

    const normalized = custom.replace(/\\/g, '/')
    const yaml =
      layout === 'list'
        ? [
            'plugins:',
            '  - id: dsh-safe-delete',
            '    config:',
            `      stateDir: '${normalized}'`,
            '      retentionDays: 1',
          ].join('\n')
        : [
            'plugins:',
            '  dsh-safe-delete:',
            '    config:',
            `      stateDir: '${normalized}'`,
            '      retentionDays: 1',
          ].join('\n')

    writeFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), yaml)
    return { home, custom, profile }
  }

  /**
   * 从 status 输出里取 state dir 那一行。
   *
   * @param out CLI 输出。
   * @returns 该行文本。
   */
  function stateDirLine(out: string): string {
    return out.split('\n').find((l) => l.includes('state dir')) ?? ''
  }

  it('reads stateDir from a `- id:` style patch', () => {
    const { home, custom, profile } = makeHome('list')
    const out = run(home, profile, ['status'])
    expect(stateDirLine(out), '应指向配置的目录').toContain('custom-zone')
    void custom
  })

  it('reads stateDir from a mapping-key style patch', () => {
    /*
     * 第一版只认 `- id:` 形态。用映射键写法的用户读不到 `stateDir`，
     * 于是回到默认安全区 —— 正是 SD-13 要修的那种"指错地方"。
     */
    const { home, profile } = makeHome('key')
    const out = run(home, profile, ['status'])
    expect(stateDirLine(out), '映射键写法也要读到').toContain('custom-zone')
  })

  it('lets --state-dir override the configured value', () => {
    /*
     * 显式覆盖是救援时最可靠的手段 —— 它不该依赖配置能否解析。
     */
    const { home, profile } = makeHome('list')
    const override = join(scratchDir('dsd-sd13-ov-'), 'override-zone')
    mkdirSync(override, { recursive: true })
    writeFileSync(join(override, 'index.json'), '[]')

    const out = run(home, profile, ['status', '--state-dir', override])
    expect(stateDirLine(out), '应指向 override').toContain('override-zone')
    expect(stateDirLine(out), '不该指向配置值').not.toContain('custom-zone')
  })

  it('accepts --state-dir=<path> form too', () => {
    const { home, profile } = makeHome('list')
    const override = join(scratchDir('dsd-sd13-eq-'), 'eq-zone')
    mkdirSync(override, { recursive: true })
    writeFileSync(join(override, 'index.json'), '[]')

    const out = run(home, profile, ['status', `--state-dir=${override}`])
    expect(stateDirLine(out)).toContain('eq-zone')
  })

  it('falls back to the default when no profile is configured', () => {
    // 无 profile → 用默认位置，并明确标注（不是静默猜测）。
    const { home } = makeHome('list')
    const out = run(home, '', ['status'])
    expect(stateDirLine(out), '应退回默认').toContain('.dsh-safe-delete')
  })

  it('says which directory it is using', () => {
    /*
     * 无论走哪条路径，输出都必须**明确打印**用的是哪个目录。
     *
     * 否则用户无从判断 CLI 是否看到了正确的安全区 —— 而那正是本次缺陷
     * 让人踩坑的地方。
     */
    const { home, profile } = makeHome('key')
    const out = run(home, profile, ['status'])
    expect(stateDirLine(out), '必须打印 state dir').toMatch(/state dir:/)
  })
})
