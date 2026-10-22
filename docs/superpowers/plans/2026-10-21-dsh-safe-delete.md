# dsh-safe-delete 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DSH 里的删除变成可逆操作——裸 shell 删除被拦下并改走安全删除，危险路径的删除在界面内点一下授权，删掉的内容进安全区、7 天内可原样取回。

**Architecture:** 一个零外部依赖的 TypeScript 插件。核心是纯函数模块（命令解析、路径分类、安全区存储、清理策略），插件入口只做接线：`tools/pre-execute` 瀑布拦截 shell 删除并返回 `ask`，`safe_delete` 工具负责唯一的真实删除路径，`ctx.approval` 负责把 ask 送到 DSH 自带审批卡片。

**Tech Stack:** TypeScript 6 + tsdown（构建到 `lib/`）+ vitest（测试）。运行时零外部 import，只用 Node 内置。

**Spec:** `docs/superpowers/specs/2026-10-21-dsh-safe-delete-design.md`

## Global Constraints

- **零外部运行时 import**：只能 import `node:*` 内置模块和本包内的相对路径。bundles 以 `link:` 裸装时没有自带 `node_modules`，import `@deepseek-ai/*` 会在 DSH 启动时解析失败。
- **手写 JSON Schema 子集**，不使用 `defineTool`（同上原因）。
- **fail-soft**：`apply()` 内任何注册失败只记日志，绝不让插件成为 DSH 启动失败的原因。
- **模型不能自批**：`force:true` 之类模型可自设的标志不作为授权依据；授权只来自 `ctx.approval.request()` 返回 `allowed-once`。
- **清理是唯一销毁路径**：除清理流程外，任何代码路径都不得对用户数据调用 `unlink` / `rm` / 递归删除。
- 保留期 `retentionDays = 7`，容量上限 `maxBytes = 20 GB`（`20 * 1024 ** 3`），`autoPrune = true`，`crossVolumeCopy = false`。
- 弹卡范围：只有 `confirm` / `protected` 分类弹卡；`free` 路径直接进安全区不打扰。
- 工具名常量：`bash`、`pwsh`、`run_code`、`terminal_send`。
- 安全区状态目录：`<DSH_HOME>/.dsh-safe-delete/`，其自身属于 `protected`，拒绝被安全删除。

## Review Focus

以下五类输入是设计文档没有明说、但最可能让使用者踩坑的地方，各自在所属任务的测试里钉死：

1. **未展开的变量被当成真实路径**——`$env:TEMP`、`$tmp`、`$_.FullName` 这类 shell 变量原文，绝不能像 dsh-safety 那样拼到会话目录下当作路径分类（用户日志中有 25 次这种误拦）。预期行为：判定为"无法解析"，走 `ask`，而不是判成 confirm/protected 直接拒绝。
2. **路径被词法上混淆**——`C:\work\..\users\alice` 这类写法必须规范化后再分类，否则保护规则形同虚设。预期行为：先 `path.resolve` 再判断。
3. **跨卷删除**——安全区与目标不在同一盘时 `rename` 会失败。预期行为：`crossVolumeCopy:false` 下明确拒绝并说明，绝不静默降级为永久删除。
4. **安全区被删**——`safe_delete` 指向 `<DSH_HOME>/.dsh-safe-delete` 或盘符根时必须拒绝，且不消耗审批。
5. **重复删除同一路径**——同一路径在安全区里已有条目时应生成新条目而非覆盖，取回时按 id 精确还原。

---

## 文件结构

```
dsh-safe-delete/
  package.json            # dsh.bundle.patch 指向 cordis.patch.yml
  cordis.patch.yml        # bundle 层，插入一行 dsh-safe-delete
  tsconfig.json           # ES2023 / strict / noEmit
  tsdown.config.ts        # 入口 src/index.ts → lib/index.js（ESM, node22）
  vitest.config.ts        # tests/**/*.test.ts，node 环境
  src/
    index.ts              # 插件入口：apply / inject / 工具注册 / 瀑布接线
    types.ts              # 共享类型：Verdict / Classification / TrashEntry / Config
    command.ts            # 纯函数：shell 命令文本 → 删除意图（含变量识别）
    classify.ts           # 纯函数：路径 → free / confirm / protected
    store.ts              # 安全区：移入 / 列出 / 取回 / 落盘索引
    prune.ts              # 纯函数 + 执行：按时间与容量选择待销毁条目
    describe.ts           # 纯函数：目标描述（大小/条目数/顶层预览）
    tools.ts              # 工具定义：safe_delete / safety_trash / safety_undo / safety_status / safety_check
  bin/
    dsh-safe-delete.mjs   # 独立 CLI 兜底（undo / list / prune / check）
  tests/
    command.test.ts
    classify.test.ts
    store.test.ts
    prune.test.ts
    describe.test.ts
    tools.test.ts
    index.test.ts         # 装配测试：假 ctx 上跑 apply()
    support/
      fake-ctx.ts         # 最小 cordis 假上下文（effect / tools / waterfall / approval）
      tmpdir.ts           # 临时目录夹具
```

**职责边界：** `command.ts` / `classify.ts` / `prune.ts` / `describe.ts` 是纯函数，不碰文件系统，最容易测；`store.ts` 独占所有真实文件操作；`index.ts` 只接线，不含业务判断。

---

### Task 1: 工程骨架与构建

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsdown.config.ts`, `vitest.config.ts`, `.gitignore`, `cordis.patch.yml`
- Create: `src/index.ts`（最小可加载的骨架）
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `export const name = 'dsh-safe-delete'`、`export const inject = ['tools', 'systemPrompt']`、`export function apply(ctx, config)`

- [ ] **Step 1: 写骨架装配测试**

```ts
// tests/index.test.ts
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index'

describe('plugin skeleton', () => {
  it('exports the plugin identity', () => {
    expect(plugin.name).toBe('dsh-safe-delete')
  })

  it('declares the services it injects', () => {
    expect(plugin.inject).toContain('tools')
  })

  it('apply() on an empty context does not throw', () => {
    expect(() => plugin.apply({ get: () => undefined } as never, {})).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/index.test.ts`
Expected: FAIL，报 `Failed to resolve import "../src/index"`

- [ ] **Step 3: 写最小实现**

`src/index.ts`：

```ts
export const name = 'dsh-safe-delete'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx: { get(id: string): unknown }, config: Record<string, unknown> = {}): void {
  try {
    applyInner(ctx, config)
  } catch (error) {
    try {
      const logger = (ctx.get('logger') ?? undefined) as { warn?: (m: string, e: unknown) => void } | undefined
      logger?.warn?.('dsh-safe-delete: apply failed, continuing boot', error)
    } catch {
      /* 记日志本身也不能抛 */
    }
  }
}

function applyInner(_ctx: unknown, _config: Record<string, unknown>): void {
  // 后续任务填充
}
```

`package.json` 关键字段（照 `dsh-llm-account` 的写法，但名字与入口不同）：

```json
{
  "name": "dsh-safe-delete",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Reversible deletion for DeepSeek Harness: shell deletes are intercepted, dangerous paths need in-UI approval, and deletions land in a safe zone you can restore.",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": { ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" }, "./package.json": "./package.json" },
  "engines": { "node": ">=22.19.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": { "build": "tsdown", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "devDependencies": {
    "@types/node": "^26.6.5",
    "tsdown": "^0.23.1",
    "typescript": "^6.0.3",
    "vitest": "^5.0.4"
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-safe-delete
      name: 'dsh-safe-delete'
```

`tsdown.config.ts` 用 `entry: { index: 'src/index.ts' }`、`format: 'esm'`、`platform: 'node'`、`target: 'node22'`、`dts: true`、`clean: true`、`fixedExtension: false`。`tsconfig.json` 照 `dsh-llm-account` 的 `tsconfig.json` 抄，`include` 改成本仓库路径。`vitest.config.ts` 用 `environment: 'node'`、`include: ['tests/**/*.test.ts']`。

`.gitignore`：`node_modules/`、`*.tsbuildinfo`。**不忽略 `lib/`**（照 `dsh-llm-account` 的教训：`main` 与 patch 都指向 `lib/`，不提交产物则克隆下来不可用）。

- [ ] **Step 4: 安装依赖并验证**

Run: `pnpm install`，然后 `pnpm vitest run tests/index.test.ts`
Expected: PASS，3 个测试通过

- [ ] **Step 5: 验证构建产物**

Run: `pnpm typecheck && pnpm build`
Expected: 两条命令均退出 0；`lib/index.js` 与 `lib/index.d.ts` 存在

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold dsh-safe-delete plugin with build and test harness"
```

---

### Task 2: 命令解析（识别删除意图与不可解析目标）

**Files:**
- Create: `src/command.ts`, `src/types.ts`
- Test: `tests/command.test.ts`

**Interfaces:**
- Produces:
  - `type DeleteIntent = { kind: 'delete'; recursive: boolean; target: string | null }`
  - `type CommandVerdict = { destructive: false } | ({ destructive: true } & DeleteIntent)`
  - `function parseCommand(command: string): CommandVerdict`
  - `function isUnresolvableTarget(target: string): boolean`

`target` 为 `null` 表示"命令里有删除动作，但目标无法静态解析"（变量、管道、动态拼接）。这类情况**不是**误拦，而是交给 `ask` 让用户自己看原文。

- [ ] **Step 1: 写失败测试**

```ts
// tests/command.test.ts
import { describe, expect, it } from 'vitest'
import { isUnresolvableTarget, parseCommand } from '../src/command'

describe('parseCommand', () => {
  it('ignores commands with no delete verb', () => {
    expect(parseCommand('Get-ChildItem C:\\Work')).toEqual({ destructive: false })
    expect(parseCommand('git status')).toEqual({ destructive: false })
    expect(parseCommand('npm run build')).toEqual({ destructive: false })
  })

  it('does not treat a non-delete verb as deletion when it merely contains "rm"', () => {
    expect(parseCommand('Get-Item C:\\Work\\form.txt')).toEqual({ destructive: false })
    expect(parseCommand('echo "removable disk"')).toEqual({ destructive: false })
  })

  it('detects PowerShell recursive removal and its literal target', () => {
    expect(parseCommand('Remove-Item -Recurse -Force C:\\Work\\proj\\build')).toEqual({
      destructive: true, kind: 'delete', recursive: true, target: 'C:\\Work\\proj\\build',
    })
  })

  it('detects rd /s and del /s', () => {
    expect(parseCommand('rd /s /q C:\\Work\\proj\\build')).toEqual({
      destructive: true, kind: 'delete', recursive: true, target: 'C:\\Work\\proj\\build',
    })
    expect(parseCommand('del /s C:\\Work\\proj\\build')).toEqual({
      destructive: true, kind: 'delete', recursive: true, target: 'C:\\Work\\proj\\build',
    })
  })

  it('detects POSIX rm -rf', () => {
    expect(parseCommand('rm -rf ./build')).toEqual({
      destructive: true, kind: 'delete', recursive: true, target: './build',
    })
  })

  it('detects node/python delete APIs in run_code bodies', () => {
    expect(parseCommand("fs.rmSync('C:\\\\Work\\\\a', { recursive: true })")).toEqual({
      destructive: true, kind: 'delete', recursive: true, target: 'C:\\Work\\a',
    })
    expect(parseCommand("shutil.rmtree('/tmp/x')")).toEqual({
      destructive: true, kind: 'delete', recursive: true, target: '/tmp/x',
    })
  })

  it('reports an unresolvable target for shell variables', () => {
    for (const command of [
      'Remove-Item -Recurse $tmp',
      'Remove-Item -Recurse $_.FullName',
      'Remove-Item -Recurse $env:TEMP\\staging',
      'Remove-Item -Recurse %TEMP%\\staging',
      'Remove-Item -Recurse ${HOME}/cache',
    ]) {
      const verdict = parseCommand(command)
      expect(verdict.destructive).toBe(true)
      expect(verdict.destructive && verdict.target).toBeNull()
    }
  })

  it('reports an unresolvable target for deletion driven by a pipeline or command substitution', () => {
    expect(parseCommand('Get-ChildItem C:\\Work | Remove-Item -Recurse').target).toBeNull()
    expect(parseCommand('rm -rf $(Get-Item C:\\Work)').target).toBeNull()
  })

  it('flags wildcard-only targets as unresolvable rather than a literal path', () => {
    expect(parseCommand('Remove-Item -Recurse *').target).toBeNull()
    expect(parseCommand('rm -rf ./*').target).toBeNull()
    expect(parseCommand('del *.*').target).toBeNull()
  })
})

describe('isUnresolvableTarget', () => {
  it('rejects shell variable syntax', () => {
    expect(isUnresolvableTarget('$tmp')).toBe(true)
    expect(isUnresolvableTarget('$env:TEMP')).toBe(true)
    expect(isUnresolvableTarget('%TEMP%')).toBe(true)
    expect(isUnresolvableTarget('${HOME}')).toBe(true)
  })

  it('rejects wildcard and substitution syntax', () => {
    expect(isUnresolvableTarget('*')).toBe(true)
    expect(isUnresolvableTarget('$(Get-Item x)')).toBe(true)
  })

  it('accepts ordinary literal paths', () => {
    expect(isUnresolvableTarget('C:\\Work\\proj\\build')).toBe(false)
    expect(isUnresolvableTarget('./build')).toBe(false)
    expect(isUnresolvableTarget('/tmp/x')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/command.test.ts`
Expected: FAIL，`Failed to resolve import "../src/command"`

- [ ] **Step 3: 实现 `src/command.ts`**

实现要点（不贴完整代码，这三条是实现者需要知道的选择）：

1. **按词边界匹配动词**，不要用 `includes`：`form.txt` 含 `rm`、`removable` 含 `rm`，用子串匹配会把读命令误判成删除。用 `/\b(rm|del|erase|unlink|rd|rmdir|Remove-Item)\b/i` 且对 `rd`/`rm` 要求其后不是字母（避免命中 `rdp`、`rmdir` 被 `rm` 抢走——`rmdir` 要单独列在动词表里并在交替顺序上先于 `rm`）。
2. **递归判定**：`-Recurse`、`-r`、`-rf`、`-fr`、`/s`、`recursive: true`、`rmtree` 任一命中即为递归。`Remove-Item` 无 `-Recurse` 时为非递归。
3. **目标抽取**：从动词之后取第一个非选项 token；遇到 `|`、`$(...)`、`` ` `` 或通配符 `*`/`?` 时返回 `null`。抽出后立即用 `isUnresolvableTarget` 复核。

`isUnresolvableTarget(target)` 的判定：含 `$`（覆盖 `$tmp` / `$env:TEMP` / `$_.FullName` / `${HOME}`）、含 `%` 包裹（`%TEMP%`）、含 `*` 或 `?`、含 `$(` 或反引号——任一为真即 `true`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/command.test.ts`
Expected: PASS，全部用例通过（含 `form.txt` / `removable` 两条反向用例）

- [ ] **Step 5: Commit**

```bash
git add src/command.ts src/types.ts tests/command.test.ts
git commit -m "feat: parse shell delete intent and flag unresolvable targets"
```

---

### Task 3: 路径分类

**Files:**
- Create: `src/classify.ts`
- Test: `tests/classify.test.ts`

**Interfaces:**
- Consumes: `src/types.ts` 的 `Classification = 'free' | 'confirm' | 'protected'`
- Produces:
  - `function classifyPath(absPath: string, env: ClassifyEnv): Classification`
  - `type ClassifyEnv = { home: string; workdir: string; installDir?: string }`
  - `function requiresApproval(classification: Classification): boolean`

- [ ] **Step 1: 写失败测试**

```ts
// tests/classify.test.ts
import { describe, expect, it } from 'vitest'
import { classifyPath, requiresApproval } from '../src/classify'

const env = { home: 'C:\\Users\\alice', workdir: 'C:\\Work\\project' }

describe('classifyPath', () => {
  it('treats ordinary workspace files as free', () => {
    expect(classifyPath('C:\\Work\\project\\build', env)).toBe('free')
    expect(classifyPath('C:\\Work\\other\\dist', env)).toBe('free')
  })

  it('protects profile manifests, patch layers, lockfiles and node_modules', () => {
    const profile = 'C:\\Users\\alice\\.dsh\\profiles\\desktop'
    expect(classifyPath(`${profile}\\package.json`, env)).toBe('protected')
    expect(classifyPath(`${profile}\\cordis.patch.yml`, env)).toBe('protected')
    expect(classifyPath(`${profile}\\pnpm-lock.yaml`, env)).toBe('protected')
    expect(classifyPath(`${profile}\\node_modules`, env)).toBe('protected')
    expect(classifyPath(`${profile}\\node_modules\\some-pkg\\index.js`, env)).toBe('protected')
  })

  it('protects the DSH home patch and settings', () => {
    expect(classifyPath('C:\\Users\\alice\\.dsh\\cordis.patch.yml', env)).toBe('protected')
    expect(classifyPath('C:\\Users\\alice\\.dsh\\settings.yaml', env)).toBe('protected')
  })

  it('marks the rest of the home directory and plugin sources as confirm', () => {
    expect(classifyPath('C:\\Users\\alice\\Documents\\old.txt', env)).toBe('confirm')
    expect(classifyPath('C:\\Users\\alice\\.dsh\\profiles\\desktop\\src', env)).toBe('confirm')
  })

  it('protects the safe zone itself', () => {
    expect(classifyPath('C:\\Users\\alice\\.dsh\\.dsh-safe-delete\\items\\abc', env)).toBe('protected')
  })

  it('normalizes traversal before classifying', () => {
    expect(classifyPath('C:\\Work\\..\\Users\\alice\\.dsh\\profiles\\desktop\\package.json', env)).toBe('protected')
  })

  it('compares paths case-insensitively on Windows paths', () => {
    expect(classifyPath('c:\\users\\alice\\.dsh\\profiles\\desktop\\package.json', env)).toBe('protected')
  })

  it('does not treat a sibling with a shared prefix as inside home', () => {
    expect(classifyPath('C:\\Users\\alice2\\file.txt', env)).toBe('free')
  })
})

describe('requiresApproval', () => {
  it('only asks for confirm and protected', () => {
    expect(requiresApproval('free')).toBe(false)
    expect(requiresApproval('confirm')).toBe(true)
    expect(requiresApproval('protected')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/classify.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `src/classify.ts`**

实现要点：

1. 先 `path.resolve` 规范化，再统一小写比较（Windows 路径大小写不敏感）。
2. **用分隔符边界判断包含关系**：`C:\Users\alice2` 不在 `C:\Users\alice` 内。实现为 `p === root || p.startsWith(root + path.sep)`，不要用裸 `startsWith`。
3. `protected` 判定顺序（先命中先返回）：安全区自身；`<home>/.dsh/profiles/*/` 下的 `package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、任一祖先目录名为 `node_modules`；`<home>/.dsh/cordis.patch.yml`、`<home>/.dsh/settings.yaml`；`installDir`（若提供）下的所有内容。
4. `confirm`：`<home>` 下的一切未被 3 命中的路径。
5. 其余（含工作区与其他盘）为 `free`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/classify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts tests/classify.test.ts
git commit -m "feat: classify paths into free, confirm and protected"
```

---

### Task 4: 目标描述

**Files:**
- Create: `src/describe.ts`
- Test: `tests/describe.test.ts`
- Test support: `tests/support/tmpdir.ts`

**Interfaces:**
- Produces: `function describeTarget(absPath: string): TargetDescription`
- `type TargetDescription = { exists: boolean; isDirectory: boolean; bytes: number; fileCount: number; topEntries: string[]; truncated: boolean }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/describe.test.ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeTarget } from '../src/describe'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dsd-describe-'))
}

describe('describeTarget', () => {
  it('reports a missing path without throwing', () => {
    const result = describeTarget(join(scratch(), 'nope'))
    expect(result.exists).toBe(false)
  })

  it('reports a single file size', () => {
    const dir = scratch()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x'.repeat(1234))
    const result = describeTarget(file)
    expect(result).toMatchObject({ exists: true, isDirectory: false, bytes: 1234, fileCount: 1 })
  })

  it('counts nested files and bytes in a directory', () => {
    const dir = scratch()
    const nested = join(dir, 'sub')
    mkdirSync(nested)
    writeFileSync(join(dir, 'a.txt'), 'x'.repeat(100))
    writeFileSync(join(nested, 'b.txt'), 'x'.repeat(200))
    const result = describeTarget(dir)
    expect(result).toMatchObject({ exists: true, isDirectory: true, bytes: 300, fileCount: 2 })
  })

  it('lists at most the first 20 top-level entries and flags truncation', () => {
    const dir = scratch()
    for (let i = 0; i < 25; i += 1) writeFileSync(join(dir, `f${i}.txt`), 'x')
    const result = describeTarget(dir)
    expect(result.topEntries).toHaveLength(20)
    expect(result.truncated).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/describe.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `src/describe.ts`**

实现要点：用 `statSync` 区分文件与目录；目录用递归遍历累加 `bytes` 与 `fileCount`，顶层名只取前 20 个并按名称排序（保证输出稳定、测试可断言）；遍历时跳过无法读取的条目而不抛错（权限拒绝不应让描述失败）。符号链接不跟随（用 `lstatSync` 判断，避免循环）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/describe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/describe.ts tests/describe.test.ts tests/support/tmpdir.ts
git commit -m "feat: describe a delete target's size and entries"
```

---

### Task 5: 安全区存储

**Files:**
- Create: `src/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `src/types.ts` 的 `TrashEntry`
- Produces:
  - `function moveToSafeZone(stateDir: string, absPath: string, opts: MoveOptions): Promise<TrashEntry>`
  - `function listSafeZone(stateDir: string): Promise<TrashEntry[]>`
  - `function restoreFromSafeZone(stateDir: string, id: string): Promise<{ restoredTo: string }>`
  - `function destroyEntry(stateDir: string, id: string): Promise<void>`
  - `type MoveOptions = { reason?: string; retentionDays: number; now?: number }`
  - `type TrashEntry = { id: string; originalPath: string; movedAt: number; expiresAt: number; bytes: number; fileCount: number; isDirectory: boolean; crossVolume: boolean; reason?: string }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/store.test.ts
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { destroyEntry, listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'

const DAY = 24 * 60 * 60 * 1000

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'dsd-store-'))
  return { work: join(root, 'work'), state: join(root, 'state') }
}

describe('moveToSafeZone', () => {
  it('moves a file out of its original location and records it', async () => {
    const { work, state } = scratch()
    mkdirSync(work)
    const file = join(work, 'a.txt')
    writeFileSync(file, 'hello')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7, now: 0 })
    expect(existsSync(file)).toBe(false)
    expect(entry.originalPath).toBe(file)
    expect(entry.bytes).toBe(5)
    expect(entry.expiresAt).toBe(7 * DAY)
    expect(await listSafeZone(state)).toHaveLength(1)
  })

  it('moves a whole directory tree', async () => {
    const { work, state } = scratch()
    const dir = join(work, 'tree')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x')
    const entry = await moveToSafeZone(state, dir, { retentionDays: 7 })
    expect(existsSync(dir)).toBe(false)
    expect(entry).toMatchObject({ isDirectory: true, fileCount: 1 })
  })

  it('keeps two entries when the same path is deleted twice', async () => {
    const { work, state } = scratch()
    const dir = join(work, 'twice')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'one')
    const first = await moveToSafeZone(state, dir, { retentionDays: 7 })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'two')
    const second = await moveToSafeZone(state, dir, { retentionDays: 7 })
    expect(first.id).not.toBe(second.id)
    expect(await listSafeZone(state)).toHaveLength(2)
  })

  it('refuses to move the safe zone into itself', async () => {
    const { state } = scratch()
    mkdirSync(state, { recursive: true })
    await expect(moveToSafeZone(state, state, { retentionDays: 7 })).rejects.toThrow(/safe zone/i)
  })
})

describe('restoreFromSafeZone', () => {
  it('restores to the original path', async () => {
    const { work, state } = scratch()
    mkdirSync(work)
    const file = join(work, 'a.txt')
    writeFileSync(file, 'hello')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })
    const { restoredTo } = await restoreFromSafeZone(state, entry.id)
    expect(restoredTo).toBe(file)
    expect(readFileSync(file, 'utf8')).toBe('hello')
    expect(await listSafeZone(state)).toHaveLength(0)
  })

  it('restores to a .restored sibling instead of overwriting an occupied path', async () => {
    const { work, state } = scratch()
    mkdirSync(work)
    const file = join(work, 'a.txt')
    writeFileSync(file, 'old')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })
    writeFileSync(file, 'new')
    const { restoredTo } = await restoreFromSafeZone(state, entry.id)
    expect(restoredTo).not.toBe(file)
    expect(readFileSync(restoredTo, 'utf8')).toBe('old')
    expect(readFileSync(file, 'utf8')).toBe('new')
  })

  it('rejects an unknown id', async () => {
    const { state } = scratch()
    await expect(restoreFromSafeZone(state, 'nope')).rejects.toThrow(/unknown/i)
  })
})

describe('destroyEntry', () => {
  it('removes the entry from disk and from the index', async () => {
    const { work, state } = scratch()
    mkdirSync(work)
    const file = join(work, 'a.txt')
    writeFileSync(file, 'hello')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })
    await destroyEntry(state, entry.id)
    expect(await listSafeZone(state)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/store.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `src/store.ts`**

实现要点：

1. **布局**：`<stateDir>/items/<id>/` 存放被移入的内容，`<stateDir>/index.json` 保存 `TrashEntry[]`。索引读写用"写临时文件 + rename"保证原子性。
2. **移入用 `renameSync`**（同一卷内是 O(1)）。捕获 `EXDEV`：`crossVolumeCopy` 为假时抛错，错误消息说明"安全区与目标不在同一磁盘卷，请把安全区换到同一卷或改用其他方式"；为真时才退化为 `cpSync` + 校验 + 删除源。
3. **id 格式**：`YYYYMMDD-HHmmss-<6位随机>`，保证可读且不冲突。
4. **安全区自保护**：目标路径等于或包含 `stateDir` 时抛错，消息含 "safe zone"（测试按此断言）。
5. `restoreFromSafeZone`：原路径存在则还原到同级 `.restored-<时间戳>` 兄弟；还原后从索引移除该条。
6. `destroyEntry`：删除 `items/<id>` 并从索引移除。**这是代码中唯一允许递归删除的地方**，且只针对安全区内部路径。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/store.test.ts`
Expected: PASS，7 个用例全过

- [ ] **Step 5: Commit**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "feat: add the safe zone with move, restore and destroy"
```

---

### Task 6: 清理策略

**Files:**
- Create: `src/prune.ts`
- Test: `tests/prune.test.ts`

**Interfaces:**
- Consumes: `src/store.ts` 的 `TrashEntry`
- Produces:
  - `function selectForPrune(entries: TrashEntry[], opts: PruneOptions): TrashEntry[]`
  - `function safeZoneBytes(entries: TrashEntry[]): number`
  - `type PruneOptions = { now: number; maxBytes: number }`

`selectForPrune` 是纯函数：给定条目与策略，返回应当销毁的条目，**按销毁顺序排列**（最旧优先）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/prune.test.ts
import { describe, expect, it } from 'vitest'
import { safeZoneBytes, selectForPrune } from '../src/prune'
import type { TrashEntry } from '../src/types'

const DAY = 24 * 60 * 60 * 1000
const GB = 1024 ** 3

function entry(over: Partial<TrashEntry>): TrashEntry {
  return {
    id: 'id', originalPath: 'C:\\x', movedAt: 0, expiresAt: 0,
    bytes: 0, fileCount: 1, isDirectory: false, crossVolume: false, ...over,
  }
}

describe('selectForPrune', () => {
  it('selects entries past their expiry', () => {
    const entries = [entry({ id: 'old', expiresAt: 100 }), entry({ id: 'fresh', expiresAt: 1000 })]
    expect(selectForPrune(entries, { now: 500, maxBytes: 100 }).map((e) => e.id)).toEqual(['old'])
  })

  it('keeps everything when nothing expired and the cap is not exceeded', () => {
    const entries = [entry({ id: 'a', expiresAt: 1000, bytes: 10 })]
    expect(selectForPrune(entries, { now: 0, maxBytes: 100 })).toEqual([])
  })

  it('destroys oldest first until the safe zone fits the byte cap', () => {
    const entries = [
      entry({ id: 'newest', expiresAt: 9e9, bytes: 50 * GB, movedAt: 300 }),
      entry({ id: 'oldest', expiresAt: 9e9, bytes: 50 * GB, movedAt: 100 }),
      entry({ id: 'middle', expiresAt: 9e9, bytes: 50 * GB, movedAt: 200 }),
    ]
    const selected = selectForPrune(entries, { now: 0, maxBytes: 60 * GB })
    expect(selected.map((e) => e.id)).toEqual(['oldest', 'middle'])
    expect(safeZoneBytes(entries) - safeZoneBytes(selected)).toBeLessThanOrEqual(60 * GB)
  })

  it('never selects an entry twice when it is both expired and over the cap', () => {
    const entries = [entry({ id: 'only', expiresAt: 10, bytes: 90 * GB, movedAt: 1 })]
    expect(selectForPrune(entries, { now: 100, maxBytes: 10 * GB }).map((e) => e.id)).toEqual(['only'])
  })
})

describe('safeZoneBytes', () => {
  it('sums entry sizes', () => {
    expect(safeZoneBytes([entry({ bytes: 5 }), entry({ bytes: 7 })])).toBe(12)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/prune.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `src/prune.ts`**

实现要点：先挑出 `expiresAt <= now` 的条目（按 `movedAt` 升序），再从剩余条目里按 `movedAt` 升序继续挑，直到剩余总量 ≤ `maxBytes`。用 `Set<id>` 去重，保证同一条目不会出现两次。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/prune.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/prune.ts tests/prune.test.ts
git commit -m "feat: select safe-zone entries to prune by age and capacity"
```

---

### Task 7: 工具定义（safe_delete 及管理工具）

**Files:**
- Create: `src/tools.ts`
- Test: `tests/tools.test.ts`
- Test support: `tests/support/fake-ctx.ts`

**Interfaces:**
- Consumes: `classifyPath` / `requiresApproval`（Task 3）、`describeTarget`（Task 4）、`moveToSafeZone` / `listSafeZone` / `restoreFromSafeZone` / `destroyEntry`（Task 5）、`selectForPrune`（Task 6）
- Produces:
  - `function createTools(deps: ToolDeps): ToolDefinition[]`
  - `type ToolDeps = { stateDir: string; env: ClassifyEnv; requestApproval(reason: string): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>; retentionDays: number; maxBytes: number; now?: () => number }`
  - `type ToolDefinition = { name: string; description: string; parameters: JsonSchemaSubset; output: {...}; execute(args: Record<string, unknown>): Promise<{ ok: boolean; text: string; error?: string }> }`
  - 五个工具名：`safe_delete`、`safe_zone_list`、`safe_zone_restore`、`safe_zone_status`、`safe_zone_check`

- [ ] **Step 1: 写失败测试**

```ts
// tests/tools.test.ts
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTools, type ToolDeps } from '../src/tools'

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'dsd-tools-'))
  return { work: join(root, 'work'), state: join(root, 'state') }
}

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  const { work, state } = scratch()
  mkdirSync(work, { recursive: true })
  return {
    stateDir: state,
    env: { home: join(work, 'home'), workdir: work },
    requestApproval: async () => 'allowed-once',
    retentionDays: 7,
    maxBytes: 20 * 1024 ** 3,
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
    const d = deps({ requestApproval: async () => { asked = true; return 'allowed-once' } })
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
    const rejected = await toolOf(createTools({ ...d, requestApproval: async () => 'rejected' }), 'safe_delete')
      .execute({ path: file })
    const unavailable = await toolOf(createTools({ ...d, requestApproval: async () => 'unavailable' }), 'safe_delete')
      .execute({ path: file })
    expect(rejected.error).toMatch(/rejected/i)
    expect(unavailable.error).toMatch(/no approval channel|unavailable/i)
    expect(rejected.error).not.toBe(unavailable.error)
  })

  it('never treats force:true as an approval', async () => {
    let asked = false
    const d = deps({ requestApproval: async () => { asked = true; return 'rejected' } })
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
  it('reports the retention window and the byte cap', async () => {
    const result = await toolOf(createTools(deps()), 'safe_zone_status').execute({})
    expect(result.text).toMatch(/7/)
    expect(result.text).toMatch(/20/)
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/tools.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `src/tools.ts`**

实现要点：

1. **手写 JSON Schema 子集**，形状照 dsh-safety 的 `toJsonSchema`（`{ type, properties, required, additionalProperties: false }`），不 import `defineTool`。
2. `safe_delete` 执行顺序（顺序即正确性）：存在性检查 → 拒绝盘符根与安全区自身 → `describeTarget` → `preview` 则返回 → `classifyPath` → `requiresApproval` 才调 `requestApproval` → `moveToSafeZone`。
3. **拒绝消息必须可分辨**：`rejected` 返回 `error` 含 "user rejected"；`unavailable` 返回 `error` 含 "no approval channel"；`cancelled` 含 "cancelled"。三者不要合并成一句话——模型需要知道"人说不"和"没有通道"是两回事。
4. **`force` 参数保留在 schema 里但对逻辑零影响**：它只作为提示存在，任何路径分类判定都不读它。
5. `safe_delete` 成功后返回文本里必须包含 `id: <id>`（测试用正则提取）。
6. `safe_zone_check` 只读：检查 `<home>/.dsh/profiles/*/package.json` 的 JSON 可解析、`cordis.patch.yml` 可读且非空、跨层重复的行 id。**不写任何文件、不建快照**。
7. 所有 `execute` 用 try/catch 包住，异常转成 `{ ok: false, error: '[dsh-safe-delete] ...' }`，绝不抛到工具管线。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/tools.test.ts`
Expected: PASS，全部用例通过

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/tools.test.ts tests/support/fake-ctx.ts
git commit -m "feat: add safe_delete and safe-zone management tools"
```

---

### Task 8: 插件接线（拦截 + 审批 + 注册）

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `createTools`（Task 7）、`parseCommand`（Task 2）
- Produces: 装配后的插件——`tools/pre-execute` 监听器、工具注册、系统提示段

- [ ] **Step 1: 写失败测试**

```ts
// tests/index.test.ts
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import { makeFakeCtx } from './support/fake-ctx'

describe('apply', () => {
  it('registers the safe-delete tools', () => {
    const ctx = makeFakeCtx()
    apply(ctx, { stateDir: 'C:\\tmp\\state' })
    expect(ctx.registeredTools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['safe_delete', 'safe_zone_list', 'safe_zone_restore', 'safe_zone_status', 'safe_zone_check']),
    )
  })

  it('blocks a recursive shell delete and points at safe_delete', async () => {
    const ctx = makeFakeCtx()
    apply(ctx, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse C:\\Work\\x' } })
    expect(decision.kind).toBe('deny')
    expect(decision.reason).toMatch(/safe_delete/)
  })

  it('asks instead of denying when the target cannot be resolved', async () => {
    const ctx = makeFakeCtx()
    apply(ctx, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse $tmp' } })
    expect(decision.kind).toBe('ask')
  })

  it('lets non-destructive commands through', async () => {
    const ctx = makeFakeCtx()
    apply(ctx, { stateDir: 'C:\\tmp\\state' })
    expect((await ctx.preExecute({ name: 'pwsh', arguments: { command: 'Get-ChildItem C:\\Work' } })).kind).toBe('allow')
  })

  it('inspects run_code bodies and terminal_send text', async () => {
    const ctx = makeFakeCtx()
    apply(ctx, { stateDir: 'C:\\tmp\\state' })
    expect((await ctx.preExecute({ name: 'run_code', arguments: { code: "fs.rmSync('C:\\\\x', { recursive: true })" } })).kind).toBe('deny')
    expect((await ctx.preExecute({ name: 'terminal_send', arguments: { text: 'rm -rf /tmp/x', submit: true } })).kind).toBe('deny')
  })

  it('never blocks its own safe_delete tool', async () => {
    const ctx = makeFakeCtx()
    apply(ctx, { stateDir: 'C:\\tmp\\state' })
    const decision = await ctx.preExecute({ name: 'safe_delete', arguments: { path: 'C:\\Work\\x' } })
    expect(decision.kind).toBe('allow')
  })

  it('survives a context without the approval service', async () => {
    const ctx = makeFakeCtx({ approval: undefined })
    expect(() => apply(ctx, { stateDir: 'C:\\tmp\\state' })).not.toThrow()
  })

  it('does not throw when tool registration fails', () => {
    const ctx = makeFakeCtx({ toolsRegisterThrows: true })
    expect(() => apply(ctx, { stateDir: 'C:\\tmp\\state' })).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/index.test.ts`
Expected: FAIL，工具未注册 / 决策不正确

- [ ] **Step 3: 实现接线**

实现要点：

1. `inject` 改为 `['tools', 'systemPrompt']`；`apply` 保持 fail-soft 外壳。
2. 注册 `ctx.on('tools/pre-execute', handler)`：对 `bash` / `pwsh` / `run_code` / `terminal_send` 取命令文本（分别是 `arguments.command` / `arguments.command` / `arguments.code` / `arguments.text`），`parseCommand` 判定。
   - 非破坏性 → `next()`。
   - 破坏性且 `target === null`（无法解析）→ 返回 `{ kind: 'ask', reason, displayReason }`，**不**直接拒绝。
   - 破坏性且有明确 target → 返回 `{ kind: 'deny', reason }`，reason 里写明"用 `safe_delete`（可撤销）"。
3. `displayReason` 需要 `{ en, zh }` 两种文案（与 DSH 内置审批卡片的约定一致）。
4. 通过 `ctx.systemPrompt.section({ name: 'dsh-safe-delete:policy', order: 200, text })` 注入行为约定：重要删除先 `preview`；shell 删除被拦就改走 `safe_delete`，不许换工具绕过；被拒绝时不要重试。
5. 配置解析：`stateDir` 默认 `<DSH_HOME>/.dsh-safe-delete`；读 `retentionDays` / `maxBytes` / `autoPrune` / `crossVolumeCopy`。
6. `requestApproval` 由 `ctx.get('approval')` 提供：有服务则调用 `request({ agent, toolName, callId, reason, displayReason, signal })` 并映射结果；无服务时一律返回 `'unavailable'`。**不要在此处伪造放行**。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/index.test.ts && pnpm vitest run`
Expected: 全部测试通过（8 个文件）

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts tests/support/fake-ctx.ts
git commit -m "feat: wire the delete guard, approval ask, and tool registration"
```

---

### Task 9: 独立 CLI 兜底

**Files:**
- Create: `bin/dsh-safe-delete.mjs`
- Modify: `package.json`（加 `bin` 字段）
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `lib/index.js` 导出的安全区函数（构建产物）
- Produces: `dsh-safe-delete <list|undo|prune|check> [args]`

- [ ] **Step 1: 写失败测试**

```ts
// tests/cli.test.ts
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/dsh-safe-delete.mjs', import.meta.url))

function run(args: string[], env: Record<string, string> = {}) {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('cli', () => {
  it('prints usage with no arguments', () => {
    expect(run([])).toMatch(/usage/i)
  })

  it('lists an empty safe zone', () => {
    expect(run(['list'])).toMatch(/empty/i)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/cli.test.ts`
Expected: FAIL，`bin/dsh-safe-delete.mjs` 不存在

- [ ] **Step 3: 实现 CLI**

实现要点：`bin/dsh-safe-delete.mjs` 是 ESM，从 `../lib/index.js` 导入安全区函数。命令：`list`（列出条目）、`undo <id>`（取回）、`prune [--dry-run]`（按策略清理）、`check`（只读体检）、无参数时打印用法。状态目录从 `DSH_HOME` 环境变量推导。**`undo` 是本插件唯一的对外人工通道**，必须能独立工作（不依赖 DSH 运行）。

`package.json` 增加：`"bin": { "dsh-safe-delete": "bin/dsh-safe-delete.mjs" }`，并把 `bin/` 加进 `files`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm build && pnpm vitest run tests/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/dsh-safe-delete.mjs package.json tests/cli.test.ts
git commit -m "feat: add standalone CLI for undo, prune and check"
```

---

### Task 10: 端到端验证与安装

**Files:**
- Create: `docs/VERIFY.md`

- [ ] **Step 1: 全量测试与构建**

Run: `pnpm typecheck && pnpm vitest run && pnpm build`
Expected: 三条命令退出 0；测试全绿

- [ ] **Step 2: 写验证清单 `docs/VERIFY.md`**

内容为可手工执行的验收步骤，每条写明"预期看到什么"：

1. 把插件以 `link:` 方式装进一个测试 profile，启动 DSH，确认插件加载且工具出现在工具列表。
2. 让模型执行 `Remove-Item -Recurse <某个测试目录>`：预期被拒绝，理由里提到 `safe_delete`。
3. 让模型执行 `Remove-Item -Recurse $tmp`：预期弹出审批卡片（不是直接拒绝）。**注意**：此步要求会话审批策略为 `ask`；`never` 下预期直接拒绝且不弹卡。
4. 调 `safe_delete` 删一个工作区文件：预期不弹卡、直接进安全区，返回里带 `id`。
5. 调 `safe_delete` 删 `$HOME` 下的文件：预期弹卡；点"拒绝"后文件仍在；点"允许一次"后进安全区。
6. `safe_zone_restore` 用第 4 步的 id 取回：预期文件回到原位置、内容一致。
7. 把 `maxBytes` 调成 `1`，再删两个文件，调 `safe_zone_status`：预期最旧条目被清理。
8. 重启 DSH，`safe_zone_list`：预期条目仍在（状态落盘）。

- [ ] **Step 3: 在本机实装验证**

按 `docs/VERIFY.md` 逐条执行，把实际结果记进同一个文件。**任何一条不符合预期就停下来修，不要勾选。**

- [ ] **Step 4: Commit**

```bash
git add docs/VERIFY.md
git commit -m "docs: add end-to-end verification checklist with results"
```

---

## 完成标准

- `pnpm typecheck && pnpm vitest run && pnpm build` 全绿。
- `docs/VERIFY.md` 的 8 条全部实测通过并记录。
- 插件装进测试 profile 后 DSH 能正常启动，工具可用。
- `src/` 里没有任何 `@deepseek-ai/*` import。
