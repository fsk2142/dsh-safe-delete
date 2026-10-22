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
 * 解析命令文本。
 *
 * @param command 命令原文（可以是 shell 命令，也可以是 `run_code` 的代码体）。
 */
export function parseCommand(command: string): CommandVerdict {
  const raw = command ?? ''
  // 先把 `r\m` / `r""m` / `^rm` 这类写法归一化，再解析。
  // 归一化只影响判定，不影响返回给用户看的原始文本。
  const text = normalizeObfuscation(raw)
  const lower = text.toLowerCase()
  const tokens = text.split(/\s+/).filter((t) => t !== '')

  // 不透明执行（Base64 编码命令等）：静态看不到内容，不能判成安全。
  // 交给人类看一眼，而不是放行。
  if (OPAQUE_EXECUTION.some((pattern) => pattern.test(raw))) {
    const recursive = RECURSIVE_FLAGS.some((flag) => lower.includes(flag))
    return { destructive: true, kind: 'delete', recursive, target: null }
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
