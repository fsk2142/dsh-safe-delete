/**
 * 拦截器有效性验证：用真实命令跑一遍完整判定链，确认没有任何"静默失效"。
 *
 * 为什么单独做这一份：单元测试证明各模块「在自己的假设下」正确，但拦截是否真的
 * 生效，取决于 `apply()` 接线、分类器、命令解析三者串起来的结果。一个符号写错，
 * 单元测试可能仍全绿，而实际拦截已经失效 —— 那种失败是静默的。
 */
import os from 'node:os'
import path from 'node:path'

import { apply } from '../src/index'
import { classifyPath } from '../src/classify'
import { parseCommand } from '../src/command'

interface Case {
  name: string
  tool: string
  args: Record<string, unknown>
  expect: 'deny' | 'ask' | 'allow'
}

const home = os.homedir()
const dshHome = path.join(home, '.dsh')

/** 最小假 ctx：只提供 apply 需要的面。 */
function makeCtx() {
  const listeners = new Map<string, Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>>()
  const tools: Array<{ name: string }> = []
  return {
    tools,
    get(id: string) {
      if (id === 'tools') return { register: (t: { name: string }) => { tools.push(t); return () => {} } }
      if (id === 'systemPrompt') return { section: () => () => {} }
      if (id === 'logger') return { warn: () => {} }
      return undefined
    },
    on(event: string, fn: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    effect(fn: () => unknown) { fn(); return () => {} },
    async preExecute(exec: { name: string; arguments: Record<string, unknown> }) {
      const list = listeners.get('tools/pre-execute') ?? []
      let i = 0
      const next = async (): Promise<unknown> => {
        if (i >= list.length) return { kind: 'allow' }
        return list[i++]!(exec, next)
      }
      return next()
    },
  }
}

const cases: Case[] = [
  // ── 必须拦下的：裸 shell 删除 ──
  { name: 'PowerShell 递归删除', tool: 'pwsh', args: { command: 'Remove-Item -Recurse -Force C:\\Work\\x' }, expect: 'deny' },
  { name: 'POSIX rm -rf', tool: 'bash', args: { command: 'rm -rf /tmp/x' }, expect: 'deny' },
  { name: 'rd /s', tool: 'pwsh', args: { command: 'rd /s /q C:\\Work\\x' }, expect: 'deny' },
  { name: 'node fs.rmSync', tool: 'run_code', args: { code: "fs.rmSync('C:\\\\x', { recursive: true })" }, expect: 'deny' },
  { name: 'python rmtree', tool: 'run_code', args: { code: "shutil.rmtree('/tmp/x')" }, expect: 'deny' },
  { name: 'terminal_send 里的删除', tool: 'terminal_send', args: { text: 'rm -rf /tmp/x', submit: true }, expect: 'deny' },
  { name: '反斜杠转义 r\\m', tool: 'bash', args: { command: 'r\\m -rf /tmp/x' }, expect: 'deny' },
  { name: '引号拼接 r""m', tool: 'bash', args: { command: 'r""m -rf /tmp/x' }, expect: 'deny' },
  { name: 'PowerShell 别名 ri', tool: 'pwsh', args: { command: 'ri -Recurse C:\\x' }, expect: 'deny' },
  { name: 'cmd /c 包裹', tool: 'bash', args: { command: 'cmd /c "rd /s /q C:\\Work\\x"' }, expect: 'deny' },

  // ── 必须拦下的：写坏启动关键文件 ──
  { name: '写 profile package.json', tool: 'write', args: { file_path: path.join(dshHome, 'profiles', 'desktop', 'package.json'), content: '{}' }, expect: 'deny' },
  { name: '编辑 cordis.patch.yml', tool: 'edit', args: { file_path: path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml') }, expect: 'deny' },
  { name: '写 node_modules', tool: 'write', args: { file_path: path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'x', 'y.js'), content: 'x' }, expect: 'deny' },
  { name: 'str_replace_editor 改清单', tool: 'str_replace_editor', args: { command: 'str_replace', path: path.join(dshHome, 'cordis.patch.yml') }, expect: 'deny' },

  // ── 必须问人：目标看不清 ──
  { name: '变量目标 $tmp', tool: 'pwsh', args: { command: 'Remove-Item -Recurse $tmp' }, expect: 'ask' },
  { name: '编码命令', tool: 'pwsh', args: { command: 'powershell -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtAA==' }, expect: 'ask' },
  { name: '管道删除', tool: 'pwsh', args: { command: 'Get-ChildItem C:\\Work | Remove-Item -Recurse' }, expect: 'ask' },

  // ── 必须放行：正常操作，不能误伤 ──
  { name: '读目录', tool: 'pwsh', args: { command: 'Get-ChildItem C:\\Work' }, expect: 'allow' },
  { name: '跑构建', tool: 'bash', args: { command: 'npm run build' }, expect: 'allow' },
  { name: 'git status', tool: 'bash', args: { command: 'git status' }, expect: 'allow' },
  { name: '写普通工作区文件', tool: 'write', args: { file_path: 'C:\\Work\\proj\\src\\index.ts', content: 'x' }, expect: 'allow' },
  { name: 'str_replace_editor view', tool: 'str_replace_editor', args: { command: 'view', path: path.join(dshHome, 'cordis.patch.yml') }, expect: 'allow' },
  { name: '家目录普通文档编辑', tool: 'write', args: { file_path: path.join(home, 'Documents', 'notes.md'), content: 'x' }, expect: 'allow' },
  { name: 'safe_delete 自身', tool: 'safe_delete', args: { path: 'C:\\Work\\x', preview: true }, expect: 'allow' },
  { name: '读文件工具', tool: 'read', args: { file_path: path.join(dshHome, 'cordis.patch.yml') }, expect: 'allow' },
]

const ctx = makeCtx()
apply(ctx as never, {})

let pass = 0
const failures: string[] = []

for (const c of cases) {
  const decision = (await ctx.preExecute({ name: c.tool, arguments: c.args })) as { kind?: string; reason?: string }
  const actual = decision.kind === 'deny' ? 'deny' : decision.kind === 'ask' ? 'ask' : 'allow'
  const ok = actual === c.expect
  if (ok) pass += 1
  else failures.push(`${c.name}: 期望 ${c.expect}，实际 ${actual}${decision.reason === undefined ? '' : `\n     理由: ${decision.reason.slice(0, 120)}`}`)
}

console.log(`注册的工具: ${ctx.tools.map((t) => t.name).join(', ')}`)
console.log('')
console.log(`通过 ${pass} / ${cases.length}`)
if (failures.length > 0) {
  console.log('\n失败项:')
  for (const f of failures) console.log(`  [FAIL] ${f}`)
  process.exitCode = 1
} else {
  console.log('全部符合预期 —— 拦截链没有静默失效。')
}
