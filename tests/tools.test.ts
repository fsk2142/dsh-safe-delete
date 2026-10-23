import { describe, expect, it } from 'vitest'

import { createTools, type ToolDeps } from '../src/tools'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { scratchDir } from './support/tmpdir'

function scratch() {
  const root = scratchDir('dsd-tools-')
  return { work: join(root, 'work'), state: join(root, 'state') }
}

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  const { work, state } = scratch()
  mkdirSync(work, { recursive: true })
  // 测试骨架本身建在系统临时目录里，但这里的 `env` 是**逻辑上的**主目录与临时目录，
  // 与真实磁盘位置无关 —— 分类器只看这两份路径事实。让 home 与 tmpdir 互相分离，
  // 才能分别测到 confirm 与 free 两条分支。
  return {
    stateDir: state,
    env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
    requestApproval: async () => 'allowed-once',
    retentionDays: 7,
    ...over,
  }
}

function toolOf(list: ReturnType<typeof createTools>, name: string) {
  const found = list.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

describe('safe_delete', () => {
  it('previews without moving anything', async () => {
    const d = deps()
    const file = join(d.env.workdir, 'a.txt')
    writeFileSync(file, 'hello')
    const result = await toolOf(createTools(d), 'safe_delete').execute({ path: file, preview: true })
    expect(result.ok).toBe(true)
    expect(result.text).toMatch(/PREVIEW/i)
    expect(existsSync(file)).toBe(true)
  })

  it('moves a free-path file without asking for approval', async () => {
    let asked = false
    const d = deps({
      requestApproval: async () => {
        asked = true
        return 'allowed-once'
      },
    })
    const file = join(d.env.workdir, 'a.txt')
    writeFileSync(file, 'hello')
    const result = await toolOf(createTools(d), 'safe_delete').execute({ path: file })
    expect(result.ok).toBe(true)
    expect(asked).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it('asks for approval on a confirm path and deletes only when allowed', async () => {
    const d = deps()
    const home = d.env.home
    mkdirSync(home, { recursive: true })
    const file = join(home, 'old.txt')
    writeFileSync(file, 'x')
    const tools = createTools({ ...d, requestApproval: async () => 'rejected' })
    const denied = await toolOf(tools, 'safe_delete').execute({ path: file })
    expect(denied.ok).toBe(false)
    expect(existsSync(file)).toBe(true)
  })

  it('distinguishes a human rejection from a missing approval channel', async () => {
    const d = deps()
    const home = d.env.home
    mkdirSync(home, { recursive: true })
    const file = join(home, 'old.txt')
    writeFileSync(file, 'x')
    const rejected = await toolOf(createTools({ ...d, requestApproval: async () => 'rejected' }), 'safe_delete').execute({
      path: file,
    })
    const unavailable = await toolOf(
      createTools({ ...d, requestApproval: async () => 'unavailable' }),
      'safe_delete',
    ).execute({ path: file })
    expect(rejected.error).toMatch(/rejected/i)
    expect(unavailable.error).toMatch(/no approval channel|unavailable/i)
    expect(rejected.error).not.toBe(unavailable.error)
  })

  it('ignores force:true and still consults the approval dependency', async () => {
    // 新架构里审批由工具管线的 `ask` 决策统一发起（见 tests/index.test.ts 的
    // "asks for approval when safe_delete targets a dangerous path"）。工具层在这里
    // 只负责：即便调用方塞了 force:true，也必须去问 approval 依赖，而不能自己放行。
    let asked = false
    const d = deps({
      requestApproval: async () => {
        asked = true
        return 'rejected'
      },
    })
    const home = d.env.home
    mkdirSync(home, { recursive: true })
    const file = join(home, 'old.txt')
    writeFileSync(file, 'x')
    const result = await toolOf(createTools(d), 'safe_delete').execute({ path: file, force: true })
    expect(result.ok).toBe(false)
    expect(asked).toBe(true)
    expect(existsSync(file)).toBe(true)
  })

  it('refuses the safe zone itself and the drive root', async () => {
    const d = deps()
    const tools = createTools(d)
    expect((await toolOf(tools, 'safe_delete').execute({ path: d.stateDir })).ok).toBe(false)
    expect((await toolOf(tools, 'safe_delete').execute({ path: 'C:\\' })).ok).toBe(false)
  })

  it('refuses a path that does not exist', async () => {
    const d = deps()
    const result = await toolOf(createTools(d), 'safe_delete').execute({ path: join(d.env.workdir, 'nope') })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })
})

describe('safe_zone_restore', () => {
  it('restores a previously deleted file', async () => {
    const d = deps()
    const file = join(d.env.workdir, 'a.txt')
    writeFileSync(file, 'hello')
    const tools = createTools(d)
    const del = await toolOf(tools, 'safe_delete').execute({ path: file })
    const id = /id:\s*(\S+)/.exec(del.text)?.[1]
    expect(id).toBeTruthy()
    const restored = await toolOf(tools, 'safe_zone_restore').execute({ id })
    expect(restored.ok).toBe(true)
    expect(existsSync(file)).toBe(true)
  })
})

describe('safe_zone_list', () => {
  it('reports an empty safe zone', async () => {
    const result = await toolOf(createTools(deps()), 'safe_zone_list').execute({})
    expect(result.text).toMatch(/empty/i)
  })
})

describe('safe_zone_status', () => {
  it('reports the retention window and says there is no capacity cap', async () => {
    const result = await toolOf(createTools(deps()), 'safe_zone_status').execute({})
    // 保留期来自 deps（测试里是 7 天）；容量上限已从产品移除。
    expect(result.text).toMatch(/retention: 7d/)
    expect(result.text).toContain('no capacity cap')
    // 必须说清"清理只在工具调用时发生"，否则保留期会被误解成准点。
    expect(result.text).toContain('only when a safe_zone_* tool is called')
  })
})

describe('safe_zone_check', () => {
  it('is read-only and reports PASS on a valid composition', async () => {
    const d = deps()
    const profile = join(d.env.home, '.dsh', 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p', private: true }))
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: x\n')
    const result = await toolOf(createTools(d), 'safe_zone_check').execute({})
    expect(result.text).toMatch(/PASS/i)
  })

  it('reports FAIL for a malformed package.json', async () => {
    const d = deps()
    const profile = join(d.env.home, '.dsh', 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{ not json')
    const result = await toolOf(createTools(d), 'safe_zone_check').execute({})
    expect(result.text).toMatch(/FAIL/i)
  })
})
