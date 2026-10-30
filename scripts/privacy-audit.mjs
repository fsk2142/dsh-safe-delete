/**
 * 推送前隐私审计。
 *
 * 扫描**所有会被推送的文件内容**（不只是提交信息），逐项检查：
 * 个人信息、凭据、对话痕迹、本机路径、内部标识。
 *
 * 用法：node scripts/privacy-audit.mjs
 * 退出码：0 = 干净；1 = 发现需要处理的内容。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const checks = [
  {
    label: '本机用户名 / 绝对路径',
    // 匹配 `C:\Users\<某个词>\` 这种"看起来是真的用户名"的写法。
    // 占位符（`alice`、`<user>`、`%USERNAME%`、`$…`）不算 —— 源码注释里用它们
    // 举例是正常的。要在自己机器上跑得更严，可以把你的用户名加进下面的排除表，
    // 那样连"占位符恰好和你同名"的情况也不会漏。
    pattern: new RegExp(`C:\\\\+Users\\\\+(?!alice|<user>|%USERNAME%|\\$)[A-Za-z0-9._-]+\\\\`, 'i'),
    ignoreFiles: ['pnpm-lock.yaml'], // 该文件的 base64 完整性哈希可能偶然含子串
    severity: 'high',
  },
  {
    label: '凭据 / 密钥 / Token',
    pattern: /sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_|Bearer\s+[A-Za-z0-9._-]{20,}|api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9]{16,}/i,
    severity: 'critical',
  },
  {
    label: '邮箱 / 真实姓名',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    severity: 'high',
  },
  {
    label: '对话痕迹（用户原话）',
    pattern: /用户原话|用户说[：:]|你说[：:]|报障[：:]|经用户确认|用户已同意|用户明确指出|用户报障/,
    severity: 'high',
  },
  {
    label: '会话 / 内部标识',
    pattern: /session-[0-9a-f]{8}-[0-9a-f]{4}|dsh-spill|Temp\\dsh-|--C-Users-/,
    severity: 'medium',
  },
  {
    label: 'AI 工作日志被跟踪',
    // 只看**被跟踪的路径**，不看 .gitignore 里的规则（规则本身是防泄露的）。
    pattern: /^\.superpowers\//,
    checkPaths: true,
    severity: 'high',
  },
]

const binary = /\.(png|jpg|jpeg|webp|gif|ico|woff2?|ttf|zip|gz)$/i

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((line) => line !== '')

console.log(`审计范围：${files.length} 个被跟踪文件\n`)

/**
 * 读**暂存区**里该文件的内容。
 *
 * ## 为什么必须扫暂存区（2026-10-30 复审 SD-04）
 *
 * 第一版只 `readFileSync(file)` —— 读的是**工作区**。而 `git commit` 提交的是
 * **暂存区**。两者可以不同：
 *
 * ```
 * git add config.txt          # 暂存区里是带 token 的版本
 * # 再把工作区改成干净的
 * git commit                  # 推送的是暂存区那份！
 * ```
 *
 * 已隔离复现：暂存区含 `ghp_…`、工作区是 `REDACTED`，第一版审计**放行**。
 *
 * 现在两个版本都扫，任一有命中就失败。
 *
 * @param file 仓库相对路径。
 * @returns 暂存区内容；文件未暂存或读取失败时 null。
 */
function readStaged(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/**
 * 本身内嵌检测模式的脚本：它们的"命中"是规则，不是泄露，必须跳过。
 */
const SCANNERS = new Set(['scripts/privacy-audit.mjs', 'scripts/verify-remote.mjs'])

let findings = 0

for (const check of checks) {
  const hits = []

  // 路径层面的检查（如 .superpowers/）
  if (check.checkPaths === true) {
    for (const file of files) {
      if (check.pattern.test(file)) hits.push({ file, line: 0, text: file })
    }
  }

  // 内容层面的检查：**工作区与暂存区都要过**。
  for (const file of files) {
    if (binary.test(file)) continue
    if (SCANNERS.has(file)) continue
    if (check.ignoreFiles?.includes(file) === true) continue

    /** @type {Array<[string, string]>} */
    const versions = []
    try {
      versions.push(['working tree', readFileSync(file, 'utf8')])
    } catch {
      /* 工作区读不到（已删除等），只看暂存区 */
    }
    const staged = readStaged(file)
    if (staged !== null) versions.push(['staged', staged])

    for (const [label, text] of versions) {
      if (!check.pattern.test(text)) continue
      const line = text.split('\n').findIndex((l) => check.pattern.test(l)) + 1
      hits.push({ file: `${file} (${label})`, line, text: text.slice(0, 200) })
      break
    }
  }

  if (hits.length === 0) {
    console.log(`[ok]   ${check.label}`)
    continue
  }

  findings += hits.length
  console.log(`[${check.severity.toUpperCase()}] ${check.label} — ${hits.length} 处`)
  for (const hit of hits.slice(0, 6)) {
    console.log(`       ${hit.file}:${hit.line}  ${hit.text}`)
  }
  if (hits.length > 6) console.log(`       … 另有 ${hits.length - 6} 处`)
}

console.log('')
if (findings === 0) {
  console.log('审计通过：没有发现需要处理的内容。')
  process.exitCode = 0
} else {
  console.log(`审计未通过：共 ${findings} 处。处理后再推送。`)
  process.exitCode = 1
}
