# 删除目的地开关与回收站快速路径 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户可以一键切换「删除进安全区」或「删除直接进系统回收站」，并让回收站模式的删除耗时与文件数量无关。

**Architecture:** 统计只在安全区模式做（递归 `walk`）；回收站模式只读顶层一层。回收站模式不移动文件位置，而是在**一个 PowerShell 进程内**对真实路径逐条调用 `Microsoft.VisualBasic.FileIO.FileSystem.Delete*` 的 `SendToRecycleBin`，因此还原路径保持原样。目的地分支必须同时覆盖单路径（`deletePath`）与多路径（`deleteMany`）两条链路，审批钩子也要感知模式。

**Tech Stack:** TypeScript、Node 内置 `node:fs`、vitest、tsdown、系统自带 PowerShell（零新增运行时依赖）。

**Spec:** `docs/superpowers/specs/2026-11-04-delete-destination-design.md`

## Global Constraints

- 零运行时依赖：只能新增 `node:` 内置模块与系统自带 PowerShell 的调用。
- `deleteDestination` 取值为 `'safe-zone' | 'recycle-bin'`，默认 `'safe-zone'`；读取时未知值一律回落 `'safe-zone'`。
- 回收站模式下 `confirmFileCount` 与 `confirmBytes` 完全失效。
- 回收站模式不改变文件原位置（不聚合、不暂存、不改名）。
- 任何情况下不得静默永久删除：检测到永久删除风险必须走审批弹窗，用户拒绝则本次操作整体放弃。
- 索引格式不变：`bytes` / `fileCount` 仍为非负有限数（回收站模式目录写 0）。
- 配置项必须 `.volatile()`，改完立即生效、无需重启。
- 现有 955 条测试必须继续通过；被新行为改变的断言逐条更新并写明理由，不得删除断言。
- 提交信息用英文，正文说明「为什么」，不要只写「改了什么」。

## Review Focus

1. **单文件删除在回收站模式下不能显示「0 条目 0 B」** —— 用户删一个 3 GB 的镜像，期望看到真实大小。
2. **`fileCount: 0` + `truncated: true` 不能打印负数**（`-10 more`）—— 任何目录删除都会走到这里。
3. **多路径删除（`deleteMany`）必须遵守开关** —— 这是「一次删几千个」的主路径，漏了等于功能只做了一半。
4. **回收站条目必须记录真实原位置** —— 用户从回收站还原时期望回到删除的地方，不是内部暂存目录。
5. **回收站不可用/被策略禁用时必须停下来问人** —— 静默永久删除是本插件存在的反面。

---

## Task 1: `describeTarget` 支持按需统计

**Files:**
- Modify: `src/describe.ts`（整文件，现有 98 行）
- Modify: `src/types.ts`（`TargetDescription` 加 `statsOmitted`）
- Test: `tests/describe-stats.test.ts`（新建）

**Interfaces:**
- Produces:
  - `describeTarget(absPath: string, options?: { stats?: boolean }): TargetDescription`
  - `TargetDescription` 新增可选字段 `statsOmitted?: boolean`
  - 语义：`stats` 缺省为 `true`（保持现有行为）；`stats: false` 时目录只读顶层一层，`bytes: 0`、`fileCount: 0`、`statsOmitted: true`；**单文件在两种模式下都用 `statSync` 给出真实 `bytes` 与 `fileCount: 1`**。

- [ ] **Step 1: Write the failing test**

`tests/describe-stats.test.ts`：

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { describeTarget } from '../src/describe'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-describe-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('describeTarget stats option', () => {
  it('counts a directory recursively by default', () => {
    const dir = join(root, 'dir')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'aaaa')
    writeFileSync(join(dir, 'sub', 'b.txt'), 'bb')

    const d = describeTarget(dir)
    expect(d.isDirectory).toBe(true)
    expect(d.fileCount).toBe(2)
    expect(d.bytes).toBe(6)
    expect(d.statsOmitted).toBeUndefined()
  })

  it('skips recursion when stats is false and marks the omission', () => {
    const dir = join(root, 'dir')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'aaaa')
    writeFileSync(join(dir, 'sub', 'b.txt'), 'bb')

    const d = describeTarget(dir, { stats: false })
    expect(d.isDirectory).toBe(true)
    expect(d.fileCount).toBe(0)
    expect(d.bytes).toBe(0)
    expect(d.statsOmitted).toBe(true)
    // 顶层条目仍然要列出来，卡片靠它说明「里面有什么」。
    expect(d.topEntries).toContain('a.txt')
    expect(d.topEntries).toContain('sub')
  })

  it('reports a real size for a single file even when stats is false', () => {
    const file = join(root, 'big.bin')
    writeFileSync(file, 'x'.repeat(1024))

    const d = describeTarget(file, { stats: false })
    expect(d.isDirectory).toBe(false)
    expect(d.fileCount).toBe(1)
    expect(d.bytes).toBe(1024)
    expect(d.statsOmitted).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/describe-stats.test.ts`
Expected: FAIL —— `stats: false` 的用例拿到 `fileCount: 2`（仍在递归），`statsOmitted` 为 `undefined`。

- [ ] **Step 3: Implement the option**

在 `src/describe.ts`：给 `describeTarget` 加第二参数 `options: { stats?: boolean } = {}`；`const stats = options.stats !== false`。目录分支里仅当 `stats` 为真时调用 `walk()`，否则 `acc` 保持 `{bytes: 0, fileCount: 0}`，返回对象带 `statsOmitted: true`。单文件分支不动（本来就是一次 `statSync`）。

在 `src/types.ts` 的 `TargetDescription` 加 `statsOmitted?: boolean`，注释写明「目录统计被跳过（回收站模式），`bytes`/`fileCount` 因此为 0」。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/describe-stats.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/describe.ts src/types.ts tests/describe-stats.test.ts
git commit -m "feat: let describeTarget skip the recursive walk on demand

Recycle-bin mode does not need byte or entry totals, and the recursive
walk is the only reason a large directory delete blocks before the
approval card appears. Single files keep their real size because one
statSync is already free."
```

---

## Task 2: 去掉重复统计，并修掉负数文案

**Files:**
- Modify: `src/store.ts:563-580`（`stageInto` 签名与内部 `describeTarget` 调用）
- Modify: `src/store.ts` 中 `moveToSafeZone` / `moveManyToSafeZone` 的调用点
- Modify: `src/delete-core.ts:461,485`（`describePreview` / `describeMoved` 的 more 文案）
- Test: `tests/store-single-describe.test.ts`（新建）、`tests/describe-more-text.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `describeTarget(absPath, { stats })`
- Produces:
  - `stageInto` 新增可选参数 `description?: TargetDescription`；提供时**不得**再调用 `describeTarget`
  - `moveToSafeZone(stateDir, target, opts)` 的 `opts` 新增 `description?: TargetDescription`
  - `moveManyToSafeZone` 同样接受并按条目传入 `description`
  - `describePreview` / `describeMoved` 的「还有 N 个」文案仅在 `fileCount > 10` 时输出

- [ ] **Step 1: Write the failing tests**

`tests/store-single-describe.test.ts`：用 spy 计数 `describe` 模块被调用次数——

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const describeCalls: string[] = []
vi.mock('../src/describe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/describe')>()
  return {
    ...actual,
    describeTarget: (p: string, o?: { stats?: boolean }) => {
      describeCalls.push(p)
      return actual.describeTarget(p, o)
    },
  }
})

const { moveToSafeZone } = await import('../src/store')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-stage-'))
  describeCalls.length = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('safe zone move', () => {
  it('does not describe the target a second time when a description is supplied', async () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'hello')

    const stateDir = join(root, 'state')
    const { describeTarget } = await import('../src/describe')
    const description = describeTarget(file)

    await moveToSafeZone(stateDir, file, {
      retentionDays: 1,
      now: () => Date.now(),
      description,
    })

    // 调用方已经描述过一次；stageInto 不应再描述。
    expect(describeCalls.filter((p) => p === file).length).toBe(1)
  })
})
```

`tests/describe-more-text.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

import { describePreview } from '../src/delete-core'

describe('describePreview trailing entries text', () => {
  it('never prints a negative remainder when the count was not computed', () => {
    const text = describePreview(
      {
        ok: true,
        kind: 'preview',
        target: 'C:\\x\\dir',
        description: {
          exists: true,
          isDirectory: true,
          bytes: 0,
          fileCount: 0,
          topEntries: Array.from({ length: 20 }, (_, i) => `f${i}`),
          truncated: true,
          statsOmitted: true,
        },
        gate: { needsApproval: false, classification: 'free', reasons: [] },
      },
      1,
    )

    expect(text).not.toMatch(/-\d+ more/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/store-single-describe.test.ts tests/describe-more-text.test.ts`
Expected: FAIL —— 前者 `describeCalls` 计数为 2；后者文案含 `-10 more`。

- [ ] **Step 3: Thread the description through and guard the text**

`src/store.ts`：`stageInto` 增加 `description?: TargetDescription`；函数体里 `const description = provided ?? describeTarget(target)`（保持原行为作为兜底）。`moveToSafeZone` / `moveManyToSafeZone` 把 `opts.description` 透传下去。

`src/delete-core.ts:461,485`：把 `` `…and ${d.fileCount - 10} more` `` 改为仅当 `d.fileCount > d.topEntries.length` 且 `d.fileCount > 10` 时追加；否则当 `d.truncated` 为真时追加 `'…and more'`（不带数字）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/store-single-describe.test.ts tests/describe-more-text.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite for regressions**

Run: `pnpm vitest run`
Expected: 全部通过（若有用例断言旧文案，按新文案更新并写明理由）

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/delete-core.ts tests/store-single-describe.test.ts tests/describe-more-text.test.ts
git commit -m "perf: describe a delete target once instead of twice

deletePath already describes the target for the approval card, and
stageInto described it again for the index. Passing the description down
removes half the tree walks in safe-zone mode with no information lost.
Also guards the trailing-entry text, which printed a negative remainder
when the count was not computed."
```

---

## Task 3: 回收站批量执行器

**Files:**
- Modify: `src/recycle.ts`（新增 `recycleManyToSystemBin`）
- Test: `tests/recycle-many.test.ts`（新建）

**Interfaces:**
- Produces:
  - `export type RecycleManyOutcome = { ok: true; recycled: number } | { ok: false; reason: string; recycled: number; unsupported?: boolean }`
  - `export function recycleManyToSystemBin(absPaths: readonly string[]): RecycleManyOutcome`
  - 语义：一次 PowerShell 调用处理全部路径；成功计数为 0 且无失败才算 `ok: true`；空数组直接 `ok: true, recycled: 0`；平台非 win32 时返回 `unsupported: true`。
- 复用：现有 `recycleIsTripped()` 熔断判定与 `recordRecycleFailure()` 计数。

- [ ] **Step 1: Write the failing test**

`tests/recycle-many.test.ts`（注入假执行器，不真的调 PowerShell）：

```ts
import { describe, expect, it, vi } from 'vitest'

import { buildRecycleManyScript, parseRecycleManyOutput } from '../src/recycle'

describe('recycleManyToSystemBin helpers', () => {
  it('builds one script that handles every path with SendToRecycleBin', () => {
    const script = buildRecycleManyScript(['C:\\a\\x.txt', "C:\\b\\o'brien.txt"])
    expect(script).toContain('SendToRecycleBin')
    expect(script).toContain('OnlyErrorDialogs')
    expect(script).toContain('DeleteDirectory')
    expect(script).toContain('DeleteFile')
    // 单引号必须转义成两个，否则路径里的 ' 会截断字符串。
    expect(script).toContain("o''brien.txt")
    // 一个脚本处理全部路径，不是每条一次调用。
    expect(script.match(/foreach/g)?.length).toBe(1)
  })

  it('parses the OK/FAIL summary and per-path errors', () => {
    const out = ['ERR: C:\\b\\y.txt : denied', 'OK=2 FAIL=1'].join('\n')
    const parsed = parseRecycleManyOutput(out)
    expect(parsed.ok).toBe(2)
    expect(parsed.fail).toBe(1)
    expect(parsed.errors).toEqual(['C:\\b\\y.txt : denied'])
  })

  it('treats an empty path list as a no-op success', () => {
    const parsed = parseRecycleManyOutput('OK=0 FAIL=0')
    expect(parsed.ok).toBe(0)
    expect(parsed.fail).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/recycle-many.test.ts`
Expected: FAIL —— `buildRecycleManyScript` / `parseRecycleManyOutput` 未导出。

- [ ] **Step 3: Implement the batch executor**

在 `src/recycle.ts`：

- `export function buildRecycleManyScript(absPaths: readonly string[]): string` —— 生成 PowerShell 脚本：`Add-Type -AssemblyName Microsoft.VisualBasic`；`$targets = @('a','b')`（单引号转义）；`foreach ($t in $targets)` 内用 `Test-Path -LiteralPath $t -PathType Container` 分流到 `DeleteDirectory` / `DeleteFile`，两者都传 `"OnlyErrorDialogs", "SendToRecycleBin"`；失败输出 `ERR: <path> : <message>`；末尾输出 `OK=n FAIL=m`。
- `export function parseRecycleManyOutput(stdout: string): { ok: number; fail: number; errors: string[] }` —— 从末行读 `OK=`/`FAIL=`，收集 `ERR:` 行。
- `export function recycleManyToSystemBin(absPaths)` —— 空数组直接成功；`process.platform !== 'win32'` 返回 `unsupported`；`recycleIsTripped()` 时按现有熔断文案返回失败；`execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', script], { timeout: ..., windowsHide: true, encoding: 'utf8' })`；成功则 `recordRecycleFailure()` 不增、失败则调用它；返回 `recycled` 计数。

超时常量沿用现有 `COMMAND_TIMEOUT_MS` 风格，但批量调用按条目数放大：`Math.max(COMMAND_TIMEOUT_MS, 5_000 + 200 * absPaths.length)`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/recycle-many.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/recycle.ts tests/recycle-many.test.ts
git commit -m "feat: recycle many real paths in a single shell invocation

One process handles every path with SendToRecycleBin, which keeps each
item at its original location instead of aggregating them into a staging
directory. Measured at ~162ms per item, so 1000 files costs seconds
rather than spawning 1000 processes."
```

---

## Task 4: 永久删除风险检测

**Files:**
- Modify: `src/recycle.ts`（新增风险探测）
- Test: `tests/recycle-permanent-risk.test.ts`（新建）

**Interfaces:**
- Produces:
  - `export type PermanentDeleteRisk = { risky: boolean; reason?: string }`
  - `export function detectPermanentDeleteRisk(options?: { env?: Record<string, string | undefined>; readRegistry?: (key: string, name: string) => string | undefined }): PermanentDeleteRisk`
  - 语义：`NoRecycleFiles` 为 `1`/`true` 时 `risky: true`，`reason` 说明是系统策略；非 win32 返回 `risky: false`（Linux 走 gio 路径，不在本检测范围）。

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'

import { detectPermanentDeleteRisk } from '../src/recycle'

describe('detectPermanentDeleteRisk', () => {
  it('flags the policy when NoRecycleFiles is enabled', () => {
    const r = detectPermanentDeleteRisk({
      readRegistry: (key, name) =>
        name === 'NoRecycleFiles' ? '1' : undefined,
    })
    expect(r.risky).toBe(true)
    expect(r.reason).toMatch(/NoRecycleFiles/)
  })

  it('stays quiet when the policy is absent', () => {
    const r = detectPermanentDeleteRisk({ readRegistry: () => undefined })
    expect(r.risky).toBe(false)
  })

  it('stays quiet when the policy is explicitly disabled', () => {
    const r = detectPermanentDeleteRisk({
      readRegistry: (key, name) => (name === 'NoRecycleFiles' ? '0' : undefined),
    })
    expect(r.risky).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/recycle-permanent-risk.test.ts`
Expected: FAIL —— 未导出。

- [ ] **Step 3: Implement the detector**

在 `src/recycle.ts`：默认 `readRegistry` 用 `execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer', '/v', 'NoRecycleFiles'])` 解析 `REG_SZ`/`REG_DWORD` 值；`detectPermanentDeleteRisk` 判定 `1`/`true` 为风险，返回带 `NoRecycleFiles` 字样的 `reason`。非 win32 直接 `{ risky: false }`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/recycle-permanent-risk.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/recycle.ts tests/recycle-permanent-risk.test.ts
git commit -m "feat: detect the policy that turns recycle into permanent delete

Windows permanently deletes and still reports success when NoRecycleFiles
is set. A deletion plugin that promises reversibility must not walk into
that silently, so the condition is detected before any file is touched."
```

---

## Task 5: 配置项与目的地分支（单路径）

**Files:**
- Modify: `src/config.ts`（新增 `deleteDestination`）
- Modify: `src/delete-core.ts`（`DeleteContext` 加 `destination`、`recycler`；`DeleteResult` 加 `kind: 'recycled'`；`deletePath` 第 7 步分支）
- Modify: `src/index.ts`（把配置透传进 `DeleteContext`）
- Test: `tests/delete-destination.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 `recycleManyToSystemBin`、Task 4 `detectPermanentDeleteRisk`
- Produces:
  - `Config.deleteDestination: 'safe-zone' | 'recycle-bin'`（默认 `'safe-zone'`，`.volatile()`）
  - `DeleteContext` 新增 `destination: 'safe-zone' | 'recycle-bin'` 与可选 `recycler?: (paths: readonly string[]) => RecycleManyOutcome`
  - `DeleteResult` 新增 `{ ok: true; kind: 'recycled'; target: string; description: TargetDescription; gate: GateDecision }`
  - 语义：`destination === 'recycle-bin'` 时，先 `detectPermanentDeleteRisk()`，`risky` 为真则**走审批**（文案说明会永久删除），用户拒绝返回 `{ ok: false }`；否则调 `recycler([target])`，成功返回 `kind: 'recycled'`，失败**回落** `moveToSafeZone` 并返回 `kind: 'moved'`。

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deletePath } from '../src/delete-core'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-dest-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    stateDir: join(root, 'state'),
    env: {},
    retentionDays: 1,
    confirmFileCount: 0,
    confirmBytes: 0,
    crossVolumeCopy: false,
    destination: 'recycle-bin' as const,
    now: () => Date.now(),
    requestApproval: async () => 'allowed-once' as const,
    ...overrides,
  }
}

describe('deletePath with recycle-bin destination', () => {
  it('recycles without creating a safe zone entry', async () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'x')
    const calls: string[][] = []

    const result = await deletePath(
      { path: file },
      ctx({
        recycler: (paths: readonly string[]) => {
          calls.push([...paths])
          return { ok: true as const, recycled: paths.length }
        },
      }) as never,
    )

    expect(result.ok).toBe(true)
    expect(result.kind).toBe('recycled')
    // 真实路径直接交给回收站，不经过暂存目录。
    expect(calls).toEqual([[file]])
  })

  it('falls back to the safe zone when recycling fails', async () => {
    const file = join(root, 'b.txt')
    writeFileSync(file, 'x')

    const result = await deletePath(
      { path: file },
      ctx({
        recycler: () => ({ ok: false as const, reason: 'bin unavailable', recycled: 0 }),
      }) as never,
    )

    expect(result.ok).toBe(true)
    expect(result.kind).toBe('moved')
    expect(existsSync(file)).toBe(false)
  })

  it('abandons the delete when the user declines the permanent-delete warning', async () => {
    const file = join(root, 'c.txt')
    writeFileSync(file, 'x')
    let asked = ''
    let recycled = false

    const result = await deletePath(
      { path: file },
      ctx({
        permanentDeleteRisk: { risky: true, reason: 'NoRecycleFiles is enabled' },
        requestApproval: async (text: string) => {
          asked = text
          return 'denied' as const
        },
        recycler: () => {
          recycled = true
          return { ok: true as const, recycled: 1 }
        },
      }) as never,
    )

    expect(result.ok).toBe(false)
    expect(recycled).toBe(false)
    expect(existsSync(file)).toBe(true)
    expect(asked).toMatch(/permanently/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/delete-destination.test.ts`
Expected: FAIL —— `destination` 尚未被读取，结果恒为 `kind: 'moved'`。

- [ ] **Step 3: Implement config and the single-path branch**

`src/config.ts`：新增字段与注释（说明两种模式的取舍、回收站模式不统计、阈值失效）。

`src/delete-core.ts`：`DeleteResult` 加 `recycled` 变体；`DeleteContext` 加 `destination`、`recycler`、可选 `permanentDeleteRisk`；`deletePath` 第 7 步改为：

1. `destination === 'recycle-bin'` 且 `permanentDeleteRisk?.risky` 为真 → `ctx.requestApproval(永久删除警告文案)`，非 `'allowed-once'` 则 `return { ok: false, target, error: 'cancelled: ...' }`。
2. 调 `recycler ?? recycleManyToSystemBin` 处理 `[target]`；`ok` → 审计 + `return { ok: true, kind: 'recycled', ... }`。
3. 失败 → 审计记录回落原因，继续走 `moveToSafeZone`（`kind: 'moved'`）。

`src/index.ts`：把 `deleteDestination` 读进 `DeleteContext`（未知值回落 `'safe-zone'`），并在 `apply` 时算一次 `detectPermanentDeleteRisk()` 传入。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/delete-destination.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/delete-core.ts src/index.ts tests/delete-destination.test.ts
git commit -m "feat: add a delete destination switch with a recycle-bin fast path

Recycle-bin mode hands the real path to the shell instead of staging it,
so restoring from the bin puts files back where they came from. A
recycling failure falls back to the safe zone, and a detected
permanent-delete policy asks the user first."
```

---

## Task 6: 多路径删除遵守同一开关

**Files:**
- Modify: `src/tools.ts:360-382`（`deleteMany` 的 describe 与目的地处理）
- Modify: `src/tools.ts:500-540`（批量执行段落）
- Test: `tests/delete-many-destination.test.ts`（新建）

**Interfaces:**
- Consumes: Task 5 的 `DeleteContext.destination` / `recycler`
- Produces: `deleteMany` 在 `destination === 'recycle-bin'` 时，用 `{ stats: false }` 描述每个目标，并把**全部路径一次性**交给 `recycler`（一次进程，不是每路径一次）。

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTools } from '../src/tools'

/*
 * `deleteMany` 是 tools.ts 内部函数，未导出。测试通过 `createTools(deps)`
 * 拿到工具定义再调用其执行体 —— 与现有 tests 的用法一致。
 */
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-many-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('safe_delete with paths in recycle-bin mode', () => {
  it('hands every path to the recycler in one call', async () => {
    const calls: string[][] = []
    const files = ['a.txt', 'b.txt', 'c.txt'].map((n) => {
      const p = join(root, n)
      writeFileSync(p, 'x')
      return p
    })

    const tools = createTools({
      stateDir: join(root, 'state'),
      env: {},
      retentionDays: 1,
      confirmFileCount: 0,
      confirmBytes: 0,
      crossVolumeCopy: false,
      destination: 'recycle-bin',
      now: () => Date.now(),
      requestApproval: async () => 'allowed-once',
      recycler: (paths: readonly string[]) => {
        calls.push([...paths])
        return { ok: true as const, recycled: paths.length }
      },
    } as never)

    const tool = tools.find((t) => t.name === 'safe_delete')!
    await tool.execute({ paths: files } as never, {} as never)

    expect(calls.length).toBe(1)
    expect(calls[0]).toHaveLength(3)
  })
})
```

> 实现时按 `createTools` 实际的 `ToolDeps` 形状与工具执行体签名微调调用方式；断言不变。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/delete-many-destination.test.ts`
Expected: FAIL —— `calls` 为空（批量路径仍走 `moveManyToSafeZone`）。

- [ ] **Step 3: Implement the batch branch**

`src/tools.ts`：`deleteMany` 里按 `ctx.destination` 分流。回收站模式：用 `describeTarget(p, { stats: false })` 构造 plans，跳过 `confirmFileCount`/`confirmBytes` 判定（按 Global Constraints），合并成一次审批，然后 `recycler(plans.map(p => p.target))`；成功写审计并返回 `kind: 'recycled'` 汇总，失败回落 `moveManyToSafeZone`。安全区模式保持现有逻辑，只补上把 `description` 传给 `moveManyToSafeZone`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/delete-many-destination.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `pnpm vitest run`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts tests/delete-many-destination.test.ts
git commit -m "feat: apply the delete destination to multi-path deletes too

deleteMany went straight to moveManyToSafeZone, so the destination switch
would have been ignored on the very path used for deleting thousands of
files at once."
```

---

## Task 7: 审批钩子感知模式

**Files:**
- Modify: `src/index.ts:508-551`（钩子里的描述调用）
- Modify: `src/index.ts:575-581`（文案）
- Test: `tests/hook-destination-text.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `describeTarget(abs, { stats })`、Task 5 的 `destination`
- Produces: 钩子在 `destination === 'recycle-bin'` 时用 `{ stats: false }` 描述，且文案含「回收站」、**不含**「N 天内可恢复」。新增导出 `describeInterceptedDelete(input): string`（钩子里拼文案的那段抽出来，便于单测）。

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'

import { describeInterceptedDelete } from '../src/index'

describe('pre-execute hook description', () => {
  it('promises the recycle bin and not a retention window in recycle mode', () => {
    const text = describeInterceptedDelete({
      target: 'C:\\x\\dir',
      destination: 'recycle-bin',
      retentionDays: 7,
      description: {
        exists: true,
        isDirectory: true,
        bytes: 0,
        fileCount: 0,
        topEntries: ['a'],
        truncated: false,
        statsOmitted: true,
      },
    })

    expect(text).toMatch(/recycle bin/i)
    expect(text).not.toMatch(/7 days/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/hook-destination-text.test.ts`
Expected: FAIL —— 未导出 `describeInterceptedDelete`，或文案含「7 days」。

- [ ] **Step 3: Implement mode-aware description**

把钩子里拼文案的那段抽成 `export function describeInterceptedDelete(input): string`，按 `destination` 选择措辞与 `stats` 开关。安全区模式保持原文案不变（含「restorable for N days」）。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/hook-destination-text.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/hook-destination-text.test.ts
git commit -m "fix: make the approval hook aware of the delete destination

The hook described every target with a full walk and promised a
retention window even in recycle mode, so it both walked the tree and
said the wrong thing before the card appeared."
```

---

## Task 8: 设置页分段按钮

**Files:**
- Modify: `src/client/index.tsx`（新增 `kind: 'choice'` 渲染为两个按钮）
- Modify: `src/settings-guide.ts`（新增该字段的说明）
- Test: `tests/client-choice-field.test.tsx`（新建）

**Interfaces:**
- Produces: `FieldSpec.kind` 增加 `'choice'`，并新增 `options: Array<{ value: string; label: string }>`；渲染为并排按钮，点击直接写入 `deleteDestination`。

- [ ] **Step 1: Write the failing test**

断言渲染出两个按钮、点击第二个时发出的写操作是 `{ op: 'set', path: ['deleteDestination'], value: 'recycle-bin' }`（复用现有 `verify-client-render.mjs` 的假 React 方式或组件测试工具）。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/client-choice-field.test.tsx`
Expected: FAIL —— `choice` 未知，渲染为空。

- [ ] **Step 3: Implement the choice control**

`src/client/index.tsx`：在渲染分支里加 `case 'choice'`，用与「立即清理」按钮相同的 `<button>` 样式渲染 `options`，当前值高亮；`onClick` 走现有 `write([{ op: 'set', path: [key], value }])`。在 `FIELDS` 里加：

```ts
{
  key: 'deleteDestination',
  label: '删除去向',
  hint: '选「直接进回收站」会跳过文件统计以提升速度，代价是超大删除不再额外确认、卡片不显示总大小。',
  kind: 'choice',
  options: [
    { value: 'safe-zone', label: '放入安全区' },
    { value: 'recycle-bin', label: '直接进回收站' },
  ],
  fallback: 0,
}
```

- [ ] **Step 4: Run test and client verification**

Run: `pnpm vitest run tests/client-choice-field.test.tsx && node scripts/verify-client-render.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/client/index.tsx src/settings-guide.ts tests/client-choice-field.test.tsx
git commit -m "feat: add a two-button delete destination control to the settings page

A dropdown would hide the trade-off; two labelled buttons make the
current mode and the alternative visible at a glance."
```

---

## Task 9: 斜杠命令、文档与最终验证

**Files:**
- Modify: `src/commands.ts`（`/safe-delete destination <mode>`）
- Modify: `README.md`、`docs/CLEANUP-ARCHITECTURE.md`
- Test: `tests/command-destination.test.ts`（新建）

**Interfaces:**
- Produces: 斜杠命令 `destination safe-zone|recycle-bin`，非法值给出可用取值提示。

- [ ] **Step 1: Write the failing test** —— 断言命令解析出正确写入值、非法值报错。
- [ ] **Step 2: Run test to verify it fails** —— Run: `pnpm vitest run tests/command-destination.test.ts`
- [ ] **Step 3: Implement the command and update docs**（README 写清两种模式的利害、回收站模式不做配额预检、超容量条目会被系统永久删除）
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Full gate**

```bash
pnpm typecheck && pnpm vitest run && pnpm build
node scripts/privacy-audit.mjs && node scripts/check-docs.mjs
node scripts/find-dead-code.mjs . && npx tsx scripts/adversarial-probe.ts
npx tsx scripts/false-positive-probe.ts
```

Expected: 全部通过；对抗探针 0 意外、0 已知边界。

- [ ] **Step 6: Commit**

```bash
git add src/commands.ts README.md docs/CLEANUP-ARCHITECTURE.md tests/command-destination.test.ts
git commit -m "feat: expose the delete destination as a slash command and document it

Documents the trade-off honestly: recycle mode skips the entry and byte
counts, so the size confirmations no longer fire and items larger than
the bin quota are deleted permanently by Windows."
```

---

## Task 10: 版本与发布

- [ ] **Step 1:** `package.json` 版本改 `2.2.0`（新增配置项 + 行为变更，属于 minor 之上的功能版本）
- [ ] **Step 2:** 全量门禁重跑（Task 9 Step 5 的完整命令）
- [ ] **Step 3:** 提交、打 tag `v2.2.0`、推送、建 Release（说明两种模式与破坏性变更）
- [ ] **Step 4:** 核实远端 main 与本地一致、tag 与 Release 存在
