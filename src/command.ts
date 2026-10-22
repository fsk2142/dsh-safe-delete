/**
 * 从一段命令文本里解析出「是否在删除、删什么、是不是递归」。
 *
 * 纯函数，不碰文件系统。这是整个插件最关键的一段判定：判错的代价是
 * 要么放过一次真删除，要么拦死一条正常的读命令。
 *
 * 与 dsh-safety 的关键差别：**目标无法解析时返回 `null`，不返回一个猜出来的
 * 路径**。dsh-safety 把 `$tmp`、`$_.FullName` 这类变量原文当成相对路径，
 * 拼到会话目录下再分类，于是在用户的真实日志里制造了 25 次「在你自己家目录里」
 * 的误判拦截。这里的约定是：解析不出就交给人类看一眼（`ask`），不假装知道。
 */

import type { CommandVerdict } from './types'

/**
 * 删除类动词表。
 *
 * 顺序重要：长动词排在短动词前面，否则 `rmdir` 会被 `rm` 抢先匹配。
 *
 * 含 PowerShell 的**文档化别名**（`ri` / `del` / `erase` / `rd` / `rmdir` 都是
 * Remove-Item 的别名）。别名漏一个，模型换个拼写就绕过了。
 */
const DELETE_VERBS = [
  'remove-item',
  'rmtree',
  'removedir',
  'unlink',
  'rmdir',
  'erase',
  'rd',
  'ri',
  'rm',
  'del',
] as const

/**
 * 无法静态判定目标、但明确可能是删除的构造。
 *
 * `powershell -EncodedCommand <base64>`：命令内容静态看不到。这类构造不能当作
 * "安全"放行 —— 必须交给人看。返回 `true` 表示"看不清，请人判断"。
 */
const OPAQUE_EXECUTION = [/-e(?:nc|ncodedcommand)\s+\S+/i, /frombase64string/i]

/**
 * 不经过"删除动词"表达删除的构造。
 *
 * 为什么要单独一张表：`find -delete`、`rsync --delete`、`.Delete()`、`.unlink()`
 * 这些写法里没有 `rm`/`del` 这类动词，靠动词表永远匹配不到。它们同样是真删除，
 * 漏掉就是静默失效 —— 用户以为有保护，实际没有。
 *
 * 命中即视为删除意图；目标仍按常规方式抽取（抽不出就 `ask`）。
 */
const DELETE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  // find ... -delete
  { label: 'find -delete', pattern: /\bfind\b[^\n|]*\s-delete\b/i },
  // rsync --delete / --del
  { label: 'rsync --delete', pattern: /\brsync\b[^\n|]*\s--del(?:ete)?\b/i },
  // .Delete() 方法：.NET / PowerShell 的文件与目录对象。
  //
  // 带大写 D 的形式几乎只出现在文件系统对象上（`(Get-Item x).Delete()`），
  // 而全小写的 `.delete()` 是 Map / Set / 数组的通用方法 —— 用一条正则同时匹配
  // 两者会把 `map.delete(key)` 也当成文件删除。
  { label: '.Delete() method', pattern: /\.Delete\s*\(/ },
  // .unlink() / .unlinkSync() —— 这是 fs 专有的名字，小写也安全。
  { label: '.unlink() method', pattern: /\.unlink(?:sync)?\s*\(/i },
  // .rmdir() / .rmdirSync() —— 同上。
  { label: '.rmdir() method', pattern: /\.rmdir(?:sync)?\s*\(/i },
  // perl unlink q(...)
  { label: 'perl unlink', pattern: /\bunlink\s+[q']/i },
]

/**
 * 拆开"执行一段字符串"的包装器，取出它要执行的命令。
 *
 * 覆盖：`cmd /c "…"`、`sh|bash|zsh -c "…"`、`powershell|pwsh -Command|-c "…"`、
 * `Invoke-Expression "…"` / `iex "…"`、`eval "…"`。
 *
 * @param command 已去注释的文本。
 * @returns 内层命令；不是包装器时返回 `null`。
 */
function unwrapExecutedCommand(command: string): string | null {
  const trimmed = command.trim()

  // PowerShell / POSIX 的表达式求值：直接取第一个引号段的全部内容。
  const expression = /^(?:invoke-expression|iex|eval)\s+([\s\S]+)$/i.exec(trimmed)
  if (expression !== null) {
    return stripOuterQuotes(expression[1]!.trim())
  }

  // `cmd /c ...`、`sh -c ...`、`powershell -Command ...` 等。
  const wrapper =
    /^(?:cmd|sh|bash|zsh)\s+\/c\s+([\s\S]+)$/i.exec(trimmed) ??
    /^(?:sh|bash|zsh)\s+-c\s+([\s\S]+)$/i.exec(trimmed) ??
    /^(?:powershell|pwsh)(?:\.exe)?\s+(?:-command|-c|-encodedcommand)\s+([\s\S]+)$/i.exec(trimmed)
  if (wrapper !== null) {
    return stripOuterQuotes(wrapper[1]!.trim())
  }

  // 解释器内联脚本：`python -c '...'`、`node -e '...'`、`perl -e '...'`。
  //
  // 为什么要收：这些会把整段脚本粘成一个 token，动词扫描摸不到内部。
  // `python -c 'import shutil; shutil.rmtree("/tmp/x")'` 的删除动词是**静态可见**的，
  // 只是被引号包住了 —— 与「运行时动态构造的命令」那种真正看不清的情况不同。
  // 脚本体交给嵌套解析处理（分号/换行切分已经就绪）。
  //
  // 细节：允许可选路径前缀（`/usr/bin/python`）与标志后无空格（`python -c'...'`）——
  // 两者都是合法 shell 写法，朴素匹配会漏。
  const interpreter =
    /^(?:[^\s]*[\\/])?(?:python[0-9.]*|node|nodejs|perl|ruby|php|lua)\s*(?:-c|-e|-E|-r)\s*([\s\S]+)$/i.exec(trimmed)
  if (interpreter !== null) {
    return stripOuterQuotes(interpreter[1]!.trim())
  }

  return null
}

/**
 * 去掉最外层的一对引号（`"…"`、`'…'`）。
 */
function stripOuterQuotes(text: string): string {
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) {
    return text.slice(1, -1)
  }
  return text
}/**
 * 去掉注释：注释里的删除字样不会被执行。
 *
 * 为什么要这一步：`// never run rm -rf here`、`# rm -rf the old build` 这些
 * 注释里确实出现了删除字样，但不会执行。不剥离就会把注释当成真删除 ——
 * 那正是上一代插件把写文件用的 heredoc 也拦下的原因。
 *
 * 范围刻意保守：**只去注释，不碰字符串**。引号里的内容可能是真目标
 * （`rm -rf "/tmp/real target"`），抹掉会让分类器基于错误路径判断。至于
 * `echo "rm -rf /tmp"` 这种"只是打印"，由下面的 `mentionsOnly` 另行判定。
 *
 * @param command 原始命令。
 * @returns 去掉注释后的文本。
 */
function stripComments(command: string): string {
  const withoutBlockComments = command.replace(/\/\*[\s\S]*?\*\//g, ' ')
  return withoutBlockComments
    .split('\n')
    .map((line) => {
      const hash = /(^|\s)#\s/.exec(line)
      let trimmed = hash !== null ? line.slice(0, hash.index) : line
      const slashes = /(^|\s)\/\//.exec(trimmed)
      if (slashes !== null) trimmed = trimmed.slice(0, slashes.index)
      return trimmed
    })
    .join('\n')
}

/**
 * 判断这条命令是否只是"提到"删除，而不会真的执行。
 *
 * 判定：主命令是**纯输出/检索类**（echo / grep / console.log …），且删除字样
 * 只作为它的参数出现。例如 `echo "rm -rf /tmp"`、`grep -rn "rm -rf" docs/`。
 *
 * 为什么用白名单而不是黑名单：把"主命令不是删除动词"当成条件太宽 ——
 * `find /tmp -delete`、`file.Delete()`、`powershell -EncodedCommand …` 的主命令
 * 都不是删除动词，但它们会真的删东西。只有明确"只读/只打印"的命令才可豁免。
 */
function mentionsOnly(command: string): boolean {
  const stripped = stripComments(command)

  /**
   * 按 shell 的命令分隔符切段。
   *
   * 为什么必须切：`echo hi; rm -rf /tmp/x` 里第一段只是打印，第二段是**真删除**。
   * 只看整条的第一个词，就会把这类命令整体豁免 —— 而 `;`、`&&`、换行、管道
   * 都是最常见的串联方式，等于给了一条不需要任何技巧的绕过通道。
   */
  const segments = splitOutsideQuotes(stripped)

  if (segments.length === 0) return false

  // 除第一段外，任何一段自己就是删除命令，就不算"仅提及"。
  for (const segment of segments.slice(1)) {
    const segTokens = tokenize(segment)
    const head = segTokens[0]?.toLowerCase()
    if (head === undefined) continue
    // `cat list | xargs rm -rf`：管道的下游是 `xargs rm ...`，动词在参数里。
    if (DELETES_VIA_ARGUMENT.has(head) && segTokens.some((t) => isDeleteVerb(t))) return false
    if (isDeleteVerb(head)) return false
  }

  // 命令替换会被真的执行：`echo $(rm -rf /tmp/x)` 与 `echo \`rm -rf /tmp/x\``
  // 都不是"仅在参数里提到删除"，而是「先执行里面的删除，再把输出交给 echo」。
  // 只看段首会漏掉这一类，所以把替换内容也当作一段来判。
  for (const inner of commandSubstitutions(stripped)) {
    if (containsDeleteCommand(inner)) return false
  }

  const tokens = tokenize(segments[0] ?? '')
  const first = tokens[0]?.toLowerCase()
  if (first === undefined) return false

  /**
   * "把后面的字符串当成命令执行"的包装器。
   *
   * 它们必须**排除在豁免之外**：`cmd /c "rd /s /q C:\x"` 的主命令是 `cmd`，
   * 但引号里那一段会被真的执行。把它们当"仅提及"等于开了一个大洞。
   */
  const EXECUTING_WRAPPERS = new Set([
    'cmd',
    'sh',
    'bash',
    'zsh',
    'powershell',
    'pwsh',
    'eval',
    'exec',
    'invoke-expression',
    'iex',
    'start-process',
    'call',
  ])
  if (EXECUTING_WRAPPERS.has(first)) return false

  /** 只会输出或检索、不会改动文件系统的命令。 */
  const READ_ONLY_COMMANDS = new Set([
    'echo',
    'printf',
    'print',
    'console.log',
    'grep',
    'egrep',
    'rg',
    'ag',
    'cat',
    'type',
    'less',
    'more',
    'head',
    'tail',
    'get-content',
    'select-string',
    'write-output',
    'write-host',
    'man',
    'help',
  ])

  return READ_ONLY_COMMANDS.has(first)
}

/**
 * 把"删除"作为参数转发的工具。
 *
 * `find ... -exec rm {} \;`、`cat list | xargs rm`、`Get-Content | ForEach-Object { Remove-Item }`
 * —— 这些命令自己的名字不含删除动词，但会把删除执行掉。
 */
const DELETES_VIA_ARGUMENT = new Set(['xargs', 'find', 'foreach-object', 'foreach', 'start-job', 'start-threadjob'])

/**
 * 取出所有命令替换的内容：`$(...)` 与反引号 `` `...` ``。
 *
 * 为什么必须单独处理：这两种写法在真实 shell 里是**先执行**再取输出。
 * `echo $(rm -rf /tmp/x)` 的段首是 `echo`（只读），但删除真会发生。
 *
 * @param text 命令文本。
 * @returns 每处替换内部的文本（可能为空数组）。
 */
function commandSubstitutions(text: string): string[] {
  const found: string[] = []

  // 先算出每个位置是否处在**单引号区间内**。
  //
  // 为什么：POSIX shell 里单引号抑制一切展开，`echo '$(rm -rf x)'` 打印的是
  // 字面量，不会执行；而双引号内 `"$(rm -rf x)"` **会**执行。
  // 不区分引号语境就会把字符串当命令 —— 那是误伤。
  const inSingleQuote = singleQuoteMask(text)

  // `$( ... )`：按括号配对，支持嵌套。
  for (let i = 0; i < text.length - 1; i += 1) {
    if (inSingleQuote[i] === true) continue
    if (text[i] !== '$' || text[i + 1] !== '(') continue
    let depth = 1
    let j = i + 2
    for (; j < text.length && depth > 0; j += 1) {
      if (text[j] === '(') depth += 1
      else if (text[j] === ')') depth -= 1
    }
    if (depth === 0) found.push(text.slice(i + 2, j - 1))
  }

  // 反引号：成对出现，非贪婪；同样跳过单引号内的。
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('`', cursor)
    if (open === -1) break
    const close = text.indexOf('`', open + 1)
    if (close === -1) break
    if (inSingleQuote[open] !== true) found.push(text.slice(open + 1, close))
    cursor = close + 1
  }

  return found
}

/**
 * 标记每个字符是否处在单引号区间内。
 *
 * ## 为什么要处理双引号里的单引号
 *
 * `echo "'$(rm -rf x)'"` 里那个单引号在**双引号内部**，不是单引号字符串的开始 ——
 * POSIX 会照常执行 `$()`。如果朴素地"见到单引号就翻转状态"，这段会被判成
 * 单引号区间，替换就被漏掉了（第四轮审查实测确认）。
 *
 * 规则：双引号区间内的单引号当普通字符；只有双引号**之外**的单引号才开启区间。
 *
 * @param text 命令文本。
 * @returns 与 text 等长的布尔数组。
 */
function singleQuoteMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false)
  let inSingle = false
  let inDouble = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    if (inSingle) {
      mask[i] = true
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      // 双引号区内：单引号是普通字符，不开启单引号区间。
      if (ch === '"') inDouble = false
      mask[i] = false
      continue
    }

    if (ch === "'") {
      inSingle = true
      mask[i] = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      mask[i] = false
      continue
    }
    mask[i] = false
  }

  return mask
}

/**
 * 按 shell 的命令分隔符切段，但**跳过引号内部**。
 *
 * 为什么不能直接 `split(/;/)`：`cat 'x; rm -rf y'` 里那个分号是字符串内容，
 * 不是命令分隔。朴素切分会把它当成两条命令，于是第二段「以删除动词开头」，
 * 整条被判成删除 —— 误伤。
 *
 * @param text 命令文本。
 * @returns 各段（已 trim，空段被丢弃）。
 */
function splitOutsideQuotes(text: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? ''

    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }

    // 分隔符：`;`、`&`、`|`、换行。`&&`/`||` 会在逐字符处理时自然产生空段。
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '\r') {
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current)

  return segments.map((s) => s.trim()).filter((s) => s !== '')
}

/**
 * 一段文本里是否含有会执行删除的命令。
 *
 * 不用 `tokenize` 来做主判断：它会把 `$(rm -rf x)` 整体当成一个 token，
 * 于是里面的动词摸不到。这里同时看「切分后的 token」和「原始子串」两条线。
 *
 * @param text 一段命令文本。
 * @returns 含有删除命令时为 `true`。
 */
function containsDeleteCommand(text: string): boolean {
  // 引号内的分隔符不是命令分隔（`cat 'x; rm -rf y'` 是一个命令）。
  const segments = splitOutsideQuotes(text)

  for (const segment of segments) {
    const tokens = tokenize(segment).map((t) => t.toLowerCase().replace(/^['"]|['"]$/g, ''))

    // 只看命令位：路径参数里恰好叫 `rm` 的文件不是删除命令。
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i] ?? ''
      if (!isCommandPosition(tokens, i)) continue
      if (isDeleteVerb(token)) return true
      if (DELETES_VIA_ARGUMENT.has(token) && tokens.some((t) => isDeleteVerb(t))) return true
    }
  }

  // 2) 命令替换里的是命令，逐段按命令位判。
  for (const inner of commandSubstitutions(text)) {
    if (containsDeleteCommand(inner) && innerHasCommandVerb(inner)) return true
  }

  return false
}

/**
 * 命令替换内容里是否真的在**执行**删除。
 *
 * 只看该段自身的命令位：`$(cat rm.txt)` 里的 `rm.txt` 不是命令。
 *
 * @param text 命令替换内部文本。
 * @returns 在执行删除时为 `true`。
 */
function innerHasCommandVerb(text: string): boolean {
  const segments = splitOutsideQuotes(text)
  for (const segment of segments) {
    const tokens = tokenize(segment).map((t) => t.toLowerCase().replace(/^['"]|['"]$/g, ''))
    for (let i = 0; i < tokens.length; i += 1) {
      if (!isCommandPosition(tokens, i)) continue
      if (isDeleteVerb(tokens[i] ?? '')) return true
    }
  }
  return false
}

/** 判断一个 token 是否就是删除动词（去引号、按 basename 比、忽略 .exe/.com）。 */
function isDeleteVerb(token: string): boolean {
  const cleaned = token.toLowerCase().replace(/^['"]|['"]$/g, '')
  const base = cleaned.split(/[\\/]/).pop() ?? cleaned
  // Windows 上 `rd.exe` / `del.exe` 与 `rd` / `del` 等同。
  const withoutExe = base.replace(/\.(exe|com|cmd|bat)$/, '')
  return (DELETE_VERBS as readonly string[]).includes(base) || (DELETE_VERBS as readonly string[]).includes(withoutExe)
}

/** 取出 token 的动词基本形式（`C:\…\rd.exe` → `rd`）。 */
function baseVerbOf(token: string): string {
  const cleaned = token.toLowerCase().replace(/^['"]|['"]$/g, '')
  const base = (cleaned.split(/[\\/]/).pop() ?? cleaned).replace(/\.(exe|com|cmd|bat)$/, '')
  return base
}

/**
 * 判断第 `index` 个 token 是否处在「命令位」（会被 shell 当命令执行）。
 *
 * 命令位 = 段首，或紧跟在分隔符、包装器之后：
 *   - 索引 0；
 *   - 前一个 token 以 `|`、`;`、`&` 结尾（分隔符被并进上一个 token 时）；
 *   - 前一个 token 是 `cmd /c`、`powershell -Command`、`Invoke-Expression` 之类。
 *
 * 为什么要区分：`C:\Windows\System32\rd.exe /s /q X` 是调用删除，而
 * `cp /tmp/rm /backup/` 只是复制一个恰好叫 rm 的文件。只看 basename
 * 会把后者判成「删除 /backup/」，给模型一条错误信息。
 *
 * @param tokens 整条命令的 token 列表。
 * @param index 待判断的下标。
 * @returns 处在命令位时为 `true`。
 */
function isCommandPosition(tokens: readonly string[], index: number): boolean {
  if (index === 0) return true

  const previous = (tokens[index - 1] ?? '').toLowerCase()
  const previousStripped = previous.replace(/^['"]|['"]$/g, '')
  if (/[|;&]$/.test(previousStripped)) return true

  // 包装器之后的那一段也是命令位。
  const WRAPPERS = new Set([
    'cmd',
    'sh',
    'bash',
    'zsh',
    'pwsh',
    'powershell',
    'eval',
    'exec',
    'invoke-expression',
    'iex',
    'call',
    'xargs',
    'sudo',
    'doas',
    'env',
    'time',
    'nohup',
  ])
  if (WRAPPERS.has(previousStripped)) return true

  // `cmd /c X`、`powershell -Command X`、`bash -c X`：开关之后的第一项。
  const WRAPPER_FLAGS = new Set(['/c', '-c', '-command', '/command', '-encodedcommand'])
  if (WRAPPER_FLAGS.has(previousStripped)) return true

  return false
}

/**
 * 在判定前把 shell 的「转义与引号拼接」归一化。
 *
 * 为什么必须有这一步：`r\m`、`r""m`、`r''m`、`^rm`、`\rm` 在真实 shell 里都等价于
 * `rm`。只做朴素文本匹配的拦截器，换个写法就被绕过 —— 而绕过正是这个插件要防的事。
 *
 * 注意只处理"转义一个命令名首字符"的情形，不碰路径分隔符：`C:\Work` 里的 `\W`
 * 是目录分隔，不是转义。
 */
function normalizeObfuscation(text: string): string {
  const base = text
    .replace(/""/g, '')
    .replace(/''/g, '')
    .replace(/``/g, '')
    .replace(/\^(?=[A-Za-z])/g, '')

  // 反斜杠转义只处理**命令名**（每段命令的第一个 token）。
  //
  // 为什么必须限位：`r\m` 里的 `\` 是转义；而 `C:\x\a.txt` 里的 `\` 是目录分隔。
  // 对整条命令做全局剥离会把后者变成 `C:\xa.txt` —— 分类器基于错误路径判断，
  // 比原来的漏洞更糟。所以按 `|`、`;`、`&` 切段，只清洗每段的命令名。
  return base
    .split(/(\s*[|;&]\s*)/)
    .map((segment) => {
      // 分隔符本身原样保留。
      if (/^\s*[|;&]\s*$/.test(segment)) return segment

      const match = /^(\s*)(\S+)([\s\S]*)$/.exec(segment)
      if (match === null) return segment
      const lead = match[1] ?? ''
      const first = match[2] ?? ''
      const rest = match[3] ?? ''

      // 只剥掉命令名里的反斜杠转义：`r\m` -> `rm`，`\rm` -> `rm`。
      //
      // 前提是这个名字**看起来就是一个命令词**（纯字母，可带扩展名）。
      // `fs.rmSync('C:\\Work\\a', ...)` 这种整段是「函数调用 + 字符串参数」，
      // 里面的反斜杠是转义后的路径分隔，不能碰。
      const looksLikeCommandWord = /^[A-Za-z][A-Za-z0-9_-]*$/.test(first.replace(/\\/g, ''))
      const cleaned = looksLikeCommandWord ? first.replace(/\\(?=[a-z])/g, '').replace(/^\\+/, '') : first
      return `${lead}${cleaned}${rest}`
    })
    .join('')
}

/** 递归标记。`/s` 只在 Windows `rd`/`rmdir`/`del` 语境下有意义，但多判一次无害。 */
const RECURSIVE_FLAGS = ['-recurse', '-r', '-rf', '-fr', '/s', '--recursive'] as const

/**
 * Windows 风格短选项（`rd /s`、`del /q`）。
 *
 * 必须是**白名单**而不是「以 / 开头」：POSIX 绝对路径也以 `/` 开头，
 * 用前缀判定会把 `rm -rf /tmp/x` 的目标当成选项跳过，于是误判成「目标无法解析」。
 */
const WINDOWS_FLAGS = new Set(['/s', '/q', '/f', '/r', '/p', '/a', '/d'])

/** 需要跳过的选项类 token。 */
function isOptionToken(token: string): boolean {
  if (token.startsWith('-')) return true
  return WINDOWS_FLAGS.has(token.toLowerCase())
}

/**
 * 判断一个「目标」是否根本无法静态解析。
 *
 * 命中即 `true`：shell 变量（`$x`、`$env:X`、`${X}`、`$_.Prop`）、Windows 变量
 * （`%X%`）、通配符（`*`、`?`）、命令替换（`$(...)`、反引号）。
 */
export function isUnresolvableTarget(target: string): boolean {
  if (target === '') return true
  if (target.includes('$')) return true
  if (target.includes('%')) return true
  if (target.includes('*')) return true
  if (target.includes('?')) return true
  if (target.includes('`')) return true
  return false
}

/** 一行里是否含管道分隔（`|`，但不含 `||` 之外的复杂情况——判为不可解析即可）。 */
function hasPipeline(command: string): boolean {
  return command.includes('|')
}

/**
 * 按 shell 规则分词：引号内的空白不切分，引号本身被去掉。
 *
 * 为什么不能用 `split(/\s+/)`：`rm -rf "/tmp/real target"` 的目标含空格，
 * 裸切分会把它拆成 `"/tmp/real` 和 `target"`，抽出来的路径是错的 —— 而分类器
 * 基于错误路径判断，等于保护规则出错。
 */
function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * 在动词之后找目标 token。
 *
 * 返回 `null` 表示无法确定目标（管道、命令替换、通配、变量、找不到 token）。
 */
function targetAfterVerb(tokens: string[], verbIndex: number, command: string): string | null {
  // 整条命令含管道时，删除的输入来自上游，静态解析没有意义。
  if (hasPipeline(command)) return null
  // 含命令替换同理。
  if (command.includes('$(') || command.includes('`')) return null

  for (let i = verbIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue
    if (isOptionToken(token)) continue
    // 该 token 内部若再出现引号包裹的路径，去掉首尾引号。
    const cleaned = token.replace(/^['"]|['"]$/g, '')
    if (cleaned === '') continue
    if (isUnresolvableTarget(cleaned)) return null
    return cleaned
  }
  return null
}

/**
 * 从"没有删除动词"的构造里抽取目标路径。
 *
 * @param command 原始命令文本。
 * @param label 命中的模式标签，决定抽取策略。
 * @returns 目标路径；抽不出或不可解析时返回 `null`（交给人类判断）。
 */
function targetFromPattern(command: string, label: string): string | null {
  switch (label) {
    case 'find -delete': {
      // `find <path> ... -delete`：`find` 之后的第一个非选项 token 就是起始路径。
      const after = /\bfind\b\s+(.+)$/i.exec(command)
      if (after === null) return null
      for (const token of after[1]!.split(/\s+/)) {
        if (token === '' || isOptionToken(token)) continue
        if (/\s-delete\b/i.test(token)) continue
        const cleaned = token.replace(/^['"]|['"]$/g, '')
        if (cleaned === '' || cleaned === '-delete') return null
        return isUnresolvableTarget(cleaned) ? null : cleaned
      }
      return null
    }
    case 'rsync --delete': {
      // `rsync [opts] <src> <dst>`：删除发生在 dst 上，取最后一个非选项 token。
      const tokens = command.split(/\s+/).filter((t) => t !== '' && !isOptionToken(t))
      const dst = tokens[tokens.length - 1]
      if (dst === undefined || dst.toLowerCase() === 'rsync') return null
      const cleaned = dst.replace(/^['"]|['"]$/g, '')
      return isUnresolvableTarget(cleaned) ? null : cleaned
    }
    default: {
      // 方法调用（`.Delete()` / `.unlink()` / `.rmdir()`）与 perl unlink：
      // 目标通常在括号或引号里，静态抽取不可靠 —— 一律交给人类判断。
      return null
    }
  }
}

/**
 * 判断一段被包装执行的脚本体是否**明确没有任何删除可能**。
 *
 * 用于 `node -e 'console.log(1)'` 这类高频无害写法：让它们直接放行，而不是
 * 每一条都弹审批卡。审批疲劳会让人无脑点同意，那比少问一次更危险。
 *
 * 判据（全部满足才算无害）：
 *   1. 没有任何删除动词出现在命令位（含「把删除当参数转发」的工具）；
 *   2. 没有不透明执行（Base64、`-EncodedCommand`）；
 *   3. 没有删除模式（`find -delete`、`rsync --delete`、`.unlink(` 等）；
 *   4. 没有任何命令替换（替换里可能有看不见的东西）。
 *
 * 任何一条不满足就不算「明确无害」，交给上层按「看不清」处理。
 *
 * @param body 脚本体文本。
 * @returns 明确无害时为 `true`。
 */
function isPlainlyHarmless(body: string): boolean {
  if (body.trim() === '') return true
  if (OPAQUE_EXECUTION.some((pattern) => pattern.test(body))) return false
  if (DELETE_PATTERNS.some((pattern) => pattern.pattern.test(body))) return false
  if (containsDeleteCommand(body)) return false

  // 函数式调用形态：`fs.rmSync(...)`、`shutil.rmtree(...)`、`File.delete(...)`。
  //
  // `containsDeleteCommand` 只看"命令位的动词"，摸不到这种写法 —— 而
  // `node -e 'require("fs").rmSync("/x")'` 正是它。漏了这条就会把真删除
  // 判成无害（本轮改动一度造成这个回归）。
  if (CALL_STYLE_DELETE.test(body)) return false

  // 命令替换里可能藏着删除，看不清就不算无害。
  if (commandSubstitutions(body).length > 0) return false

  return true
}

/**
 * 函数式删除调用。
 *
 * 覆盖语言标准库里"名字里就写着删除"的方法：`rmSync`、`rmtree`、`unlinkSync`、
 * `remove`、`File.delete`、`os.remove`…
 */
const CALL_STYLE_DELETE = /(?:^|[^\w])(?:rm|rmdir|removedir|unlink)(?:sync|_sync)?\s*\(|(?:rmtree|shutil\s*\.\s*rmtree)\s*\(|\.delete\s*\(|(?:os|fs|shutil)\s*\.\s*(?:remove|unlink|rmdir)\s*\(/i

/**
 * 解析命令文本。
 *
 * @param command 命令原文（可以是 shell 命令，也可以是 `run_code` 的代码体）。
 */
export function parseCommand(command: string): CommandVerdict {
  const raw = command ?? ''
  // 去掉注释（注释里的删除字样不会执行），再做转义归一化。
  // 两者都只影响判定，展示与拒绝理由仍用原始文本。
  const text = normalizeObfuscation(stripComments(raw))
  const lower = text.toLowerCase()
  const tokens = tokenize(text)

  // 只是"提到"删除（echo/grep/console.log 的参数里含 rm -rf），不会真的执行。
  // 这条必须排在所有删除判定之前，否则 `echo "rm -rf /tmp"` 会被误拦。
  if (mentionsOnly(raw)) return { destructive: false }

  // 不透明执行（Base64 编码命令等）：静态看不到内容，不能判成安全。
  //
  // **必须排在 unwrap 之前**：`powershell -EncodedCommand <base64>` 也会命中
  // unwrap 的包装器分支，而它的"脚本体"只是一串 base64 —— 若先走 unwrap，
  // 那串字符不含删除动词，会被判成无害放行。那是真实绕过。
  if (OPAQUE_EXECUTION.some((pattern) => pattern.test(raw))) {
    const recursive = RECURSIVE_FLAGS.some((flag) => lower.includes(flag))
    return { destructive: true, kind: 'delete', recursive, target: null }
  }

  // 包装器命令：`cmd /c "…"`、`sh -c "…"`、`powershell -Command "…"`、
  // `Invoke-Expression "…"` —— 引号里那一段**会被真的执行**。
  //
  // 为什么必须单独处理：`tokenize` 会把整个引号段当成一个 token，于是里面的
  // `rd /s` / `Remove-Item -Recurse` 匹配不到动词，整条命令被判成"非删除"。
  // 这是一条完整的绕过通道（而且是很常见的写法），不能靠动词表兜住。
  const wrapped = unwrapExecutedCommand(text)
  if (wrapped !== null) {
    const inner = parseCommand(wrapped)
    if (inner.destructive) return inner

    // 内层明确无害时放行，而不是一律问人。
    //
    // 为什么要区分：`node -e 'console.log(1)'`、`python -c 'print("hi")'` 是高频
    // 开发写法，全部弹卡会造成审批疲劳 —— 而审批疲劳会让人无脑点同意，反而更危险。
    //
    // 判据是「这段脚本里根本没有任何删除可能」：既没有删除动词（`mentionsOnly`
    // 已排除"仅提及"），也没有不透明执行、没有删除模式。两者都满足才放行。
    if (isPlainlyHarmless(wrapped)) return { destructive: false }

    // 否则仍然要让人看一眼：内层可能有静态看不出来的构造。
    return { destructive: true, kind: 'delete', recursive: false, target: null }
  }

  // 不经过删除动词的构造（find -delete / rsync --delete / .Delete() / unlink …）。
  //
  // 这些写法里没有 `rm`、`del` 这类词，动词表永远匹配不到。漏掉它们就等于
  // 让一条真删除通道完全不设防 —— 而这正是"写了符号却拦截失效"那种最坏的失败。
  // 命中后仍尝试抽取目标；抽不出来就交给人类判断。
  const patternHit = DELETE_PATTERNS.find((entry) => entry.pattern.test(raw))
  if (patternHit !== undefined) {
    const recursive =
      /-delete\b/i.test(raw) ||
      /--del(?:ete)?\b/i.test(raw) ||
      /recursive\s*:\s*true/i.test(lower) ||
      RECURSIVE_FLAGS.some((flag) => tokens.includes(flag))
    return {
      destructive: true,
      kind: 'delete',
      recursive,
      target: targetFromPattern(raw, patternHit.label),
    }
  }

  let verbIndex = -1
  let matchedVerb = ''

  // `-exec rm {} \;`、`| xargs rm`、`{ rm ... }`：删除语出现在**非命令位**，
  // 但确实会被执行。这些前缀是明确的"下一项会被执行"信号。
  const EXEC_SIGNALS = new Set(['-exec', '-execdir', '-ok', '-okdir', 'xargs', 'parallel', 'eval', 'exec'])
  for (let i = 1; i < tokens.length; i += 1) {
    const previous = (tokens[i - 1] ?? '').toLowerCase().replace(/^['"]|['"]$/g, '')
    if (!EXEC_SIGNALS.has(previous)) continue
    const token = (tokens[i] ?? '').toLowerCase().replace(/^['"]|['"]$/g, '')
    if (isDeleteVerb(token) && (verbIndex === -1 || i < verbIndex)) {
      verbIndex = i
      matchedVerb = baseVerbOf(token)
    }
  }

  // 花括号块：`{ Remove-Item ... }` 里的是命令。
  for (let i = 0; i < tokens.length; i += 1) {
    if ((tokens[i] ?? '') !== '{') continue
    const token = (tokens[i + 1] ?? '').toLowerCase().replace(/^['"]|['"]$/g, '')
    if (isDeleteVerb(token) && (verbIndex === -1 || i + 1 < verbIndex)) {
      verbIndex = i + 1
      matchedVerb = baseVerbOf(token)
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!.toLowerCase().replace(/^['"]|['"]$/g, '')

    // 任何形式（裸动词、带路径、带 .exe）都**只在命令位**才算删除。
    //
    // 为什么不再"精确匹配全位置都算"：`cp /tmp/rm /backup/`、`mv ri ri.bak`、
    // `git add rm` 里那个词只是参数，不是命令。旧行为会把它判成删除，而且
    // 拒绝理由会把目标说成别的路径 —— 给模型一条错误信息，比普通拒绝更坏。
    // 真实会被执行的删除都在命令位上（段首 / 分隔符后 / 包装器后），
    // `isCommandPosition` 已把这些位置列全。
    if (isCommandPosition(tokens, i) && isDeleteVerb(token)) {
      verbIndex = i
      matchedVerb = baseVerbOf(token)
      break
    }

    // 函数式调用：`fs.rmSync(` / `shutil.rmtree(` / `os.remove(`
    const callMatch = /^(?:[a-z_.]*\.)?([a-z]+)\s*\(/i.exec(token)
    if (callMatch !== null) {
      const callee = callMatch[1]!.toLowerCase()
      const isDeleteCall =
        callee === 'rm' ||
        callee === 'rmsync' ||
        callee === 'rmtree' ||
        callee === 'unlink' ||
        callee === 'unlinksync' ||
        callee === 'remove' ||
        callee === 'removesync' ||
        callee === 'removedir'
      if (isDeleteCall && (verbIndex === -1 || i < verbIndex)) {
        verbIndex = i
        matchedVerb = callee
      }
    }
  }

  if (verbIndex === -1) {
    // 兜底：分词摸不到动词，但文本里确实有会执行的删除命令。
    //
    // 典型是命令替换 `echo $(rm -rf /tmp/x)` —— `tokenize` 把 `$(rm` 粘成
    // 一个 token，主循环认不出 `rm`。这类命令在 shell 里**真的会删**，
    // 所以宁可判成删除（目标不可解析 → 交给人看），也不能放行。
    if (containsDeleteCommand(text)) {
      return { destructive: true, kind: 'delete', recursive: false, target: null }
    }
    return { destructive: false }
  }

  // 递归判定。
  //
  // 关键：标记必须作为**独立 token** 出现，不能用 `lower.includes('-r')` 这类
  // 子串匹配 —— `C:\my-report`、`C:\data\x-raw` 里都含 `-r`，子串匹配会把一次
  // 普通的单文件删除误判成递归删除。
  const flagTokens = tokens.map((t) => t.toLowerCase())
  const recursive =
    matchedVerb === 'rmtree' ||
    matchedVerb === 'removedir' ||
    flagTokens.some((token) => (RECURSIVE_FLAGS as readonly string[]).includes(token)) ||
    /recursive\s*:\s*true/.test(lower)

  // 函数式调用：目标取第一个字符串字面量参数。
  const callTarget = extractCallLiteral(text)
  if (callTarget !== null) {
    return { destructive: true, kind: 'delete', recursive, target: callTarget }
  }

  return { destructive: true, kind: 'delete', recursive, target: targetAfterVerb(tokens, verbIndex, text) }
}

/**
 * 从函数式调用里取第一个字符串字面量作为目标。
 *
 * @returns 字面量路径；找不到或该字面量不可解析时返回 `null`。
 */
function extractCallLiteral(text: string): string | null {
  const match = /\(\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(text)
  if (match === null) return null
  const literal = match[2]!.replace(/\\(.)/g, '$1')
  if (literal === '' || isUnresolvableTarget(literal)) return null
  return literal
}
