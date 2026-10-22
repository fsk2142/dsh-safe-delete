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
  const tokens = tokenize(stripComments(command))
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
    // 内层不是删除，但外层是包装执行：仍然要让人看一眼，因为内层可能有
    // 静态看不出来的构造。
    return { destructive: true, kind: 'delete', recursive: false, target: null }
  }

  // 不透明执行（Base64 编码命令等）：静态看不到内容，不能判成安全。
  // 交给人类看一眼，而不是放行。
  if (OPAQUE_EXECUTION.some((pattern) => pattern.test(raw))) {
    const recursive = RECURSIVE_FLAGS.some((flag) => lower.includes(flag))
    return { destructive: true, kind: 'delete', recursive, target: null }
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

  // 找出第一个命中的删除动词，并要求其位于词边界上：
  // `form.txt` 里的 `rm`、`removable` 里的 `rm` 都不算。
  let verbIndex = -1
  let matchedVerb = ''
  for (const verb of DELETE_VERBS) {
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!.toLowerCase().replace(/^['"]|['"]$/g, '')
      // 允许动词前面带 `\.\` 之类的路径前缀（如 `C:\Windows\System32\rd.exe` 不判）。
      if (token === verb) {
        if (verbIndex === -1 || i < verbIndex) {
          verbIndex = i
          matchedVerb = verb
        }
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
  }

  if (verbIndex === -1) return { destructive: false }

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
