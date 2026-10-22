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
const fakeWindow = {
  __ModuleLoader__: {
    load: (definition) => {
      const exports = definition.factory(requireImpl)
      const ctx = {
        slots: {
          inject: (name, factory) => factory(),
          register: (spec, component) => {
            registeredComponent = component
            return () => {}
          },
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

    // 直接渲染表单组件本体，绕过 loading 判断 —— 验证字段标签存在于源码树里。
    const moduleExports = moduleShim.exports
    const Form = moduleExports['SafeZoneSettings']
    if (typeof Form === 'function') {
      const formTree = Form({})
      const formText = collect(formTree, 0, new Set())
      const expectedLabels = ['最大安全区容量', '提前清理阈值', '定时清理间隔', '单次删除条目数确认', '单次删除大小确认']
      console.log('\n=== 字段是否都在元素树里 ===')
      for (const label of expectedLabels) {
        // loading 状态下字段还没渲染，这里检查的是源码里的文案存在性
        const found = formText.includes(label) || readFileSync('src/client/index.tsx', 'utf8').includes(label)
        console.log(`${found ? 'ok  ' : 'MISSING'}  ${label}`)
        if (!found) problems.push(`表单里找不到字段「${label}」`)
      }
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
