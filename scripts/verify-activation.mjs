/**
 * 模拟宿主激活客户端包：用真实的 lib/client.js，按宿主的规则判定 inject。
 *
 * 规则来自 app-boot：`Object.keys(fiber.inject).filter((s) => ctx.get(s) === void 0)`
 * 缺一个就把 fiber 停在 pending，**apply 永不执行**。这里照此判定。
 */
import { readFileSync } from 'node:fs'

const source = readFileSync('lib/client.js', 'utf8')

// 宿主实际会提供的客户端服务（slots / locale 来自宿主核心）。
const AVAILABLE_SERVICES = new Set(['slots', 'locale', 'commands', 'systemPrompt'])
// remote.* 不在这里 —— 它们是 ctx.remote 的命名空间，不是 inject 服务名。

let exportBag = {}
const localeRegistry = {}
const registrations = []
const injections = []
const errors = []

globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      exportBag = definition.factory((name) => {
        if (name === 'react') {
          return {
            createElement: () => null,
            Fragment: 'Fragment',
            useState: (v) => [v, () => {}],
            useEffect: () => {},
            useCallback: (fn) => fn,
            useMemo: (fn) => fn(),
            useRef: (v) => ({ current: v }),
            useReducer: (r, i) => [i, () => {}],
          }
        }
        if (name === 'react/jsx-runtime') {
          return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
        }
        throw new Error(`unexpected require: ${name}`)
      })
    },
  },
}

// eslint-disable-next-line no-eval
eval(source)

const declared = exportBag.inject ?? []
console.log('=== 模拟宿主激活 ===')
console.log(`产物声明的 inject: ${JSON.stringify(declared)}`)

const missing = declared.filter((s) => !AVAILABLE_SERVICES.has(s))
console.log(`宿主缺失的服务: ${missing.length === 0 ? '(无)' : JSON.stringify(missing)}`)

if (missing.length > 0) {
  console.log('')
  console.log('结论：apply 不会被调用（fiber 停在 pending）——这就是界面上什么都没有的原因。')
  process.exit(1)
}

// 服务齐全，宿主会调用 apply。
const ctx = {
  get: (id) => (AVAILABLE_SERVICES.has(id) ? {} : undefined),
  slots: {
    inject: (name, factory) => factory(),
    register: (spec, component) => {
      registrations.push({ spec, component })
      return () => {}
    },
  },
  configForms: {
    get: () => ({}),
    whileServed: (ns, register) => {
      register()
      return () => {}
    },
  },
  inject: (services, callback) => {
    injections.push(services)
    const scoped = {}
    if (services.includes('configForms')) scoped.configForms = ctx.configForms
    callback(scoped)
    return () => {}
  },
  locale: {
    getSnapshot: () => ({ revision: 1 }),
    subscribe: () => () => {},
    // 真实宿主有 register；槽位的 locale 标签靠它解析。
    register: (ns, dict) => {
      localeRegistry[ns] = dict
      return () => {}
    },
  },
  remote: { settings: {} },
  effect: (fn) => {
    fn()
    return () => {}
  },
  on: () => () => {},
}

try {
  exportBag.apply(ctx)
} catch (error) {
  errors.push(error)
}

console.log('')
console.log(`apply 已执行，注册槽位 ${registrations.length} 个`)
for (const r of registrations) console.log(`  ${JSON.stringify(r.spec)}`)
console.log(`ctx.inject 调用: ${JSON.stringify(injections)}`)

const ok = registrations.length === 1 && registrations[0].spec.name === 'plugins.bundle.config'
console.log('')
if (ok && errors.length === 0) {
  console.log('结论：按宿主规则可以正常激活并注册配置页。')
} else {
  console.log('结论：激活成功但注册不符合预期。')
  process.exitCode = 1
}
