/**
 * 文档与实现一致性检查。
 *
 * 为什么值得单独做：文档写着"默认 5000 条目"，代码里其实是 500，这类偏差
 * 不会让测试变红，却会让人按错误预期配置插件。
 *
 * ## 为什么读 docs/REFERENCE.md 而不是 README.md（2026-11-08）
 *
 * DSH 的插件页把整篇 `README.md` 渲染进界面。README 因此必须是**操作说明**，
 * 不能塞参数表和配置全表 —— 那些在 `docs/REFERENCE.md`。
 *
 * 但这个检查的目的不变：**参数与默认值必须有一份会和实现一起改的文档**。
 * 所以它跟着搬家，而不是被删掉。
 */
import { readFileSync } from 'node:fs'

const readme = readFileSync('docs/REFERENCE.md', 'utf8')
const indexSrc = readFileSync('src/index.ts', 'utf8')
const configSrc = readFileSync('src/config.ts', 'utf8')
const toolsSrc = readFileSync('src/tools.ts', 'utf8')
const cliSrc = readFileSync('bin/dsh-safe-delete.mjs', 'utf8')

const mismatches = []

/** 从 REFERENCE 的配置表里取默认值。 */
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

/**
 * 去掉 Markdown/引号装饰。
 *
 * @param {string} text 原始文本。
 * @returns 规范化后的文本。
 */
function normalizeText(text) {
  return text
    .replace(/[`'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把"默认值"尽力求值成数字。
 *
 * 两侧的形态不同：文档里是 `` `5000` ``，代码里可能是
 * `2 * 1024 * 1024 * 1024` 这样的**表达式**。粗略字符串比较会假失败，
 * 所以先求值。
 *
 * 只接受由数字、空白和 `* + - / ( )` 组成的表达式 —— 不 eval 任意代码。
 *
 * @param {string | null} text 原文。
 * @returns 数字；求不出来时 null。
 */
function toNumber(text) {
  if (text === null) return null
  const cleaned = normalizeText(text)
  if (cleaned === '') return null
  // 只允许数字与算术符号，其余一律不求值。
  if (!/^[0-9\s*+\-/().]+$/.test(cleaned)) return null
  try {
    // 上面已限制字符集，这里不存在注入面。
    const value = Function(`"use strict"; return (${cleaned})`)()
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

const documentedKeys = [
  // 容量相关的三个字段（maxBytes / pruneAtPercent / autoPruneIntervalMs）
  // 已从产品移除，不再要求文档列出。
  'retentionDays',
  'confirmFileCount',
  'confirmBytes',
]

console.log('=== REFERENCE 配置表 vs 实现默认值 ===')
for (const key of documentedKeys) {
  const rawDoc = docDefault(key)
  const rawCode = codeDefault(key)
  /*
   * ## 必须比较**数值**，不能只看"是否存在"（2026-11-01 审查 SD-20）
   *
   * 第一版只在 `doc === null` 时记不匹配 —— 于是文档写 99、代码是 1，
   * 打印出 `文档=99 代码=1` 却仍然算 `ok` 并报告"文档与实现一致"。
   *
   * 一个只检查"有没有这个字段"的校验，对"字段值对不对"完全无感。
   *
   * ## 两边都要规范化再比
   *
   * 文档侧取到的是 Markdown 表格单元格（可能带反引号、空格），
   * 代码侧可能是 `2 * 1024 * 1024 * 1024` 这样的**表达式**。
   * 粗略字符串比较会把它们判成不同 —— 那是假失败。
   *
   * 这里把两边都求值成数字再比；求不出来就退回字符串比较。
   */
  const docNum = toNumber(rawDoc)
  const codeNum = toNumber(rawCode)
  const same =
    docNum !== null && codeNum !== null
      ? docNum === codeNum
      : rawDoc !== null && rawCode !== null && normalizeText(rawDoc) === normalizeText(rawCode)

  console.log(
    `${same ? 'ok  ' : 'CHECK'}  ${key.padEnd(20)} 文档=${rawDoc ?? '(未列出)'}  代码=${rawCode ?? '(未找到)'}`,
  )
  if (rawDoc === null) mismatches.push(`${key}: 文档未列出`)
  else if (rawCode === null) mismatches.push(`${key}: 实现里找不到默认值`)
  else if (!same) mismatches.push(`${key}: 文档写 ${rawDoc}，实现是 ${rawCode}`)
}

// schema 里声明了 volatile 的字段，必须都能在 REFERENCE 表里找到 ——
// 否则用户在界面上看到一个参数，却不知道它是什么。
console.log('\n=== schema 的 volatile 字段是否都在 REFERENCE 里 ===')
const volatileKeys = [...configSrc.matchAll(/^\s+(\w+):\s*z\.[^\n]*\.volatile\(\)/gm)].map((m) => m[1])
for (const key of volatileKeys) {
  const documented = docDefault(key) !== null
  console.log(`${documented ? 'ok  ' : 'MISSING'}  ${key}`)
  if (!documented) mismatches.push(`volatile 字段 ${key}: REFERENCE 未列出`)
}

console.log('\n=== REFERENCE 提到的工具是否都存在 ===')
const uniqueTools = [...new Set([...readme.matchAll(/`(safe_[a-z_]+)`/g)].map((m) => m[1]))]
for (const name of uniqueTools) {
  const exists = toolsSrc.includes(`name: '${name}'`)
  console.log(`${exists ? 'ok  ' : 'MISSING'}  ${name}`)
  if (!exists) mismatches.push(`${name}: REFERENCE 提到但不存在`)
}

console.log('\n=== REFERENCE 的 CLI 命令是否都存在 ===')
for (const cmd of ['delete', 'list', 'undo', 'prune', 'status', 'check', 'journal']) {
  const exists = cliSrc.includes(`case '${cmd}'`)
  console.log(`${exists ? 'ok  ' : 'MISSING'}  ${cmd}`)
  if (!exists) mismatches.push(`cli:${cmd}: REFERENCE 提到但不存在`)
}

// 斜杠命令的子命令必须都能在 commands.ts 里处理到。
console.log('\n=== 斜杠命令的子命令是否都已实现 ===')
const commandsSrc = readFileSync('src/commands.ts', 'utf8')
for (const sub of ['list', 'restore', 'clean', 'config', 'status']) {
  const exists = commandsSrc.includes(`verb === '${sub}'`) || commandsSrc.includes(`'${sub}'`)
  console.log(`${exists ? 'ok  ' : 'MISSING'}  ${sub}`)
  if (!exists) mismatches.push(`slash:${sub}: 未实现`)
}

/*
 * `safe_delete` 的参数：REFERENCE 那一行必须列出 schema 里的全部参数。
 *
 * 为什么值得单独查：v1.1.0 给 safe_delete 加了 root / match / olderThan /
 * exclude，REFERENCE 的「模型侧工具」表那一行**没跟着改**，仍然是旧的
 * 「path 或 paths，preview，reason」。使用者照着那行调用会漏掉新能力，
 * 而所有测试仍然全绿 —— 文档脱节是静默的。
 */
console.log('\n=== safe_delete 的参数是否都在 REFERENCE 里 ===')
{
  const idx = toolsSrc.indexOf("name: 'safe_delete'")
  const paramStart = idx < 0 ? -1 : toolsSrc.indexOf('parameters: {', idx)
  if (paramStart < 0) {
    mismatches.push('safe_delete: 找不到 parameters 定义')
    console.log('MISSING  safe_delete 的 parameters 定义')
  } else {
    // 括号配对，取出 parameters 块。
    let depth = 0
    let end = paramStart
    for (let i = paramStart + 'parameters: '.length; i < toolsSrc.length; i += 1) {
      const c = toolsSrc[i]
      if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const block = toolsSrc.slice(paramStart, end + 1)
    const schemaKeys = [...block.matchAll(/^\s{6}([A-Za-z_]\w*):/gm)].map((m) => m[1])
    const docLine = readme.split('\n').find((l) => l.includes('`safe_delete` | `'))
    if (docLine === undefined) {
      mismatches.push('safe_delete: REFERENCE 里没有参数说明那行')
      console.log('MISSING  REFERENCE 那行')
    } else {
      const docKeys = [...docLine.matchAll(/`([a-zA-Z_]\w*)`/g)].map((m) => m[1]).filter((k) => k !== 'safe_delete')
      for (const key of schemaKeys) {
        const documented = docKeys.includes(key)
        console.log(`${documented ? 'ok  ' : 'MISSING'}  ${key}`)
        if (!documented) mismatches.push(`safe_delete 参数 ${key}: REFERENCE 未列出`)
      }
    }
  }
}

console.log('')
if (mismatches.length === 0) {
  console.log('文档与实现一致。')
} else {
  console.log(`${mismatches.length} 处不一致：`)
  for (const m of mismatches) console.log(`  - ${m}`)
  process.exitCode = 1
}



