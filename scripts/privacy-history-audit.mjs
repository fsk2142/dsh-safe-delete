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
 * node scripts/privacy-history-audit.mjs
 * ```
 *
 * 不接受任何参数。曾经写过一个 `--staged`，但从未实现（第三轮复审 R04）——
 * **一个看起来有效、实际被忽略的安全审计参数比没有更危险**：有人会以为
 * "我只扫了暂存区"而不再看全量结果。现在未知参数直接退出码 2。
 *
 * 退出码：0 = 无新增命中（基线条目不算新增），1 = 有新增命中，2 = 环境不可用
 * （git 不可用、基线读不懂、基线里出现凭据条目）。
 * **不可用要报 2，不能报 0** —— 否则"跑不了"会被读成"很干净"。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/**
 * 基线文件：人工审核过的历史命中。
 *
 * ## 为什么需要它（第三轮复审 R05）
 *
 * `HANDOVER.md` 记录了 4 处已确认的历史命中，都不是凭据，且明确选择不重写
 * 历史（改写会变更所有下游 SHA 与 tag 指向）。但脚本只要命中就退出 1 ——
 * 于是这个门禁**永远是红的**。永远红的门禁等于没有门禁：所有人都学会了忽略它。
 *
 * ## 精确到 `SHA + 文件 + 规则`
 *
 * 不按规则忽略、不按文件忽略、不按路径前缀忽略。任何一条新的命中都不匹配
 * 任何一条已接受的记录，因此必须被看到。
 *
 * ## 凭据类命中**永远不能**进基线
 *
 * "历史已知"不等于"可以接受"：凭据需要轮换。基线里出现凭据条目时脚本
 * 直接退出 2，而不是把这条命中放行。
 */
const BASELINE_FILE = 'scripts/privacy-history-baseline.json'

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
 * 哪些规则允许被"夹具路径"跳过。
 *
 * ## 为什么不能一刀切跳过整个文件（2026-11-05 第三轮复审 R03）
 *
 * 旧实现对 `isFixturePath(file)` 的文件**跳过全部规则**，包括凭据、Token、密钥。
 * 于是"把真实 token 误写进 `tests/example.test.ts`，后来删掉"这种**正是历史
 * 扫描唯一能发现**的泄露，被整文件跳过了（当前工作区扫描也看不到它，因为它
 * 已经被删了）。
 *
 * 但也不能反过来把测试文件全扫 —— "本机路径""用户原话"这类规则在测试里
 * 本来就是刻意构造的假数据，全报出来会让基线无限增长，等于把门禁变噪音。
 *
 * 区分标准是**规则是否依赖上下文**：
 *
 * - 上下文规则（本机路径、用户原话、会话标识）：测试夹具天然会触发 →
 *   允许按夹具路径跳过，并计数；
 * - 内容规则（凭据、邮箱）：**不存在"这是测试"这种解释** —— 要么是假 token，
 *   要么是真的泄露，扫描必须把它报出来让人看一眼。
 *
 * 按**规则**而不是按文件放开，是这里的关键：跳过的范围必须尽可能窄。
 *
 * 注意这份豁免**只在这个脚本里**起作用。`scripts/privacy-audit.mjs` 的
 * `SCANNERS` 名单与它无关：那个脚本要跳过的是"规则文本本身"，范围更小。
 */

/**
 * 规则表。与 `privacy-audit.mjs` 保持同一套，但**只保留高置信度**的规则：
 * 历史扫描的误报无法靠"改一下再提交"消除，只能改写历史，代价高得多。
 *
 * `fixtureSkippable: true` 表示"测试目录里的命中可以按夹具跳过"——
 * 只给**上下文规则**打这个标记，凭据与邮箱永远不打（见上）。
 */
const rules = [
  {
    label: '本机用户名 / 绝对路径',
    // 排除占位符。
    pattern: new RegExp(`C:\\\\+Users\\\\+(?!alice|<user>|%USERNAME%|\\$)[A-Za-z0-9._-]+\\\\`, 'i'),
    severity: 'high',
    fixtureSkippable: true,
  },
  {
    label: '凭据 / 密钥 / Token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
    severity: 'high',
    // **永远不能**按夹具跳过，也永远不能进基线。
    fixtureSkippable: false,
  },
  {
    label: '邮箱 / 真实姓名',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    severity: 'medium',
    // 邮箱同样不是"上下文"：测试里出现的真实邮箱就是真实邮箱。
    fixtureSkippable: false,
  },
  {
    label: '对话痕迹（用户原话）',
    pattern: /用户原话|用户说[：:]|你说[：:]|报障[：:]|经用户确认|用户已同意|用户明确指出|用户报障/,
    severity: 'medium',
    fixtureSkippable: true,
  },
  {
    label: '会话 / 内部标识',
    pattern: /session-[0-9a-f]{8}-[0-9a-f]{4}|dsh-spill|Temp\\dsh-|--C-Users-/,
    severity: 'medium',
    fixtureSkippable: true,
  },
]

/** 凭据类规则的标签 —— 它们永远不能进基线。 */
const CREDENTIAL_RULES = new Set(['凭据 / 密钥 / Token'])


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
     *
     * ## 跳过是按**规则**而不是按文件（第三轮复审 R03）
     *
     * 旧实现只要文件在 `tests/` 下（或属于规则载体）就跳过**全部**规则 ——
     * 连凭据也一起跳过。于是"把真实 token 误写进 tests/example.test.ts，
     * 后来删掉"这种**正是历史扫描唯一能发现**的泄露，永远报不出来。
     *
     * 现在的豁免表：
     *
     * | 规则 | 规则载体文件 | 测试夹具路径 |
     * |---|---|---|
     * | 凭据 / 密钥 / Token | **照扫** | **照扫** |
     * | 邮箱 / 真实姓名 | 跳过 | **照扫** |
     * | 本机路径 / 用户原话 / 会话标识 | 跳过 | 跳过 |
     *
     * 凭据没有任何豁免：要么是假 token（本来就该有人确认），要么是真泄露。
     */
    const fixture = isFixturePath(file)
    const carrier = RULE_CARRIERS.has(file)
    if (carrier) skipped.carriers += 1
    else if (fixture) skipped.fixtures += 1

    for (const rule of rules) {
      if (!CREDENTIAL_RULES.has(rule.label)) {
        // 规则载体文件里的这些命中就是规则定义本身。
        if (carrier) continue
        // 夹具路径只挡**上下文**规则（本机路径、用户原话、会话标识）。
        if (fixture && rule.fixtureSkippable) continue
      }
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

/**
 * 读取基线文件。
 *
 * ## 读不懂必须报 2，不能当成空基线（第三轮复审 R05）
 *
 * 基线是**放行依据**。把它读失败当成"没有基线"会得到 0 处已接受、全量红 ——
 * 那还好；但反过来（当成"全部已接受"）就会静默放行一切。两种都不能靠猜。
 * 所以任何结构问题都直接退出 2，让人修文件。
 *
 * @param {string} path 基线路径。
 * @returns {Array<{sha: string, file?: string, rule: string}>} 条目。
 */
function readBaseline(path) {
  if (!existsSync(path)) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`[privacy-history] 基线文件 ${path} 不是合法 JSON：${String(error)}`)
    process.exit(2)
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    console.error(`[privacy-history] 基线文件 ${path} 缺少 entries 数组 —— 无法判断哪些命中已被接受。`)
    process.exit(2)
  }
  const entries = []
  for (const [i, entry] of parsed.entries.entries()) {
    if (entry === null || typeof entry !== 'object') {
      console.error(`[privacy-history] 基线第 ${i} 项不是对象。`)
      process.exit(2)
    }
    const { sha, file, rule } = entry
    if (typeof sha !== 'string' || sha.length !== 40 || typeof rule !== 'string') {
      console.error(`[privacy-history] 基线第 ${i} 项缺少完整的 sha（40 位）或 rule。`)
      process.exit(2)
    }
    if (file !== undefined && typeof file !== 'string') {
      console.error(`[privacy-history] 基线第 ${i} 项的 file 必须是字符串。`)
      process.exit(2)
    }
    /*
     * 凭据命中**永远不能**进基线：历史已知 ≠ 可以接受，需要轮换。
     * 出现这样的条目时整个门禁报环境错误，而不是把这条命中放行 ——
     * 悄悄忽略它，等于给"把凭据写进基线"开了一条路。
     */
    if (CREDENTIAL_RULES.has(rule)) {
      console.error(
        `[privacy-history] 基线第 ${i} 项试图接受一条凭据命中（${sha.slice(0, 12)}）。` +
          '凭据不能"因为历史上已知"而被接受：请轮换它，然后从基线里删掉这一项。',
      )
      process.exit(2)
    }
    entries.push(file === undefined ? { sha, rule } : { sha, file, rule })
  }
  return entries
}

/**
 * 判断一条命中是否被基线精确覆盖。
 *
 * 三个维度全等才算：`sha` + `file`（提交信息命中没有 file）+ `rule`。
 * 不做前缀匹配、不做通配 —— 那样覆盖面就变成猜测了。
 *
 * @param {{sha: string, file?: string, rule: string}} hit 命中。
 * @param {Array<{sha: string, file?: string, rule: string}>} baseline 基线。
 * @returns {boolean} 是否已接受。
 */
function isBaselined(hit, baseline) {
  return baseline.some(
    (entry) =>
      entry.sha === hit.sha &&
      entry.rule === hit.rule &&
      (entry.file ?? undefined) === (hit.file ?? undefined),
  )
}

/**
 * 解析命令行参数。
 *
 * 目前**不接受任何参数**。未知参数直接退出 2 —— 见文件头 R04 的说明：
 * 一个被静默忽略的安全审计参数比没有更危险。
 *
 * @param {string[]} argv 参数（不含 node 与脚本路径）。
 * @returns {void}
 */
function parseArgs(argv) {
  if (argv.length === 0) return
  console.error(`[privacy-history] 不支持的参数：${argv.join(' ')}`)
  console.error(
    '[privacy-history] 本脚本没有参数。它总是扫描 git log --all 的全部可达提交；' +
      '若你需要的是一次只看暂存区的检查，请用 scripts/privacy-audit.mjs。',
  )
  process.exit(2)
}

const started = Date.now()
parseArgs(process.argv.slice(2))
try {
  git(['rev-parse', '--git-dir'])
} catch {
  console.error('[privacy-history] git 不可用或当前目录不是仓库 —— 无法扫描。')
  process.exitCode = 2
  // 不能报 0：跑不了不等于干净。
  throw new Error('git unavailable')
}

const baseline = readBaseline(BASELINE_FILE)
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
const accepted = allHits.filter((hit) => isBaselined(hit, baseline))
const newHits = allHits.filter((hit) => !isBaselined(hit, baseline))

console.log(
  `[privacy-history] 跳过规则载体 ${diffScan.skipped.carriers} 行、测试夹具 ${diffScan.skipped.fixtures} 行`,
)
console.log(
  '[privacy-history] 说明：上面两个数字是"被豁免的上下文规则行数"；' +
    '凭据 / Token 规则在这两类文件里**照扫**（第三轮复审 R03）。',
)
if (baseline.length > 0) {
  console.log(
    `[privacy-history] 基线 ${BASELINE_FILE}：${baseline.length} 条已接受，命中 ${accepted.length} 处（不计入失败）`,
  )
}
console.log('')

/** 打一份分组清单。 */
function report(hits) {
  const byRule = new Map()
  for (const hit of hits) {
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
}

if (accepted.length > 0) {
  console.log('[基线] 以下命中在基线内，已人工审核并接受：')
  report(accepted)
  console.log('')
}

/*
 * 只有**新增**命中才让门禁变红。
 *
 * 这正是基线的意义：4 处已确认的历史命中（都不是凭据）让脚本永远返回 1，
 * 而永远红的门禁等于没有门禁 —— 所有人都学会了忽略它。
 */
if (newHits.length === 0) {
  console.log(
    `[ok]   没有新增命中${allHits.length === 0 ? '' : `（${accepted.length} 处在基线内）`}（${Date.now() - started} ms）`,
  )
  process.exitCode = 0
} else {
  report(newHits)
  console.log('')
  console.log(
    `[privacy-history] ${newHits.length} 处**新增**命中（${Date.now() - started} ms）。` +
      '历史内容无法靠"再提交一次"消除：先判断是否仍是有效凭据（有效则轮换），' +
      '再决定是否有必要改写历史。确认无害的条目写进 ' +
      `${BASELINE_FILE}（凭据除外 —— 凭据必须轮换，不能接受）。`,
  )
  process.exitCode = 1
}
