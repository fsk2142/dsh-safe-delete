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

/**
 * 把路径里的本机用户名隐去。
 *
 * 命中的文件路径本身可能含真实用户名（例如 `C:\Users\<name>\...`），
 * 直接打印同样是一种泄露。保留结构、隐去具体名字。
 *
 * @param {string} p 路径。
 * @returns {string} 脱敏后的路径。
 */
function redactPath(p) {
  return p
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/i, 'C:\\Users\\<user>')
    .replace(/^\/home\/[^/]+/i, '/home/<user>')
    .replace(/^\/Users\/[^/]+/i, '/Users/<user>')
    .replace(/^\/mnt\/[a-z]\/Users\/[^/]+/i, '/mnt/<drive>/Users/<user>')
}

/**
 * 每个文件的内容只读一次（2026-10-30 复审 SD-P3）。
 *
 * ## 为什么（实测）
 *
 * 第一版把 `readFileSync` 与 `readStaged` 放在**每条规则的循环里**，
 * 于是 N 个文件 × 6 条规则 = 6N 次 `git show` 子进程 + 6 次工作区读取。
 *
 * 隔离基准（60 文件 × 6 规则）：约 360 次 `git show`、805 ms；
 * 每文件读一次约 60 次、135 ms。文件的读取次数与规则数完全无关，
 * 重复读纯属浪费 —— 而且在 Windows 上每次子进程还有进程创建开销。
 *
 * 缓存以**文件**为键，值是它的各个版本。
 *
 * @type {Map<string, Array<[string, string]>>}
 */
const contentCache = new Map()

/**
 * 取某文件的所有版本内容（工作区 + 暂存区），带缓存。
 *
 * @param {string} file 仓库相对路径。
 * @returns {Array<[string, string]>} `[版本标签, 内容]` 列表。
 */
function versionsOf(file) {
  const cached = contentCache.get(file)
  if (cached !== undefined) return cached

  /** @type {Array<[string, string]>} */
  const versions = []
  try {
    versions.push(['working tree', readFileSync(file, 'utf8')])
  } catch {
    /* 工作区读不到（已删除等），只看暂存区 */
  }
  const staged = readStaged(file)
  if (staged !== null) versions.push(['staged', staged])

  contentCache.set(file, versions)
  return versions
}

let findings = 0

for (const check of checks) {
  const hits = []

  // 路径层面的检查（如 .superpowers/）
  if (check.checkPaths === true) {
    for (const file of files) {
      if (check.pattern.test(file)) hits.push({ file, line: 0, text: file })
    }
  }

  // 内容层面的检查：**工作区与暂存区都要过**，且每个文件只读一次。
  for (const file of files) {
    if (binary.test(file)) continue
    if (SCANNERS.has(file)) continue
    if (check.ignoreFiles?.includes(file) === true) continue

    for (const [label, text] of versionsOf(file)) {
      if (!check.pattern.test(text)) continue
      const line = text.split('\n').findIndex((l) => check.pattern.test(l)) + 1
      hits.push({ file: `${file} (${label})`, line })
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
    /*
     * **只报位置，不报原文**（2026-10-30 复审 SD-P2）。
     *
     * 第一版打印 `hit.text`（命中行的前 200 字符）。那等于把正在拦截的
     * 敏感内容**再写一遍**到终端、CI 日志、录屏和会话上下文里 ——
     * 门禁本身成了泄露渠道。
     *
     * 现在只给出：规则、文件相对路径、工作区/暂存区、行号。
     * 知道"哪儿、什么类型"足够去修，不需要看到值。
     */
    console.log(`       ${redactPath(hit.file)}:${hit.line}  [命中已隐去]`)
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
