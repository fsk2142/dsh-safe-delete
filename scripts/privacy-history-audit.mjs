/**
 * 历史隐私扫描：只回答「**过去的提交里**有没有敏感内容」。
 *
 * ## 与 `privacy-audit.mjs` 的分工（2026-11-05 第二轮复审 R04）
 *
 * `privacy-audit.mjs` 扫的是**工作区 + 暂存区**——它回答"这次提交会不会带进
 * 新的泄露"。它**看不到**历史：
 *
 * - 曾经提交过、后来删掉的值；
 * - 不可达对象（amend / rebase 之后的旧 commit）；
 * - 二进制产物里藏着的字符串（`privacy-audit` 明确跳过二进制扩展名）。
 *
 * 把这两件事混成一个"审计通过"是本项目反复出现的失败形态：
 * **断言的范围比读者以为的范围大**。所以这里单独一个脚本、单独的退出码，
 * 输出里明确写清扫了什么、没扫什么。
 *
 * ## 它**不**替代 gitleaks / trufflehog
 *
 * 这里只有几条正则，命中率远低于专用工具；它的价值是**零依赖**、能进 gate、
 * 且在仓库很小的阶段就跑起来。发布前的正式检查仍应跑专用工具。
 *
 * ## 用法
 *
 * ```
 * node scripts/privacy-history-audit.mjs            # 扫全部可达 refs
 * node scripts/privacy-history-audit.mjs --staged   # 只扫 staged 的历史（不常用）
 * ```
 *
 * 退出码：0 = 无命中，1 = 有命中，2 = 环境不可用（例如 git 不可用）。
 * **不可用要报 2，不能报 0** —— 否则"跑不了"会被读成"很干净"。
 */
import { execFileSync } from 'node:child_process'

/**
 * 已知的**规则载体**：这些文件里出现的命中是"检测规则本身"，不是泄露。
 *
 * ## 为什么必须单列（2026-11-05 第二轮复审 R04）
 *
 * 历史扫描只读 diff 的**新增行**，它不知道某一行现在是不是"规则定义"。于是：
 *
 * - `scripts/privacy-audit.mjs` 里 `pattern: /用户原话|用户说[：:]…/` 这行
 *   本身会被"对话痕迹"规则命中；
 * - `scripts/verify-remote.mjs` 里 `session-[0-9a-f]{8}` 会被"会话标识"命中；
 * - 测试里刻意构造的 `C:\Users\some-real-person\secret.txt` 会被"本机路径"命中。
 *
 * 这些是**规则与夹具**，不是数据。跳过它们而不是放宽正则是正确的取舍：
 * 放宽正则会真的漏掉泄露，跳过一个已知的文件名单不会。
 *
 * 名字写死是刻意的 —— 这个名单应当短、且每次新增都要有人看一眼。
 */
const RULE_CARRIERS = new Set([
  'scripts/privacy-audit.mjs',
  'scripts/privacy-history-audit.mjs',
  'scripts/verify-remote.mjs',
])

/** 测试文件：里面的"命中"是夹具（刻意构造的假用户名、假 token）。 */
function isFixturePath(file) {
  return /(^|\/)tests\//.test(file) || /\.test\.(?:ts|mts|js|mjs)$/.test(file)
}

/**
 * 规则表。与 `privacy-audit.mjs` 保持同一套，但**只保留高置信度**的规则：
 * 历史扫描的误报无法靠"改一下再提交"消除，只能改写历史，代价高得多。
 */
const rules = [
  {
    label: '本机用户名 / 绝对路径',
    // 排除占位符。
    pattern: new RegExp(`C:\\\\+Users\\\\+(?!alice|<user>|%USERNAME%|\\$)[A-Za-z0-9._-]+\\\\`, 'i'),
    severity: 'high',
  },
  {
    label: '凭据 / 密钥 / Token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
    severity: 'high',
  },
  {
    label: '邮箱 / 真实姓名',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    severity: 'medium',
  },
  {
    label: '对话痕迹（用户原话）',
    pattern: /用户原话|用户说[：:]|你说[：:]|报障[：:]|经用户确认|用户已同意|用户明确指出|用户报障/,
    severity: 'medium',
  },
  {
    label: '会话 / 内部标识',
    pattern: /session-[0-9a-f]{8}-[0-9a-f]{4}|dsh-spill|Temp\\dsh-|--C-Users-/,
    severity: 'medium',
  },
]

/**
 * 跑一条 git 命令并返回 stdout。
 *
 * @param {string[]} args 参数。
 * @returns {string} 输出。
 */
function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * 把一条提交信息里的路径/文本中的用户名隐去。
 *
 * 命中文件路径本身可能含真实用户名 —— 直接打印同样是一种泄露
 * （这与 `privacy-audit.mjs` 里的 `redactPath` 是同一个理由）。
 *
 * @param {string} text 原文。
 * @returns {string} 脱敏后的文本。
 */
function redact(text) {
  return text
    .replace(/C:\\+Users\\+[^\\]+/gi, 'C:\\Users\\<user>')
    .replace(/\/home\/[^/\s]+/g, '/home/<user>')
    .replace(/\/Users\/[^/\s]+/g, '/Users/<user>')
}

/**
 * 列出仓库里所有可达的提交。
 *
 * `--all` 覆盖所有 refs（分支、tag、远端跟踪）；它**不**覆盖 reflog 与
 * 不可达对象 —— 那是另一件事，需要 `git fsck --lost-found`，这里不做。
 *
 * @returns {string[]} 提交 SHA 列表。
 */
function allCommits() {
  const out = git(['rev-list', '--all'])
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

/**
 * 扫描每个提交的 diff（新增行）。
 *
 * 为什么扫 diff 而不是扫每个提交的完整树：完整树会把同一段内容重复扫 N 次，
 * 而"某段内容首次被加进来"正是泄露发生的时刻。用 `-p` 输出、只看 `+` 行，
 * 定位到 `sha:path:line`。
 *
 * @param {string[]} commits 提交列表。
 * @returns {Array<{sha: string, file: string, rule: string, line: number}>} 命中。
 */
function scanDiffs(commits) {
  const hits = []
  const skipped = { carriers: 0, fixtures: 0 }
  // 一次调用取全部历史 diff（204 个提交、约 4 MB，实测可接受）。
  const diff = git(['log', '--all', '-p', '--unified=0', '--no-color', '--pretty=format:__COMMIT__%H'])
  let sha = ''
  let file = ''
  let lineNo = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      sha = line.slice('__COMMIT__'.length).trim()
      continue
    }
    if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length).trim()
      lineNo = 0
      continue
    }
    if (line.startsWith('@@')) {
      const m = /\+(\d+)/.exec(line)
      lineNo = m === null ? 0 : Number(m[1])
      continue
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const added = line.slice(1)
    lineNo += 1
    /*
     * 规则载体与测试夹具跳过 —— 但**计数并报告**，否则"跳过了多少"又成了
     * 一个不可见的口子（这份脚本存在的理由之一就是不让范围变成猜测）。
     */
    if (RULE_CARRIERS.has(file)) {
      skipped.carriers += 1
      continue
    }
    if (isFixturePath(file)) {
      skipped.fixtures += 1
      continue
    }
    for (const rule of rules) {
      if (rule.pattern.test(added)) {
        hits.push({ sha, file, rule: rule.label, severity: rule.severity, line: lineNo })
        break
      }
    }
  }
  return { hits, skipped }
}

/**
 * 扫描每个提交的提交信息与作者信息。
 *
 * 提交信息里的邮箱是**必然存在**的（git 身份），所以这里只查凭据、本机路径
 * 与对话痕迹 —— 邮箱交给「作者身份是否被接受」这个独立问题，不在这里误报。
 *
 * @returns {Array<{sha: string, rule: string, source: string}>} 命中。
 */
function scanMessages() {
  const hits = []
  const out = git(['log', '--all', '--pretty=format:__COMMIT__%H%n%B'])
  let sha = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      sha = line.slice('__COMMIT__'.length).trim()
      continue
    }
    for (const rule of rules) {
      // 邮箱规则对提交信息不适用（作者身份是 git 的正常组成）。
      if (rule.label === '邮箱 / 真实姓名') continue
      if (rule.pattern.test(line)) {
        hits.push({ sha, rule: rule.label, severity: rule.severity, source: redact(line.trim()).slice(0, 80) })
        break
      }
    }
  }
  return hits
}

const started = Date.now()
try {
  git(['rev-parse', '--git-dir'])
} catch {
  console.error('[privacy-history] git 不可用或当前目录不是仓库 —— 无法扫描。')
  process.exitCode = 2
  // 不能报 0：跑不了不等于干净。
  throw new Error('git unavailable')
}

const commits = allCommits()
console.log(`[privacy-history] 扫描 ${commits.length} 个可达提交（全部 refs）`)
console.log('[privacy-history] 范围：git log --all 的 diff 新增行 + 提交信息')
console.log('[privacy-history] 不覆盖：reflog / 不可达对象（git fsck --lost-found）、tag 附注、')
console.log('                 GitHub Release 附件、Actions 日志、二进制内容里的字符串')
console.log('[privacy-history] 正式发布检查仍应使用 gitleaks / trufflehog')
console.log('')

const diffScan = scanDiffs(commits)
const msgHits = scanMessages()

const allHits = [...diffScan.hits, ...msgHits]
console.log(
  `[privacy-history] 跳过规则载体 ${diffScan.skipped.carriers} 行、测试夹具 ${diffScan.skipped.fixtures} 行`,
)
console.log('')
if (allHits.length === 0) {
  console.log(`[ok]   没有命中（${Date.now() - started} ms）`)
  process.exitCode = 0
} else {
  const byRule = new Map()
  for (const hit of allHits) {
    const key = hit.rule
    const list = byRule.get(key) ?? []
    list.push(hit)
    byRule.set(key, list)
  }
  for (const [label, list] of byRule) {
    console.log(`[HIT]  ${label} — ${list.length} 处`)
    /*
     * 只报位置，不报原文（与 privacy-audit.mjs 同一条理由：
     * 门禁本身不能成为泄露渠道）。
     */
    for (const hit of list.slice(0, 8)) {
      const where = 'file' in hit ? `${redact(hit.file)}:${hit.line}` : 'commit message'
      console.log(`       ${hit.sha.slice(0, 12)}  ${where}`)
    }
    if (list.length > 8) console.log(`       … 另有 ${list.length - 8} 处`)
  }
  console.log('')
  console.log(
    `[privacy-history] ${allHits.length} 处命中（${Date.now() - started} ms）。` +
      '历史内容无法靠"再提交一次"消除：先判断是否仍是有效凭据（有效则轮换），' +
      '再决定是否有必要改写历史。',
  )
  process.exitCode = 1
}
