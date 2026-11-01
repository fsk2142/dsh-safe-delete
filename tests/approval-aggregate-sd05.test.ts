import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTools, type ToolDeps } from '../src/tools'
import { listSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * SD-05（2026-11-01 审查）：模式删除的审批与合计阈值。
 *
 * ## 两个独立缺陷
 *
 * **1. 合计阈值不判定**
 *
 * `decideGate` 只比较**单项**的 `fileCount` / `bytes` 与上限。三个各 1 字节
 * 的文件、阈值 2：每项都 1 < 2 → 全部放行。而用户设阈值的本意是
 * "超过这个量的删除先问我"，3 字节总量已经超过，只是分散在三个路径上。
 *
 * **2. 模式形态的 root 为 free 时没人问**
 *
 * pre-execute 曾对 `root+match` 形态在 root 为 free 时直接 `next()`，
 * 理由是"工具内部会按实际命中数判定"。但生产环境的工具侧
 * `requestApproval` **恒返回 `allowed-once`**（它假定管线已经问过），
 * 于是钩子一旦放行就**没有任何人问过** —— 命中 `node_modules/` 也静默删除。
 */
describe('SD-05: aggregate thresholds are enforced', () => {
  /**
   * 建工具集。
   *
   * @param stateDir 安全区。
   * @param work 工作目录。
   * @param opts 阈值与审批回调。
   * @returns 工具列表与审批计数访问器。
   */
  function makeTools(
    stateDir: string,
    work: string,
    opts: { confirmFileCount?: number; confirmBytes?: number; approve?: boolean } = {},
  ): { tools: ReturnType<typeof createTools>; approvals: () => number } {
    mkdirSync(work, { recursive: true })
    let approvals = 0
    const deps: ToolDeps = {
      stateDir,
      env: { home: join(work, 'home'), workdir: work, tmpdir: join(work, 'tmp') },
      requestApproval: async () => {
        approvals += 1
        return opts.approve === false ? 'rejected' : 'allowed-once'
      },
      retentionDays: 1,
      confirmFileCount: opts.confirmFileCount ?? 0,
      confirmBytes: opts.confirmBytes ?? 0,
    }
    return { tools: createTools(deps), approvals: () => approvals }
  }

  /**
   * 取工具。
   *
   * @param list 工具列表。
   * @param name 工具名。
   * @returns 工具。
   */
  function toolOf(list: ReturnType<typeof createTools>, name: string) {
    const found = list.find((t) => t.name === name)
    if (found === undefined) throw new Error(`missing ${name}`)
    return found
  }

  it('asks when the batch total exceeds the count limit, even if each item is under it', async () => {
    /*
     * 核心：3 个文件、阈值 2。单项都不超（1 < 2），合计 3 > 2 → 必须问。
     */
    const root = scratchDir('dsd-sd05-agg-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    const files: string[] = []
    mkdirSync(work, { recursive: true })
    for (let i = 0; i < 3; i += 1) {
      const p = join(work, `f${i}.txt`)
      writeFileSync(p, 'x')
      files.push(p)
    }

    const { tools, approvals } = makeTools(state, work, { confirmFileCount: 2 })
    const r = await toolOf(tools, 'safe_delete').execute({ paths: files })

    expect(approvals(), '合计超限必须请求审批').toBe(1)
    expect(r.ok, '批准后应成功').toBe(true)
  })

  it('does not ask when the batch total is within the limit', async () => {
    // 反向：2 个文件、阈值 2 → 不超，不问。
    const root = scratchDir('dsd-sd05-under-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    mkdirSync(work, { recursive: true })
    const files: string[] = []
    for (let i = 0; i < 2; i += 1) {
      const p = join(work, `g${i}.txt`)
      writeFileSync(p, 'x')
      files.push(p)
    }

    const { tools, approvals } = makeTools(state, work, { confirmFileCount: 2 })
    const r = await toolOf(tools, 'safe_delete').execute({ paths: files })

    expect(approvals(), '未超限不该问').toBe(0)
    expect(r.ok).toBe(true)
  })

  it('asks when the batch total bytes exceed the limit', async () => {
    // 字节阈值同样要看合计。
    const root = scratchDir('dsd-sd05-bytes-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    mkdirSync(work, { recursive: true })
    const files: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const p = join(work, `h${i}.bin`)
      writeFileSync(p, 'x'.repeat(10))
      files.push(p)
    }

    const { tools, approvals } = makeTools(state, work, { confirmBytes: 20 })
    const r = await toolOf(tools, 'safe_delete').execute({ paths: files })

    expect(approvals(), '合计 30 字节 > 20，必须问').toBe(1)
    expect(r.ok).toBe(true)
  })

  it('moves nothing when the aggregate approval is rejected', async () => {
    // 拒绝后必须零移动。
    const root = scratchDir('dsd-sd05-reject-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    mkdirSync(work, { recursive: true })
    const files: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const p = join(work, `r${i}.txt`)
      writeFileSync(p, 'x')
      files.push(p)
    }

    const { tools } = makeTools(state, work, { confirmFileCount: 2, approve: false })
    const r = await toolOf(tools, 'safe_delete').execute({ paths: files })

    expect(r.ok, '拒绝后应失败').toBe(false)
    expect(await listSafeZone(state), '安全区应为空').toHaveLength(0)
    // 原文件都还在。
    for (const f of files) {
      expect(readFileSync(f, 'utf8')).toBe('x')
    }
  })

  it('asks for a protected item hit through a pattern root', async () => {
    /*
     * 第二半：模式形态命中 protected 子项时，工具内部必须请求审批。
     *
     * 注意这验证的是**工具层**的行为。钩子层（pre-execute）对 free root
     * 也已经改为 ask —— 那条由 `index.ts` 的结构测试覆盖，
     * 因为完整 Cordis 接线在单测里无法构造。
     */
    const root = scratchDir('dsd-sd05-pattern-')
    const state = join(root, 'state')
    const work = join(root, 'work')

    // 工作区里放 node_modules —— 命中它应算 protected。
    const nm = join(work, 'node_modules', 'pkg')
    mkdirSync(nm, { recursive: true })
    writeFileSync(join(nm, 'index.js'), 'x')

    const { tools, approvals } = makeTools(state, work)
    /*
     * 用递归模式匹配嵌套文件。
     *
     * 注意 match 的语义：它匹配的是 **root 下直接子项的名字**还是递归路径，
     * 取决于实现。这里用 `**` 前缀确保能看到 node_modules 里的文件。
     */
    const r = await toolOf(tools, 'safe_delete').execute({ root: work, match: '**/*.js' })

    expect(approvals(), '命中 protected 子项必须请求审批').toBeGreaterThanOrEqual(1)
    expect(r.ok).toBe(true)
  })

  it('does not pass a free root through without asking (structural, hook-level)', async () => {
    /*
     * 钩子层的结构断言：`classification === 'free'` 不能再直接 `next()`。
     *
     * 为什么用结构断言：pre-execute 需要完整 Cordis 上下文（session、
     * 瀑布分发），单测里构造不出来。而"free 就放行"这个动作本身就是缺陷 ——
     * 直接检查代码形状。
     */
    const src = readFileSync('src/index.ts', 'utf8')

    expect(src, '不许对 free root 直接放行').not.toMatch(
      /classification === 'free'\)\s*return next\(\)/,
    )

    /*
     * 但 `never` 策略的放行必须保留 —— 那是用户明确选择不问。
     */
    expect(src, 'never 策略应保留放行').toMatch(
      /approvalPolicy\(session\) === 'never'\)\s*return next\(\)/,
    )

    // 模式分支必须仍会走到 ask。
    const patternAt = src.indexOf("const isPatternForm =")
    expect(patternAt).toBeGreaterThan(0)
    const tail = src.slice(patternAt, patternAt + 2000)
    expect(tail, '模式分支必须返回 ask').toMatch(/kind: 'ask'/)
  })
})
