/**
 * 文档与实现一致性检查。
 *
 * 为什么值得单独做：文档写着"默认 5000 条目"，代码里其实是 500，这类偏差
 * 不会让测试变红，却会让人按错误预期配置插件。
 */
import { readFileSync } from 'node:fs'

const readme = readFileSync('README.md', 'utf8')
const indexSrc = readFileSync('src/index.ts', 'utf8')
const configSrc = readFileSync('src/config.ts', 'utf8')
const toolsSrc = readFileSync('src/tools.ts', 'utf8')
const cliSrc = readFileSync('bin/dsh-safe-delete.mjs', 'utf8')

const mismatches = []

/** 从 README 的配置表里取默认值。 */
function docDefault(key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('\\|\\s*`' + escaped + '`\\s*\\|\\s*([^|]+?)\\s*\\|')
  const m = re.exec(readme)
  return m === null ? null : m[1].trim()
}

/** 从实现里取默认值。 */
function codeDefault(key) {
  const patterns = [
    // schema 里的默认值：`key: z.number().default(N)`
    new RegExp('^\\s*' + key + ':\\s*z\\.[^\\n]*\\.default\\(([0-9*\\s.]+)\\)', 'm'),
    // 解包读取：`numeric('key', N)` / `booleanOf('key', N)`
    new RegExp("(?:numeric|booleanOf)\\('" + key + "',\\s*([0-9*\\strafle]+)\\)"),
    // 裸读（旧写法）
    new RegExp('config\\.' + key + '\\s*\\?\\?\\s*([0-9*\\s.]+)', 'm'),
  ]
  for (const source of [configSrc, indexSrc]) {
    for (const pattern of patterns) {
      const m = pattern.exec(source)
      if (m !== null) return m[1].trim()
    }
  }
  return null
}

const documentedKeys = [
  // 容量相关的三个字段（maxBytes / pruneAtPercent / autoPruneIntervalMs）
  // 已从产品移除，不再要求文档列出。
  'retentionDays',
  'confirmFileCount',
  'confirmBytes',
]

console.log('=== README 配置表 vs 实现默认值 ===')
for (const key of documentedKeys) {
  const doc = docDefault(key)
  const code = codeDefault(key)
  console.log(`${doc !== null ? 'ok  ' : 'CHECK'}  ${key.padEnd(20)} 文档=${doc ?? '(未列出)'}  代码=${code ?? '(未找到)'}`)
  if (doc === null) mismatches.push(`${key}: 文档未列出`)
  if (code === null) mismatches.push(`${key}: 实现里找不到默认值`)
}

// schema 里声明了 volatile 的字段，必须都能在 README 表里找到 ——
// 否则用户在界面上看到一个参数，却不知道它是什么。
console.log('\n=== schema 的 volatile 字段是否都在 README 里 ===')
const volatileKeys = [...configSrc.matchAll(/^\s+(\w+):\s*z\.[^\n]*\.volatile\(\)/gm)].map((m) => m[1])
for (const key of volatileKeys) {
  const documented = docDefault(key) !== null
  console.log(`${documented ? 'ok  ' : 'MISSING'}  ${key}`)
  if (!documented) mismatches.push(`volatile 字段 ${key}: README 未列出`)
}

console.log('\n=== README 提到的工具是否都存在 ===')
const uniqueTools = [...new Set([...readme.matchAll(/`(safe_[a-z_]+)`/g)].map((m) => m[1]))]
for (const name of uniqueTools) {
  const exists = toolsSrc.includes(`name: '${name}'`)
  console.log(`${exists ? 'ok  ' : 'MISSING'}  ${name}`)
  if (!exists) mismatches.push(`${name}: README 提到但不存在`)
}

console.log('\n=== README 的 CLI 命令是否都存在 ===')
for (const cmd of ['delete', 'list', 'undo', 'prune', 'status', 'check', 'journal']) {
  const exists = cliSrc.includes(`case '${cmd}'`)
  console.log(`${exists ? 'ok  ' : 'MISSING'}  ${cmd}`)
  if (!exists) mismatches.push(`cli:${cmd}: README 提到但不存在`)
}

// 斜杠命令的子命令必须都能在 commands.ts 里处理到。
console.log('\n=== 斜杠命令的子命令是否都已实现 ===')
const commandsSrc = readFileSync('src/commands.ts', 'utf8')
for (const sub of ['list', 'restore', 'clean', 'config', 'status']) {
  const exists = commandsSrc.includes(`verb === '${sub}'`) || commandsSrc.includes(`'${sub}'`)
  console.log(`${exists ? 'ok  ' : 'MISSING'}  ${sub}`)
  if (!exists) mismatches.push(`slash:${sub}: 未实现`)
}

console.log('')
if (mismatches.length === 0) {
  console.log('文档与实现一致。')
} else {
  console.log(`${mismatches.length} 处不一致：`)
  for (const m of mismatches) console.log(`  - ${m}`)
  process.exitCode = 1
}
