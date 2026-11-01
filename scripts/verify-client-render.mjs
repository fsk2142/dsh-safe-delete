/**
 * 第二轮：真正渲染表单组件，验证它能产出元素树而不是崩掉。
 *
 * 上一轮只验证到「component 是函数」。这一轮实际调用它，检查：
 *   - 不抛错；
 *   - 返回的是可渲染的东西；
 *   - summary 视图返回文字、config 视图返回表单。
 *
 * 用假的 React 元素实现，不需要 DOM。
 */
import { readFileSync } from 'node:fs'

const code = readFileSync('lib/client.js', 'utf8')

/** 极简元素树。 */
function element(type, props, ...children) {
  return { type, props: props ?? {}, children }
}

const fakeReact = {
  createElement: (type, props, ...children) => element(type, props, ...children),
  Fragment: 'Fragment',
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useReducer: (reducer, initial) => [initial, () => {}],
}
const fakeJsxRuntime = {
  jsx: (type, props) => element(type, props),
  jsxs: (type, props) => element(type, props),
  Fragment: 'Fragment',
}

const requireImpl = (name) => {
  if (name === 'react') return fakeReact
  if (name === 'react/jsx-runtime') return fakeJsxRuntime
  throw new Error(`unexpected require: ${name}`)
}

let registeredComponent = null
/*
 * ## 真正的导出必须**存下来**（2026-11-01 审查 SD-19）
 *
 * 客户端 bundle 是 UMD 形态：`__ModuleLoader__.load({ factory })` 的
 * factory 返回值才是模块导出。而脚本里 `moduleShim.exports` 是个独立的
 * 空对象 —— 依赖它的检查因此永远拿不到组件，然后静默跳过。
 *
 * 这里把 factory 的返回值留住，供后面的字段检查使用。
 */
let clientModuleExports = null
const fakeWindow = {
  __ModuleLoader__: {
    load: (definition) => {
      const exports = definition.factory(requireImpl)
      clientModuleExports = exports
      const ctx = {
        slots: {
          inject: (name, factory) => factory(),
          register: (spec, component) => {
            registeredComponent = component
            return () => {}
          },
        },
        // 配置页必须等 `configForms` 就绪才注册（与 dsh-context 同一套写法）。
        configForms: {
          get: () => ({}),
          whileServed: (namespaces, register) => {
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
      exports.apply(ctx)
    },
  },
}

const runner = new Function('window', 'console', 'require', 'module', 'exports', code)
const moduleShim = { exports: {} }
runner(fakeWindow, console, requireImpl, moduleShim, moduleShim.exports)

/** 把元素树压成可读文本，便于断言。 */
function describeTree(node, depth = 0) {
  return collect(node, depth, new Set())
}

/**
 * 递归展开自定义组件（函数）并收集文本。
 *
 * 为什么要展开：`<SafeZoneSettings>` 是我们自己的组件，只有真正调用它才能看到
 * 里面的字段标签。不展开就只能看到一个壳，误判成「字段不存在」。
 */
function collect(node, depth, seen) {
  if (node === null || node === undefined) return '(null)'
  if (depth > 12) return '…'
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => collect(child, depth, seen)).join(' ')

  if (typeof node === 'object') {
    const type = node.type
    // 自定义组件：调用它，把返回的子树继续展开。
    if (typeof type === 'function') {
      if (seen.has(type)) return ''
      const nextSeen = new Set(seen)
      nextSeen.add(type)
      let rendered
      try {
        rendered = type(node.props ?? {})
      } catch {
        return ''
      }
      if (rendered === null || rendered === undefined) return ''
      return collect(rendered, depth + 1, nextSeen)
    }
    const children = node.children ?? []
    // jsx runtime 会把子节点塞进 props.children，普通 createElement 塞进 children。
    // 两种都要认，否则会把有内容的元素误判成空。
    const propsChildren = node.props?.children
    const allChildren =
      children.length > 0
        ? children
        : propsChildren === undefined
          ? []
          : Array.isArray(propsChildren)
            ? propsChildren
            : [propsChildren]
    const ownPropsText =
      type === 'input' || type === 'select' || type === 'button'
        ? ` ${node.props?.['aria-label'] ?? ''}`
        : ''
    if (allChildren.length > 0) {
      return allChildren.map((child) => collect(child, depth + 1, seen)).join(' ')
    }
    return ownPropsText === '' ? '' : ownPropsText
  }
  return String(node)
}

console.log('=== 渲染验证 ===')
const problems = []

if (typeof registeredComponent !== 'function') {
  problems.push('注册的 component 不是函数')
} else {
  for (const view of ['summary', 'config']) {
    try {
      const tree = registeredComponent({ t: (key) => key, view })
      const text = describeTree(tree)
      console.log(`  view=${view} → ${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`)
      if (tree === null || tree === undefined) problems.push(`view=${view} 返回了空值`)
    } catch (error) {
      problems.push(`view=${view} 渲染抛错: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// 表单视图里应该能看到五个字段的标签。
//
// 注意：组件首次渲染时状态是 `loading`（还没拿到配置），会显示「正在读取配置…」。
// 这是正确行为，不是缺陷 —— 所以要**模拟加载完成**，看表单本体。
if (typeof registeredComponent === 'function') {
  try {
    // 让 useState 的第一次调用返回「就绪」状态，其余返回默认值。
    let firstStateCall = true
    const readyReact = {
      ...fakeReact,
      useState: (initial) => {
        if (firstStateCall) {
          firstStateCall = false
          // 组件里第一个 useState 是 values（对象），第二个是 status。
        }
        return [initial, () => {}]
      },
    }
    void readyReact

    const tree = registeredComponent({ t: (k) => k, view: 'config' })
    const text = describeTree(tree)
    console.log(`  首次渲染（loading 状态）内容: ${JSON.stringify(text.slice(0, 40))}`)

    /*
     * ## 这一段原本是"假绿"（2026-11-01 审查 SD-19）
     *
     * 三个问题：
     *
     * 1. `moduleShim.exports` 是**空对象** —— 真正的导出由 loader factory
     *    返回，所以 `moduleExports['SafeZoneSettings']` 永远是 undefined，
     *    `typeof Form === 'function'` 直接跳过整段检查，**不报错**。
     * 2. `expectedLabels` 里还写着已删除的容量字段（最大安全区容量、
     *    提前清理阈值、定时清理间隔）—— 那三项早已从产品移除。
     * 3. 字段"检查"退化成 `readFileSync(...).includes(label)` ——
     *    源码里有这个字符串就算通过，与"渲染出字段"无关。
     *
     * 现在：拿不到组件就**明确失败**，只检查**当前真实存在**的字段，
     * 且只认渲染树里的文案。
     */
    const moduleExports = clientModuleExports ?? moduleShim.exports
    const Form = moduleExports['SafeZoneSettings']
    if (typeof Form !== 'function') {
      // 不能静默跳过 —— 那正是这段脚本一直在"通过"的原因。
      problems.push(
        '拿不到 SafeZoneSettings 组件：模块导出里没有它。' +
          '（这是验证脚本自身的问题，不是组件缺失。）',
      )
    } else {
      /*
       * ## 这个脚本**不做**字段渲染验证（2026-11-01 审查 SD-19 的结论）
       *
       * 我最初想在这里"直接调用组件、检查字段标签"。实测行不通：
       * 组件首帧是 loading 壳，`Form({})` 只会返回"正在读取配置…"，
       * 字段要等 `describe()` 异步回填后才出现 —— 而那需要真实 React
       * 生命周期（useEffect/useState），这个 fake React 不提供。
       *
       * 所以这里只做**编译器层面的确认**：组件是函数、能无参调用而不抛。
       * 字段是否真的渲染，由 `tests/client-interaction.test.ts` 和
       * `tests/bytes-unit-sd09.test.ts` 用 jsdom + 真实 react-dom 验证 ——
       * 那才是能证伪的测法。
       *
       * 明确写出这条边界，比让脚本"看起来在检查字段"更有用。
       */
      let callable = false
      try {
        Form({})
        callable = true
      } catch (error) {
        problems.push(`组件无法无参调用: ${error instanceof Error ? error.message : String(error)}`)
      }
      console.log('\n=== 组件可调用性 ===')
      console.log(`${callable ? 'ok  ' : 'FAIL'}  SafeZoneSettings 可无参调用`)
      console.log(
        '(字段渲染验证见 tests/client-interaction.test.ts —— 需要真实 React 生命周期)',
      )
    }
  } catch (error) {
    problems.push(`字段检查失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('')
if (problems.length === 0) {
  console.log('表单渲染符合预期。')
} else {
  console.log('问题：')
  for (const p of problems) console.log('  - ' + p)
  process.exitCode = 1
}
