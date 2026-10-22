/**
 * 第一轮：在 Node 里模拟宿主 loader，真正跑一遍客户端的 `apply()`。
 *
 * 为什么值得做：此前只能「确认产物生成成功」，无法确认 `apply()` 里注册槽位用的
 * 参数形状对不对、会不会抛错。产物是 CJS + loader 包装，可以用一个假的
 * `window.__ModuleLoader__` 与 `require` 把它跑起来。
 */
import { readFileSync } from 'node:fs'

const code = readFileSync('lib/client.js', 'utf8')

const registered = []
let injectedSlot = ''
const servedNamespaces = []
let loadCallCount = 0
let moduleId = ''

/** 假的最小 React：hook 与 createElement 不抛即可。 */
const fakeReact = {
  createElement: (...args) => ({ args }),
  Fragment: 'Fragment',
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useReducer: (reducer, initial) => [initial, () => {}],
}
const fakeJsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: 'Fragment',
}

const requireImpl = (name) => {
  if (name === 'react') return fakeReact
  if (name === 'react/jsx-runtime') return fakeJsxRuntime
  throw new Error(`unexpected require: ${name}`)
}

const fakeWindow = {
  __ModuleLoader__: {
    load: (definition) => {
      loadCallCount += 1
      moduleId = definition.id
      const exports = definition.factory(requireImpl)
      runPlugin(exports)
    },
  },
}

const ctx = {
  slots: {
    inject: (name, factory) => {
      injectedSlot = name
      factory()
    },
    register: (spec, component) => {
      registered.push({ spec, component })
      return () => {}
    },
  },
  // 配置页必须等 `configForms` 服务就绪才注册（与 dsh-context 同一套写法）。
  // 这里模拟宿主：服务已就绪，`whileServed` 立刻执行回调。
  configForms: {
    get: () => ({}),
    whileServed: (namespaces, register) => {
      servedNamespaces.push(...namespaces)
      register()
      return () => {}
    },
  },
  inject: (services, callback) => {
    const scoped = {}
    for (const service of services) {
      if (service === 'configForms') scoped.configForms = ctx.configForms
    }
    callback(scoped)
    return () => {}
  },
  locale: {},
  remote: { settings: {} },
  get: () => undefined,
}

function runPlugin(exports) {
  console.log('导出:', Object.keys(exports).sort().join(', '))
  const apply = exports['apply']
  if (typeof apply !== 'function') {
    console.log('  ✗ apply 不是函数')
    return
  }
  try {
    apply(ctx)
    console.log('  ✓ apply() 未抛错')
  } catch (error) {
    console.log('  ✗ apply() 抛错:', error instanceof Error ? error.message : String(error))
  }
  console.log('  inject:', JSON.stringify(exports['inject']))
}

// 用一个函数把产物包起来，注入 window 与 require。
const runner = new Function('window', 'console', 'require', 'module', 'exports', code)
const moduleShim = { exports: {} }
runner(fakeWindow, console, requireImpl, moduleShim, moduleShim.exports)

console.log('\n=== 结果 ===')
console.log(`loader.load 调用次数: ${loadCallCount}`)
console.log(`模块 id: ${moduleId}`)
console.log(`inject 的槽位: ${injectedSlot || '(无)'}`)
console.log(`whileServed 的 namespace: ${servedNamespaces.join(', ') || '(无)'}`)
console.log(`注册的表单条数: ${registered.length}`)
for (const item of registered) {
  console.log(`  spec: ${JSON.stringify(item.spec)}`)
  console.log(`  component 类型: ${typeof item.component}`)
}

const problems = []
if (loadCallCount !== 1) problems.push('loader.load 应该恰好被调用一次')
if (moduleId !== 'dsh-safe-delete') problems.push('模块 id 不匹配')
// 真实可用插件（dsh-context）用的是 plugins.bundle.config + 包名作 key。
if (injectedSlot !== 'plugins.bundle.config') problems.push('没有注册到 plugins.bundle.config')
if (registered.length !== 1) problems.push('应该恰好注册一个表单')
if (registered[0]?.spec?.key !== 'dsh-safe-delete') problems.push('槽位 key 应当是包名')
if (!servedNamespaces.includes('dsh-safe-delete')) problems.push('没有通过 whileServed 绑定 namespace')

console.log('')
if (problems.length === 0) {
  console.log('客户端 apply() 行为符合预期。')
} else {
  console.log('问题：')
  for (const p of problems) console.log('  - ' + p)
  process.exitCode = 1
}
