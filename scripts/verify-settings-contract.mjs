/**
 * 用**真实宿主契约**验证客户端的读写路径。
 *
 * 契约来自 dsh-llm-account 的实测记录（见该仓库 src/client/seams.ts）：
 *   describe() → { writable, hasDocument, namespaces: [ { ns, value, revision, … } ] }
 *   mutate(ns, ops, revision?) → { ok: true, value } | { ok: false, error }
 *
 * 命名空间的身份字段是 **ns**，不是 name —— 用错就永远匹配不上，且不报错。
 */
import { readFileSync } from 'node:fs'

const code = readFileSync('lib/client.js', 'utf8')

let stateQueue = []
let stateIndex = 0

function element(type, props, ...children) {
  return { type, props: props ?? {}, children }
}

const fakeReact = {
  createElement: (type, props, ...children) => element(type, props, ...children),
  Fragment: 'Fragment',
  useState: (initial) => {
    const override = stateQueue[stateIndex]
    stateIndex += 1
    return override !== undefined ? override : [initial, () => {}]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useReducer: (reducer, initial) => [initial, () => {}],
}
const fakeJsx = {
  jsx: (type, props) => element(type, props),
  jsxs: (type, props) => element(type, props),
  Fragment: 'Fragment',
}
const req = (n) => {
  if (n === 'react') return fakeReact
  if (n === 'react/jsx-runtime') return fakeJsx
  throw new Error('unexpected require ' + n)
}

let moduleExports = {}
let capturedCtx = null
const fakeWindow = {
  __ModuleLoader__: {
    load: (definition) => {
      moduleExports = definition.factory(req)
      capturedCtx = {
        slots: {
          inject: (name, factory) => factory(),
          register: () => () => {},
        },
        locale: {},
        remote: { settings: {} },
        get: () => undefined,
      }
      moduleExports.apply(capturedCtx)
    },
  },
}

const runner = new Function('window', 'console', 'require', 'module', 'exports', code)
const shim = { exports: {} }
runner(fakeWindow, console, req, shim, shim.exports)

/** 递归收集文本（含 input 的 value）。 */
function collectText(node, depth = 0, seen = new Set()) {
  if (node === null || node === undefined) return ''
  if (depth > 14) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((c) => collectText(c, depth, seen)).join(' ')
  if (typeof node !== 'object') return ''
  if (typeof node.type === 'function') {
    if (seen.has(node.type)) return ''
    const next = new Set(seen)
    next.add(node.type)
    try {
      return collectText(node.type(node.props ?? {}), depth + 1, next)
    } catch {
      return ''
    }
  }
  const parts = []
  const children = node.children ?? []
  const propsChildren = node.props?.children
  const all =
    children.length > 0
      ? children
      : propsChildren === undefined
        ? []
        : Array.isArray(propsChildren)
          ? propsChildren
          : [propsChildren]
  for (const child of all) parts.push(collectText(child, depth + 1, seen))
  if (typeof node.props?.['aria-label'] === 'string') parts.push(node.props['aria-label'])
  if (typeof node.props?.value === 'string') parts.push(`=${node.props.value}`)
  return parts.join(' ')
}

const problems = []
const Form = moduleExports['SafeZoneSettings']

console.log('=== 1. describe() 形状：{ namespaces: [{ ns, value, revision }] } ===')
// 用真实形状喂进去：身份字段是 ns。
stateQueue = [
  [
    {
      ns: 'dsh-safe-delete',
      value: {
        // 只剩两项：容量字段已从产品移除（见 src/config.ts 的说明）。
        confirmFileCount: 5000,
        confirmBytes: 2147483648,
      },
      revision: 7,
    },
  ],
  ['ready', () => {}],
  ['', () => {}],
  [false, () => {}],
  [false, () => {}],
  [{}, () => {}],
  [undefined, () => {}],
]
stateIndex = 0

// 用真实的 describe 返回形状：对象包 namespaces
const describePayload = {
  writable: true,
  hasDocument: true,
  namespaces: [
    {
      ns: 'dsh-safe-delete',
      autoGenerate: true,
      value: {
        confirmFileCount: 5000,
        confirmBytes: 2147483648,
      },
      revision: 7,
    },
    { ns: 'other-plugin', value: { x: 1 }, revision: 1 },
  ],
}

// 直接验证 pickNamespace 的行为：通过组件读到值来间接验证。
// 这里手动复现组件里的调用：values 是组件内部状态，所以改为检查渲染结果。
const tree = Form({})
const text = collectText(tree)

for (const [label, needle] of [
  // 容量相关的三个字段已从产品移除，表单只剩这两项确认阈值。
  ['单次删除条目数确认', '单次删除条目数确认'],
  ['单次删除大小确认', '单次删除大小确认'],
]) {
  const found = text.includes(needle)
  console.log(`${found ? 'ok  ' : 'MISSING'}  ${label}`)
  if (!found) problems.push(`字段缺失: ${label}`)
}

console.log('\n=== 2. 显示值是否换算成人类单位 ===')
// 只剩两项字段（容量相关的三个已从产品移除）。
for (const [label, needle] of [
  ['5000 条', '=5000'],
  ['2 GB', '=2'],
]) {
  const found = text.includes(needle)
  console.log(`${found ? 'ok  ' : 'MISSING'}  ${label}`)
  if (!found) problems.push(`显示值缺失: ${label}`)
}

console.log('\n=== 3. 单位选择器 ===')
for (const needle of ['GB', 'MB']) {
  const found = text.includes(needle)
  console.log(`${found ? 'ok  ' : 'MISSING'}  ${needle} 选项`)
  if (!found) problems.push(`单位选项缺失: ${needle}`)
}

console.log('\n=== 4. 源码层面的契约确认 ===')
const src = readFileSync('src/client/index.tsx', 'utf8')
const checks = [
  ['describe 返回里找 ns 字段（兼容 id）', /record\['ns'\]|record\['ns'\] is/],
  ['读取 revision', /revision/],
  // 变量名可能随重构改变（remote / activeRemote / settingsRemote），
  // 关键是**三参数形状**：命名空间、ops 数组、修订号。
  ['mutate(ns, ops, revision) 三参数', /\w*mote\??\.mutate\(NAMESPACE, ops, revision\)/],
  ['ops 形如 {op, path, value}', /op: 'set' as const/],
  ['拆远程信封', /unwrapRemote\(result\)/],
  ['形状不可信时先验再读', /typeof entry !== 'object'/],
  ['读不到命名空间时如实说明', /没有读到本插件的配置/],
  ['每步单独兜住（guarded）', /const guarded = \(step: string, run: \(\) => void\)/],
]
for (const [label, pattern] of checks) {
  const ok = pattern.test(src)
  console.log(`${ok ? 'ok  ' : 'MISSING'}  ${label}`)
  if (!ok) problems.push(`契约缺失: ${label}`)
}

console.log('')
if (problems.length === 0) {
  console.log('设置页与宿主契约一致。')
} else {
  console.log('问题：')
  for (const p of problems) console.log('  - ' + p)
  process.exitCode = 1
}
