/**
 * 客户端「静默失败」模式审计。
 *
 * 这几轮踩到的所有坑都属于同一类：代码看起来对、测试全绿、界面上却什么都没有。
 * 这份脚本把所有已知的静默失败模式逐条检查一遍，避免只修眼前这一处。
 */
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const source = readFileSync('src/client/index.tsx', 'utf8')
const bundle = readFileSync('lib/client.js', 'utf8')

const problems = []
const ok = (label, extra = '') => console.log(`  ok    ${label}${extra === '' ? '' : ` — ${extra}`}`)
const bad = (label, why) => {
  problems.push(label)
  console.log(`  FAIL  ${label} — ${why}`)
}

console.log('=== 1. 宿主能否找到客户端产物 ===')
const clientExport = pkg.exports?.['./client']
if (clientExport === undefined) bad('exports["./client"]', '缺失 → 宿主不会加载 client.js')
else ok('exports["./client"]', clientExport)

if ((pkg.dsh?.client?.platform ?? '') !== 'web') bad('dsh.client.platform', '不是 web')
else ok('dsh.client.platform', 'web')

if (!(pkg.files ?? []).some((f) => f === 'lib/' || f === 'lib/client.js')) bad('files 含 client', '发布时会漏掉')
else ok('files 含 client')

console.log('\n=== 2. 顶层 inject 是否只含必定提供的服务 ===')
const injectMatch = /export const inject = \[([^\]]*)\]/.exec(source)
const declared = injectMatch === null ? [] : injectMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
console.log(`  声明: ${declared.join(', ')}`)
// 顶层 inject 缺服务的代价是整个插件停在 pending，所以只允许这两个。
const SAFE_TOP = ['slots', 'locale']
const risky = declared.filter((s) => !SAFE_TOP.includes(s))
if (risky.length > 0) bad('顶层 inject 含风险项', `${risky.join(', ')} 缺失会让整个插件不激活`)
else ok('顶层 inject 最小化')

console.log('\n=== 3. 是否直接访问未经 inject 的服务 ===')
// 排除注释行后，看代码里有没有 ctx.<service> 的直接访问
const codeLines = source.split('\n').filter((line) => {
  const t = line.trim()
  return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
})
const directAccess = []
for (const line of codeLines) {
  for (const m of line.matchAll(/ctx\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    const name = m[1]
    if (['get', 'inject', 'effect', 'slots', 'locale'].includes(name)) continue
    directAccess.push(`${name} (${line.trim().slice(0, 60)})`)
  }
}
if (directAccess.length > 0) bad('直接访问未声明服务', directAccess.join('; '))
else ok('无未声明的直接访问')

console.log('\n=== 4. remote 是否成对请求 ===')
// 源码里是 `maybeInject(['remote', 'remote.settings'], …)`，也接受 `ctx.inject?.([…])`。
const remoteCall = /inject\??\.\(\[([^\]]*)\]/.exec(source)
const requested = remoteCall === null ? [] : remoteCall[1].split(',').map((s) => s.trim().replace(/['"]/g, ''))
const wantsRemote = /'remote'/.test(source)
const wantsSettings = /'remote\.settings'/.test(source)
if (wantsSettings && !wantsRemote) {
  bad('remote 未成对请求', 'ctx.remote.settings 是两步求值，只声明后者会在第一步抛错')
} else if (wantsSettings && wantsRemote) {
  ok('remote + remote.settings 成对请求')
} else {
  ok('未使用 remote（无需请求）')
}
console.log(`  首次 inject 请求: ${requested.length === 0 ? '(无)' : requested.join(', ')}`)

console.log('\n=== 5. 槽位名与 key ===')
if (!source.includes("'plugins.bundle.config'")) bad('槽位名', '应为 plugins.bundle.config（bundle 级配置页）')
else ok('槽位名 plugins.bundle.config')
if (!/key: NAMESPACE/.test(source) && !source.includes('key: NAMESPACE')) bad('槽位 key', '应为包名')
else ok('槽位 key = 包名')

console.log('\n=== 6. locale 字典是否注册 ===')
if (!source.includes('locale.register') && !source.includes('register?.(NAMESPACE')) bad('locale 字典', '未注册 → 槽位标签解析不出来')
else ok('locale 字典已注册')

console.log('\n=== 7. 渲染路径是否碰 ctx ===')
const componentStart = source.indexOf('export function SafeZoneSettings')
const componentEnd = source.indexOf('/** 客户端插件入口', componentStart)
const componentRaw = componentStart >= 0 ? source.slice(componentStart, componentEnd > 0 ? componentEnd : undefined) : ''
// 只看代码行：注释里提到 ctx 是说明，不是访问。
const componentCode = componentRaw
  .split('\n')
  .filter((line) => {
    const t = line.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })
  .join('\n')
if (/ctx\./.test(componentCode)) bad('组件内访问 ctx', '渲染期访问服务会被守卫拦下，整棵子树被错误边界丢掉')
else ok('组件内不访问 ctx（只读模块变量）')

console.log('\n=== 8. 产物与源码一致 ===')
if (!bundle.includes('plugins.bundle.config')) bad('产物缺槽位注册', '需要 pnpm build')
else ok('产物含槽位注册')

console.log('')
if (problems.length === 0) {
  console.log('全部静默失败模式检查通过。')
} else {
  console.log(`发现 ${problems.length} 项：${problems.join('; ')}`)
  process.exitCode = 1
}
