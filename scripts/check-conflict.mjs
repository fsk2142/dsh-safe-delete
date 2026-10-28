#!/usr/bin/env node
/**
 * 检查本插件与 profile 里其他插件是否冲突。
 *
 * ## 为什么需要
 *
 * 本插件挂了一个**全局钩子**（`tools/pre-execute`），对每一次工具调用都执行。
 * 它和宿主内置的 `dsh-experimental-auto-review` 挂同一个事件 —— 这类组合出问题
 * 时表现为"DSH 崩溃或工具莫名被拒"，而单元测试完全看不到。
 *
 * 这个脚本查四类冲突，都是**只读**的：
 *
 * 1. **工具名**：我的 6 个工具名是否被别的插件也注册（重名会让宿主拒绝或覆盖）
 * 2. **钩子共存**：还有谁挂 `tools/pre-execute`，语义是否互相削弱
 * 3. **斜杠命令**：`/safe-delete` 是否被占用
 * 4. **配置兼容**：profile 里的旧字段会不会让 schema 解析失败
 *
 * ## 用法
 *
 *   pnpm check:conflict
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 我的工具名。 */
const MY_TOOLS = [
  'safe_delete',
  'safe_zone_list',
  'safe_zone_restore',
  'safe_zone_status',
  'safe_zone_check',
  'safe_zone_journal',
]

/** 我的斜杠命令。 */
const MY_COMMAND = 'safe-delete'

/** 我的 profile 条目 id / 设置命名空间。 */
const MY_ID = 'dsh-safe-delete'

/** 读取 profile 根。 */
const dshHome = process.env['DSH_HOME'] !== undefined && process.env['DSH_HOME'] !== ''
  ? resolve(process.env['DSH_HOME'])
  : join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', 'desktop')
const nodeModules = join(profileDir, 'node_modules')

if (!existsSync(nodeModules)) {
  console.log(`跳过：找不到 ${nodeModules}`)
  process.exit(0)
}

/** 其他已安装插件（排除我自己）。 */
const others = readdirSync(nodeModules, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('dsh-') && e.name !== MY_ID)
  .map((e) => e.name)

/**
 * 递归收集某插件下的 js 文件。
 *
 * @param dir 插件目录。
 * @returns 文件路径列表。
 */
function jsFiles(dir) {
  const out = []
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue
        walk(p)
      } else if (e.isFile() && /\.(js|mjs|cjs)$/.test(e.name)) {
        out.push(p)
      }
    }
  }
  walk(dir)
  return out
}

/** 去注释后再匹配，避免把「注释里提到」当成真冲突。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const problems = []

// ── 1. 工具名 ──
console.log('=== 1. 工具名冲突 ===')
let toolClash = 0
for (const name of others) {
  const dir = join(nodeModules, name)
  const files = jsFiles(dir).filter((f) => statSync(f).size < 2_000_000)
  const hit = []
  for (const f of files) {
    let src
    try {
      src = stripComments(readFileSync(f, 'utf8'))
    } catch {
      continue
    }
    for (const t of MY_TOOLS) {
      if (src.includes(`'${t}'`) || src.includes(`"${t}"`)) {
        hit.push(t)
        break
      }
    }
  }
  if (hit.length > 0) {
    toolClash += 1
    console.log(`  ⚠ ${name} 里出现: ${[...new Set(hit)].join(', ')}`)
    problems.push(`${name} 注册了同名工具`)
  } else {
    console.log(`  ✓ ${name}`)
  }
}
if (toolClash === 0) console.log('  （无冲突）')

// ── 2. 钩子共存 ──
console.log('')
console.log('=== 2. tools/pre-execute 钩子共存 ===')

/**
 * 在宿主 asar 里找哪些内置包**真正注册**了这个钩子。
 *
 * ## 为什么不能只匹配字符串
 *
 * 粗筛会连调用方和类型定义一起算进来。实测 7 个包里只有 3 个是真注册方：
 *
 *   真注册：dsh-experimental-auto-review、dsh-tool-jobs、dsh-workspace-changes
 *   只提及：dsh-bash-local、dsh-tool-bash、dsh-tool-cordis、dsh-tools
 *           （后两者是调用方，`dsh-tools` 正是 `waterfall(..., 'tools/pre-execute', ...)` 那一侧）
 *
 * 所以判据用注册形态 `ctx.on('tools/pre-execute'`，而不是简单包含。
 *
 * @returns 包名列表；读不到 asar 时返回 null。
 */
function hostHookUsers() {
  const asar = join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
  if (!existsSync(asar)) return null
  let buf
  try {
    buf = readFileSync(asar)
  } catch {
    return null
  }
  const headerSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
  const base = 16 + headerSize
  const found = new Set()
  const REGISTER = /\.on\s*\(\s*["']tools\/pre-execute["']/
  const walk = (node, prefix) => {
    for (const [name, e] of Object.entries(node.files ?? {})) {
      const full = prefix === '' ? name : `${prefix}/${name}`
      if (e.files !== undefined) {
        walk(e, full)
        continue
      }
      if (e.offset === undefined) continue
      if (!full.endsWith('.js')) continue
      const size = Number(e.size)
      if (size > 3_000_000) continue
      const text = buf.subarray(base + Number(e.offset), base + Number(e.offset) + size).toString('utf8')
      if (!REGISTER.test(text)) continue
      const m = /node_modules\/@deepseek-ai\/([^/]+)\//.exec(full)
      if (m !== null) found.add(m[1])
    }
  }
  walk(header, '')
  return [...found]
}

const hookUsers = []
for (const name of others) {
  const files = jsFiles(join(nodeModules, name)).filter((f) => statSync(f).size < 2_000_000)
  let hit = false
  for (const f of files) {
    let src
    try {
      src = stripComments(readFileSync(f, 'utf8'))
    } catch {
      continue
    }
    if (src.includes('tools/pre-execute')) {
      hit = true
      break
    }
  }
  if (hit) hookUsers.push(name)
}

const builtinUsers = hostHookUsers()

if (hookUsers.length === 0 && (builtinUsers === null || builtinUsers.length === 0)) {
  console.log('  ✓ 只有本插件挂这个钩子')
} else {
  for (const u of [...new Set(hookUsers)]) {
    console.log(`  · ${u}（profile 插件）也挂 tools/pre-execute`)
  }
  if (builtinUsers === null) {
    console.log('  ? 读不到宿主 asar，无法检查内置插件 —— 这一项未验证')
  } else {
    for (const u of builtinUsers) {
      console.log(`  · ${u}（宿主内置）也挂 tools/pre-execute`)
    }
  }
  console.log('')
  console.log('  说明：cordis waterfall 里，钩子按注册顺序执行，')
  console.log('  返回非 next() 结果的那个会终止整条链。')
  console.log('  已核对 dsh-experimental-auto-review 的实现：它在 downstream')
  console.log('  不是 allow 时原样返回，不会覆盖本插件的 deny。')
  console.log('  → 共存安全，但这是**需要人工复核**的项（宿主升级后应重查）')
}

// ── 3. 斜杠命令 ──
console.log('')
console.log('=== 3. 斜杠命令冲突 ===')
let cmdClash = 0
for (const name of others) {
  const files = jsFiles(join(nodeModules, name)).filter((f) => statSync(f).size < 2_000_000)
  for (const f of files) {
    let src
    try {
      src = stripComments(readFileSync(f, 'utf8'))
    } catch {
      continue
    }
    if (src.includes(`'${MY_COMMAND}'`) || src.includes(`"${MY_COMMAND}"`)) {
      console.log(`  ⚠ ${name} 也注册了 /${MY_COMMAND}`)
      problems.push(`${name} 注册了同名斜杠命令`)
      cmdClash += 1
      break
    }
  }
}
if (cmdClash === 0) console.log(`  ✓ /${MY_COMMAND} 未被占用`)

// ── 4. 配置兼容 ──
console.log('')
console.log('=== 4. profile 配置与 schema 的兼容性 ===')
const patch = join(profileDir, 'cordis.patch.yml')
if (!existsSync(patch)) {
  console.log('  (无 patch 文件)')
} else {
  // 只看配置里的键名，不解析 YAML
  const text = readFileSync(patch, 'utf8')
  const start = text.indexOf(`- id: ${MY_ID}`)
  if (start < 0) {
    console.log(`  · patch 里没有 ${MY_ID} 条目`)
  } else {
    const seg = text.slice(start)
    const end = seg.indexOf('\n- id:', 1)
    const block = end < 0 ? seg : seg.slice(0, end)

    const configured = [...block.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1])
    const schemaFile = join(process.cwd(), 'src', 'config.ts')
    const schemaSrc = existsSync(schemaFile) ? readFileSync(schemaFile, 'utf8') : ''
    const schemaKeys = [...schemaSrc.matchAll(/^\s{2}(\w+):\s*z\./gm)].map((m) => m[1])

    console.log(`  配置里的键: ${configured.join(', ')}`)
    const unknown = configured.filter((k) => schemaKeys.length > 0 && !schemaKeys.includes(k))
    if (unknown.length === 0) {
      console.log('  ✓ 全部是有效字段')
    } else {
      console.log(`  ⚠ ${unknown.length} 个字段已从 schema 移除: ${unknown.join(', ')}`)
      console.log('    schemastery 对未知键宽容（不抛错、会保留），所以这不是崩溃风险，')
      console.log('    但它们是脏数据 —— 建议清理 profile 配置。')
    }
  }
}

console.log('')
if (problems.length === 0) {
  console.log('结论：没有发现硬冲突。')
} else {
  console.log(`发现 ${problems.length} 个硬冲突：`)
  for (const p of problems) console.log(`  - ${p}`)
  process.exitCode = 1
}
