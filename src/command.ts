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

/**
 * 会**执行**引号里那段代码的包装器（2026-11-01 审查 SD-17）。
 *
 * `sh -c "rm x"`、`node -e "unlink(...)"`、`powershell -Command "..."` ——
 * 引号里的删除字样会被真的执行。而 `const note = "file.Delete()"` 的同样
 * 字样只是普通字符串。
 *
 * 这个集合用来区分两者：只有命令头是这些包装器时，才把引号内的删除字样
 * 当真删除。
 */
const RUNS_INLINE_CODE = new Set([
  'sh',
  'bash',
  'zsh',
  'cmd',
  'powershell',
  'pwsh',
  'node',
  'nodejs',
  'python',
  'python3',
  'perl',
  'ruby',
  'eval',
  'exec',
  'invoke-expression',
  'iex',
])
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
  // 细节：允许可选路径前缀（`/usr/bin/python`）、可执行后缀（`python.exe`）
  // 与标志后无空格（`python -c'...'`）—— 三者都是合法 shell 写法，朴素匹配会漏。
  // `python.exe -c` 在 Windows 上尤其自然，与 `isDeleteVerb` 忽略 `.exe` 的做法一致。
  const interpreter =
    /*
     * `-p` / `--print` 是只读求值：`node -p 'process.version'` 打印表达式结果，
     * 与 `-e` 的区别只是"求值并打印"。要能解包才能看到里面有没有删除。
     */
    /^(?:[^\s]*[\\/])?(?:python[0-9.]*|node|nodejs|perl|ruby|php|lua)(?:\.(?:exe|com|bat|cmd))?\s*(?:-c|-e|-E|-r|-p|--print)\s*([\s\S]+)$/i.exec(trimmed)
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
 * ## 必须维护引号状态（2026-11-01 审查 SD-11 / SD-17）
 *
 * 第一版逐行用正则找 `#` / `//` 然后截断，**完全不看引号**。两个方向的错：
 *
 * **漏判（SD-11）** —— 字符串里的注释符让后续真删除被裁掉：
 *
 * ```js
 * node -e "console.log(' # marker'); require('fs').unlinkSync('important.txt')"
 * //        ^^^^^^^^^^^^^^^^^^^^^^^ 这里有 " # "，整行从那里被截断
 * //        → 后面的 unlinkSync 根本没被看到 → destructive=false
 * ```
 *
 * **误判（SD-17）** —— 注释/字符串里的 `file.Delete()` 被当成真删除：
 *
 * ```
 * # file.Delete() is an example
 * const note = "file.Delete()"
 * ```
 *
 * 两者根因相同：把"字符出现"当成"语法角色"。
 *
 * ## 现在的做法
 *
 * 一次字符扫描，维护引号与转义状态：
 *   - 单引号内：**一切都不展开**，`#`、`//`、`/*` 都是普通字符；
 *   - 双引号内：同样保留（这里不做模板插值分析，保守起见一律当内容）；
 *   - 引号外遇到 `#`（前面是空白/行首）、`//`、`/*` 才是注释。
 *
 * 只去注释，不碰字符串 —— 与第一版的范围一致。
 *
 * @param command 原始命令。
 * @returns 去掉注释后的文本。
 */
function stripComments(command: string): string {
  let out = ''
  let i = 0
  /** 当前所处的引号：`'`、`"` 或 `null`。 */
  let quote: "'" | '"' | null = null

  while (i < command.length) {
    const ch = command[i] as string

    if (quote !== null) {
      out += ch
      if (ch === '\\' && i + 1 < command.length) {
        // 转义：把下一个字符原样带上，不让它被当成引号结束。
        out += command[i + 1] as string
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }

    // 引号外：识别注释起始。
    if (ch === "'" || ch === '"') {
      quote = ch
      out += ch
      i += 1
      continue
    }

    /*
     * `#` 注释：POSIX shell 里要求前面是空白或行首，否则 `a#b` 是普通字符。
     * JS 里 `#` 只在正则/私有字段出现，当作注释起始是保守的。
     */
    if (ch === '#') {
      const prev = i === 0 ? ' ' : (command[i - 1] as string)
      if (i === 0 || /\s/.test(prev)) {
        // 跳到行尾（不含换行）。
        while (i < command.length && command[i] !== '\n') i += 1
        continue
      }
    }

    // `//` 行注释。
    if (ch === '/' && command[i + 1] === '/') {
      while (i < command.length && command[i] !== '\n') i += 1
      continue
    }

    // `/* */` 块注释（可跨行）。
    //
    // **必须确认存在配对的 `*\/` 才当注释**（2026-11-01 修正）：
    // 路径通配里也会出现 `/*` —— `rm -rf ./*`、`rm -rf /tmp/*`。
    // 第一版（以及我这版最初的写法）一见到 `/*` 就开始吞，把目标吃成 `.`
    // 或 `/tmp`，于是 glob 删除的目标被判成字面路径。
    if (ch === '/' && command[i + 1] === '*') {
      const close = command.indexOf('*/', i + 2)
      if (close !== -1) {
        i = close + 2
        // 块注释替换成一个空格，避免把两侧 token 黏在一起。
        out += ' '
        continue
      }
      // 没有配对结束符：这是普通字符（多半是路径里的通配），原样保留。
    }

    out += ch
    i += 1
  }

  return out
}


/**
 * 把**引号内的内容**替换成空格，只保留引号本身。
 *
 * ## 为什么需要（2026-11-01 审查 SD-17）
 *
 * `DELETE_PATTERNS` 里有 `.delete(` 这类方法调用形态。而字符串里也可能
 * 出现同样的字样：
 *
 * ```
 * const note = "file.Delete()"     ← 只是字符串，不会执行
 * file.Delete()                    ← 真实调用
 * ```
 *
 * 两者在"去注释后"的文本里长得一样。要区分它们，必须知道那个 `.Delete()`
 * 是不是在引号里。
 *
 * 这个函数把 `"..."` 与 `'...'` 的内容抹成空格，于是：
 *   - `const note = "file.Delete()"` → `const note = "              "`
 *   - `file.Delete()` → 原样保留
 *
 * ## 为什么保留引号本身
 *
 * `targetFromPattern` 需要看引号来抽取目标路径。抹掉引号会让它误判。
 *
 * @param text 文本。
 * @returns 引号内容被空格替换后的文本。
 */
function blankQuotedContent(text: string): string {
  let out = ''
  let i = 0
  let quote: "'" | '"' | null = null

  while (i < text.length) {
    const ch = text[i] as string
    if (quote === null) {
      if (ch === "'" || ch === '"') {
        quote = ch
        out += ch
        i += 1
        continue
      }
      out += ch
      i += 1
      continue
    }
    // 引号内：保留引号字符本身，其余抹成空格。
    if (ch === '\\' && i + 1 < text.length) {
      out += '  '
      i += 2
      continue
    }
    if (ch === quote) {
      quote = null
      out += ch
      i += 1
      continue
    }
    // 换行保留（避免把多行结构压平），其余抹空格。
    out += ch === '\n' ? '\n' : ' '
    i += 1
  }

  return out
}

/**
 * 整条文本是否只是**一条赋值语句**（不会执行任何命令）。
 *
 * ## 为什么需要（2026-11-01 定版复核第 9 项）
 *
 * `const note = "fs.unlinkSync('x')"` 只是把字符串赋给变量。但
 * `tokenize` 会剥掉引号并把内容并进 token 流，于是 `.unlinkSync(` 这类
 * 模式仍能被匹配 —— 一次赋值被判成删除（实测 target="x"）。
 *
 * ## 判据（刻意窄）
 *
 * - 形如 `<可选 const/let/var/带类型> 标识符 = 值`；
 * - **不含**命令分隔符（`;` `&&` `||` `|` 换行）。
 *
 * 不含分隔符是关键：`x = 1; rm -rf /tmp` 必须继续被判为删除（交给逐段
 * 判定），所以这里只放行"整条就是一个赋值"的情况。
 *
 * @param text 已去注释的文本。
 * @returns 是纯赋值返回 true。
 */
function isPureAssignment(text: string): boolean {
  /*
   * ## 分号要区分"尾分号"与"语句分隔"（2026-11-02 定版验收）
   *
   * 上一版这里是 `/[;&|\n\r]/.test(text)` —— 只要出现分号就直接拒绝。
   * 而后面还有一段"允许一个尾分号"的逻辑（`body.endsWith(';')`），
   * 那段因此**永远不可达**。
   *
   * 后果：`const note = "rm -rf /tmp"` 能正确放行，
   * 但 `const note = "rm -rf /tmp";` 被判为删除 —— 一次普通赋值
   * 因为多了一个分号就弹审批。
   *
   * 现在：先把**一个**尾分号摘掉，再看剩下的是否还含分隔符。
   * 这样 `x = "a"; rm -rf /tmp`（分号后还有语句）仍会被拒绝，
   * 而 `x = "a";`（只是收尾）可以放行。
   */
  const withoutTrailing = text.trim().replace(/;\s*$/, '')
  // 剩下的部分含任何分隔符，就不是"纯"赋值。
  if (/[;&|\n\r]/.test(withoutTrailing)) return false

  const trimmed = text.trim()
  if (trimmed === '') return false

  /*
   * ## 右侧必须是**纯字面量**（2026-11-02 定版终审 F-03A）
   *
   * 上一版只要求"形如赋值"，右侧接受任意内容。于是这些被判成无害：
   *
   * ```
   * const result = fs.rmSync("x")      ← 右侧是函数调用，会真的删
   * result=$(rm -rf /tmp/x)            ← 右侧是命令替换，会被执行
   * ```
   *
   * 终审确认：1.11.2 对两者都是 destructive=true，2.0.0 变成 false ——
   * 这是我引入的**回归**。
   *
   * 现在只放行右侧为字面量的赋值：字符串、数字、布尔、null/undefined。
   * 任何调用、命令替换、拼接都继续走删除判定。
   */
  const assignment =
    /^(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:\s*[^=]+?)?\s*=\s*([\s\S]+)$/.exec(trimmed) ??
    /^[A-Za-z_$][\w$]*\s*=\s*([\s\S]+)$/.exec(trimmed)
  if (assignment === null) return false

  const rhs = (assignment[1] ?? '').trim()
  if (rhs === '') return false

  // 允许一个尾分号（`const x = "a";`）。
  const body = rhs.endsWith(';') ? rhs.slice(0, -1).trim() : rhs
  if (body === '') return false

  /*
   * ## 反引号有两种语境（2026-11-02 定版验收，P1）
   *
   * `body` 以反引号包裹时：
   *
   * - **JavaScript 模板字符串**：纯文本就是字面量，`${…}` 会执行；
   * - **Bash 命令替换**：`result=`rm -rf /tmp/x`` 里反引号内**会被执行**。
   *
   * 上一版只按 JS 规则判断（"无 `${}` 就是纯字面量"），于是：
   *
   * ```
   * result=`rm -rf /tmp/x`     → destructive:false   ← Bash 里会真的删
   * ```
   *
   * 这与已修的 `result=$(rm -rf /tmp/x)` 是**同一种能力的两种写法**，
   * 不该因为反引号长得像 JS 模板就放过。
   *
   * ## 判据
   *
   * 不看"是哪种语言"（接口没有语境参数），而看**内容是否有执行风险**：
   * 反引号内若出现删除命令或命令替换，就按删除处理。
   * 纯文字的模板字符串仍然放行 —— 那样不会误拦常见写法。
   */
  if (body.startsWith('`') && body.endsWith('`')) {
    if (body.length < 2) return false
    // `${…}` 插值：两种语境都会执行。
    if (body.includes('${')) return false
    const inner = body.slice(1, -1)
    /*
     * 反引号内若是可执行的删除（Bash 语境），不能当纯字面量。
     *
     * 三道都要：
     *   - `containsDeleteCommand`：命令位动词、包装器解包；
     *   - `isDeleteArgumentMarker`：`find -delete`、`rsync --delete` 这类
     *     动词在参数里的形态；
     *   - `hasCallStyleDelete`：`fs.rmSync(...)` 这类方法调用。
     *
     * 只查第一道会漏掉后两类（本轮实测）。
     */
    if (containsDeleteCommand(inner)) return false
    if (tokenize(inner).some((t) => isDeleteArgumentMarker(t))) return false
    if (hasCallStyleDelete(blankQuotedContent(inner))) return false
    // Shell backticks execute unknown programs too; declarations are JS templates.
    if (!/^(?:const|let|var)\s/.test(trimmed) && !provenHarmless(inner)) return false
    return true
  }

  /*
   * 单/双引号字符串。
   *
   * 要求首尾配对且中间**没有**未转义的同类引号 —— 否则说明它是拼接
   * 或调用的一部分（如 `"a" + f()`），不能当纯字面量。
   *
   * ## 但单引号与双引号在 Bash 里**根本不同**（2026-11-02 定版验收，P1）
   *
   * 这是我连续三轮漏掉的地方，每轮只修了一种表面写法：
   *
   * - 第一轮漏 `const r = fs.rmSync("x")`（右侧是调用）；
   * - 第二轮漏 `result=`rm -rf /tmp/x``（裸反引号）；
   * - 第三轮漏 `result="$(rm -rf /tmp/x)"`（**双引号里的命令替换**）。
   *
   * POSIX shell 规则：
   *   - **单引号**内一切都不展开 —— `'$(rm x)'` 就是字面量，安全；
   *   - **双引号**内 `$(…)` 与反引号**照常执行**，只是结果不分词。
   *
   * 所以"被双引号包裹"不能当作"纯文字"。这里对双引号内容单独检查。
   */
  const quote = body[0]
  if (quote === "'" || quote === '"') {
    if (!body.endsWith(quote) || body.length < 2) return false
    const inner = body.slice(1, -1)
    // 内部若有同类引号（非转义），说明外层不是单一字面量。
    if (new RegExp(`(^|[^\\\\])${quote === "'" ? "'" : '"'}`).test(inner)) return false

    // 单引号：内容不展开，可以直接当字面量。
    if (quote === "'") return true

    /*
     * 双引号：检查内部**仍会执行**的命令替换。
     *
     * `commandSubstitutions` 已经正确处理"单引号内不展开"的语境，
     * 所以直接复用它：它返回的每段都会被 shell 真的执行。
     */
    for (const substitution of commandSubstitutions(`"${inner}"`)) {
      if (!provenHarmless(substitution)) return false
      if (containsDeleteCommand(substitution)) return false
      if (tokenize(substitution).some((t) => isDeleteArgumentMarker(t))) return false
      if (hasCallStyleDelete(blankQuotedContent(substitution))) return false
    }

    // 没有会执行的删除（含转义后的 `\$(`）→ 是字面量。
    return true
  }

  /*
   * `new X()` 纯构造。
   *
   * **参数也要能证明是纯值**（2026-11-02 定版验收 F7-S1）：
   * 上一版只检查外层形状 `new X([...])`，于是
   * `new Array([require("fs").rmSync("/tmp/x")])` 被当成纯值放行 ——
   * 而构造参数会**求值**，删除在赋值完成前就执行了。
   *
   * 现在参数为空、或参数是能递归证明的纯字面量，才放行。
   */
  const constructor = /^new\s+[A-Z][\w$]*\s*\(([\s\S]*)\)$/.exec(body)
  if (constructor !== null) {
    // Pure arguments do not prove an arbitrary constructor has no side effects.
    if (!/^new\s+(?:Map|Set|WeakMap|WeakSet|Array|Date)\s*\(/.test(body)) return false
    return isPureLiteralValue((constructor[1] ?? '').trim())
  }

  /*
   * 对象 / 数组字面量：`const cfg = { delete: true }`。
   *
   * 这里的 `delete` 是**对象键**，不是方法调用 —— 第六轮复审测过它被误判。
   *
   * ## 内部元素必须逐个证明是纯值（F7-S1）
   *
   * 上一版用 `[\s\S]*` / `[^{}]*` 只看形状，于是：
   *
   * ```
   * const result = { deleted: require("fs").rmSync("/tmp/x") }
   * const result = [require("fs").rmSync("/tmp/x")]
   * ```
   *
   * 都被当成"纯数据"放行。但对象属性值与数组元素**都会求值**。
   *
   * 现在递归检查每个元素。
   */
  if (/^\[[\s\S]*\]$/.test(body) || /^\{[\s\S]*\}$/.test(body)) {
    return isPureLiteralValue(body)
  }

  // 数字 / 布尔 / 空值。
  return /^(?:-?\d+(?:\.\d+)?|true|false|null|undefined)$/.test(body)
}

/**
 * 判断一段值是否是**纯字面量**（求值不会产生任何副作用）。
 *
 * ## 为什么需要递归（2026-11-02 定版验收 F7-S1）
 *
 * 上一版只检查外层形状：
 *
 * ```
 * const result = { deleted: require("fs").rmSync("/tmp/x") }   ← 属性值会求值
 * const result = [require("fs").rmSync("/tmp/x")]              ← 元素会求值
 * const result = new Array([require("fs").rmSync("/tmp/x")])   ← 构造参数会求值
 * ```
 *
 * 三条都被当成"纯数据"放行。而 JS 里对象属性、数组元素、构造参数**都会
 * 在赋值完成前求值** —— 删除已经执行了。
 *
 * ## 判据（递归下降，不做完整 JS 解析）
 *
 * 允许：
 *   - 数字 / 字符串 / 布尔 / null / undefined
 *   - 数组 `[…]`，其中每个元素都能证明
 *   - 对象 `{…}`，其中每个值都能证明（键名不限制）
 *
 * 拒绝：
 *   - 任何调用 `f(` / `x.y(`
 *   - `require` / `import`
 *   - 模板插值 `${`
 *   - 二次求值：`=>`、`function`、`eval`
 *   - 二元/一元运算（可能藏调用）
 *
 * @param text 值文本（已去首尾空白）。
 * @returns 能证明是纯字面量返回 true。
 */
function isPureLiteralValue(text: string, depth = 0): boolean {
  /*
   * ## 深度与长度的硬上限（2026-11-05 复审 A02）
   *
   * 这是一个递归下降判定，而输入来自模型。5,000 层嵌套数组会抛
   * `RangeError: Maximum call stack size exceeded`（实测 448ms 后抛出），
   * 而上层钩子的 catch 是 fail-open —— 抛错就等于「不保护」。
   *
   * 判不了就不要硬判：返回 false（= 不能证明），调用方据此要求审批。
   */
  if (depth > MAX_LITERAL_DEPTH) return false
  if (text.length > MAX_LITERAL_CHARS) return false

  const t = text.trim()
  if (t === '') return true

  // 标量。
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(t)) return true
  if (/^(?:true|false|null|undefined|NaN|Infinity|True|False|None)$/.test(t)) return true
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith('`') && t.endsWith('`'))
  ) {
    /*
     * ## 整串必须**就是**一个字符串字面量（2026-11-05 复审 A02）
     *
     * 旧判据只看「首尾是不是同种引号 + 中间没有 `${`」。于是：
     *
     * ```
     * "a" + require("fs").rmSync("/tmp/x") + "b"
     * ```
     *
     * 以 `"` 开头、以 `"` 结尾、中间没有 `${` —— 被判成纯字面量，整个赋值
     * 因此走 `isPureAssignment` 提前放行。而它在 JS 里会被求值，删除在赋值
     * 完成前就执行了。Bash 的 `["$(rm -rf /tmp/x)"]` 是同一个洞：`$(…)` 在
     * 双引号里照样执行。
     *
     * 现在要求这是一个**语法上完整**的单一字符串：按引号规则走到结尾时
     * 恰好闭合。中途出现未转义的同类引号、或闭合后还有剩余字符，都说明它
     * 是拼接/调用的一部分，不能证明。
     */
    return isSingleStringToken(t)
  }

  // 数组：逐个元素证明。
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim()
    if (inner === '') return true
    return splitTopLevel(inner, ',').every((part) => isPureLiteralValue(part, depth + 1))
  }

  // 对象：逐个值证明。键可以是标识符、字符串或计算后的简写。
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim()
    if (inner === '') return true
    return splitTopLevel(inner, ',').every((entry) => {
      const trimmed = entry.trim()
      // `{ delete: true }` —— 找顶层冒号。
      const colon = findTopLevel(trimmed, ':')
      if (colon === -1) {
        /*
         * 简写属性 `{ fn }`：值就是变量 `fn` 本身。
         *
         * 变量引用不会执行任何东西（读取变量无副作用），但为了保守，
         * 只接受纯标识符。
         */
        return /^[A-Za-z_$][\w$]*$/.test(trimmed)
      }
      const key = trimmed.slice(0, colon).trim()
      const value = trimmed.slice(colon + 1).trim()
      // 键必须是字面量或标识符（计算键 `[f()]: 1` 会求值）。
      if (key.startsWith('[') && key.endsWith(']')) return false
      if (!/^(?:[A-Za-z_$][\w$]*|'[^']*'|"[^"]*"|\d+)$/.test(key)) return false
      return isPureLiteralValue(value, depth + 1)
    })
  }

  // 其他形态（调用、运算、模板插值…）一律不能证明。
  return false
}

/** 字面量递归深度上限。超过就判「不能证明」。 */
const MAX_LITERAL_DEPTH = 32

/** 单个字面量的字符上限。超过就判「不能证明」—— 没有人手写 4KB 的字面量。 */
const MAX_LITERAL_CHARS = 4096

/**
 * 一条命令的字符上限。
 *
 * 超过就按「无法可靠解释」处理（要求审批），而不是继续逐字符扫描。
 * 真实的 shell 命令 / 内联脚本不会到这个量级；到这个量级的多半是
 * 生成出来的、或刻意构造来拖垮解析器的输入。
 */
const MAX_COMMAND_CHARS = 64 * 1024

/**
 * 整段文本是否**恰好是一个**字符串字面量（不多不少）。
 *
 * ## 为什么不能只看首尾字符（2026-11-05 复审 A02）
 *
 * `"a" + require("fs").rmSync("/tmp/x") + "b"` 首尾都是 `"`、中间没有 `${`，
 * 旧判据因此返回 true，整条赋值被当作「纯数据」放行 —— 而它是拼接，
 * 右操作数会真的执行。
 *
 * 判据换成「扫描一遍引号状态」：从第 0 个字符开始，遇到未转义的同类引号就
 * 闭合；闭合位置必须正好是字符串末尾。中途闭合说明后面还有别的东西。
 *
 * 单引号按 POSIX/JS 语义处理（内容不展开），双引号与反引号里出现 `${` 或
 * `$(` 仍然会求值，不能证明。
 *
 * @param t 已 trim 的文本，首字符是引号。
 * @returns 确实是一个完整字符串字面量时为 true。
 */
function isSingleStringToken(t: string): boolean {
  const quote = t[0]
  if (quote !== "'" && quote !== '"' && quote !== '`') return false
  if (t.length < 2 || t[t.length - 1] !== quote) return false

  let i = 1
  let closedAt = -1
  while (i < t.length) {
    const ch = t[i] as string
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) {
      closedAt = i
      break
    }
    i += 1
  }

  // 没闭合，或闭合之后还有内容（`"a" + f()`）—— 都不是单一字面量。
  if (closedAt !== t.length - 1) return false

  const inner = t.slice(1, -1)
  /*
   * 单引号：内容在任何被支持的语言里都不展开（POSIX 与 JS 都是）。
   */
  if (quote === "'") return true
  /*
   * 双引号 / 反引号：`${…}` 与 `$(…)` 会被求值。
   *
   * `\$(…)` 是转义的字面量，所以先抹掉转义序列再查。
   */
  const unescaped = inner.replace(/\\[\s\S]/g, '')
  if (unescaped.includes('${')) return false
  if (unescaped.includes('$(')) return false
  return true
}

/**
 * 按顶层分隔符切分（忽略括号与引号内部）。
 *
 * @param text 文本。
 * @param separator 单字符分隔符。
 * @returns 各段。
 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quote !== null) {
      current += ch
      if (ch === '\\' && i + 1 < text.length) {
        current += text[i + 1] as string
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1

    if (ch === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/**
 * 找顶层某个字符的位置（忽略括号与引号内部）。
 *
 * @param text 文本。
 * @param target 目标字符。
 * @returns 索引；找不到返回 -1。
 */
function findTopLevel(text: string, target: string): number {
  let depth = 0
  let quote: string | null = null

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quote !== null) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === target && depth === 0) return i
  }
  return -1
}

/**
 * 判断一条命令是否**可以证明**不会删除任何东西。
 *
 * ## 为什么判定方向反过来了（2026-11-02 架构调整）
 *
 * 前五轮的做法是"找删除证据"：识别到就拦，找不到就放行。
 * 每轮复审都能找出一种没识别到的写法，而写法是无穷的 ——
 * 实测 10 个等价写法里漏了 4 个，且能无限造新的。
 *
 * 根因不在某条规则，在**默认值**：`return { destructive: false }` 把
 * "没找到证据"当成了"证明无害"。
 *
 * 现在：每一段都必须**正向证明**只读（`provenHarmless`），否则不算
 * "仅提及"。未知写法的默认归宿从"放行"变成"要求审批"。
 *
 * ## 与旧版的差别
 *
 * 旧版 `segments.slice(1)` —— **跳过第一段**，只检查后续段。
 * 于是第一段里的命令替换、或者整条就是一个替换时，检查不到。
 * 现在每一段都要证明，包括第一段。
 *
 * @param command 命令原文。
 * @returns 能证明无害返回 true（调用方据此放行）。
 */
function mentionsOnly(command: string): boolean {
  const stripped = stripComments(command)

  /*
   * 按 shell 分隔符切段（引号感知）。
   *
   * `echo hi; rm -rf /tmp/x` 的第二段是真删除 —— 必须逐段判。
   */
  const segments = splitOutsideQuotes(stripped)
  if (segments.length === 0) return false

  /*
   * 每一段都要能证明无害。
   *
   * 旧版跳过第一段，理由是"第一段是主命令"。但第一段也可能含命令替换
   * （`"$(rm -rf x)"` 整条就是一段），跳过它等于不检查。
   */
  for (const segment of segments) {
    if (!provenHarmless(segment)) return false
  }

  return true
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

  /*
   * 3) "把后面的字符串当命令执行"的包装器（2026-11-01 定版复核第 6 项）。
   *
   * 上面只查**命令位**的动词。而 `sh -c "rm -rf /tmp/x"` 里 `rm` 位于字符串
   * 参数中，不在命令位 —— 所以这里原本返回 false。
   *
   * 单独解析整条命令时 `parseCommand` 会先 `unwrapExecutedCommand`，能识别；
   * 但 `mentionsOnly` 只做切段、没做解包，于是"已经是真删除的命令 + 只读
   * 前缀"就漏掉了。
   *
   * 这里补上解包：把包装器里的那段代码按命令再判一次。
   */
  const unwrapped = unwrapExecutedCommand(text)
  if (unwrapped !== null && containsDeleteCommand(unwrapped)) return true

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

/**
 * 在**参数位置**表达删除的标记（2026-11-01 审查 SD-10）。
 *
 * `DELETE_VERBS` 是**命令名**的集合。但有些工具把删除表达为**选项**：
 *
 * ```
 * find /tmp/x -delete          ← 命令名是 find（不在 DELETE_VERBS 里）
 * rsync --delete src/ dst/     ← 命令名是 rsync
 * ```
 *
 * 切段后的 `mentionsOnly` 只查段首是不是删除动词，于是
 * `echo ready; find /tmp/x -delete` 被判为"仅提及"而放行 ——
 * 而 `find /tmp/x -delete` 单独出现时能被别处的整串正则抓到。
 *
 * 隔离验证：前者 `destructive=false`，后者 `true`。同一个删除，加了只读前缀
 * 就豁免了。
 */
/**
 * 可以**证明**只读的命令（正向白名单）。
 *
 * ## 为什么是白名单而不是黑名单（2026-11-02 架构调整）
 *
 * 前五轮都在做"识别删除"——每轮补一种写法，复审再找出一种新的。
 * 实测证明这条路没有终点：`awk system()`、`busybox rm`、
 * `xargs sh -c` 等 10 个等价写法里我漏了 4 个，而且能无限造。
 *
 * 根因是 `parseCommand` 的最后一个 `return { destructive: false }` ——
 * **"没找到删除证据"被当成了"证明不会删除"**。
 *
 * 现在把判定反过来：每个执行段必须落在下面的名单里，才允许放行；
 * 其余一律要求审批。这样"未知写法"的默认归宿是**问**，不是**放**。
 *
 * ## 名单为什么这么短
 *
 * 越短越安全、误报越多。这里只收**明确不会产生文件系统副作用**的命令：
 *
 * - 纯输出：`echo` / `printf` / `print`
 * - 纯读取：`cat` / `head` / `tail` / `less` / `more` / `wc` / `sort` / `uniq`
 * - 纯检索：`grep` / `rg` / `egrep` / `ag` / `findstr`
 * - 纯查询：`pwd` / `whoami` / `date` / `env` / `which` / `type`
 * - 版本控制**只读子命令**另判（`git status` 等），不整条 `git` 放行
 *
 * ## 刻意不收的
 *
 * - `find`：支持 `-delete` / `-exec`
 * - `awk` / `sed`：支持 `system()` / `e` 命令
 * - `xargs`：会把管道内容当命令执行
 * - `sh` / `bash` / `node` / `python`：执行包装器
 * - `tee` / `touch` / `mkdir` / `cp` / `mv`：有写入副作用
 */
const PROVEN_READ_ONLY = new Set([
  'echo',
  'printf',
  'print',
  'console.log',
  'ls',
  'dir',
  'pwd',
  'whoami',
  'date',
  'which',
  'cat',
  'type',
  'less',
  'more',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'grep',
  'egrep',
  'rg',
  'ag',
  'findstr',
  /*
   * `cp` / `copy` 只**读取**源、写入目标，不删除任何东西。
   * 第六轮复审测过 `cp /tmp/rm /backup/`（源文件名含 rm）被误判。
   *
   * 注意 `mv` **不在此列** —— 它会移走原文件，语义上接近删除。
   */
  'cp',
  'copy',
  /*
   * `find` 本身是只读查询。
   *
   * 我起初拒绝把它放进来（因为它支持 `-delete` / `-exec`），但
   * `isDeleteArgumentMarker` 与 `containsDeleteCommand` 已经挡住那些形态：
   * `find /tmp -delete` 会在参数级标记处被否决，不需要靠"不在白名单"。
   *
   * 所以 `find /tmp -name "*.log"` 这种纯查询可以放行 —— 否则每次列文件
   * 都要弹卡。
   */
  'find',
  'get-content',
  'select-string',
  'write-output',
  'write-host',  'man',
  'help',
  'true',
  'false',
  'test',
  // PowerShell 只读形态（大小写在调用处已归一）。
  'get-childitem',
  'get-item',
  'get-itemproperty',
  'get-location',
  'get-process',
  'get-service',
  'get-command',
  'get-help',
  'get-date',
  'get-content',
  'select-object',
  'where-object',
  'sort-object',
  'measure-object',
  'format-table',
  'format-list',
  'out-string',
  'resolve-path',
  'test-path',
  'join-path',
  'split-path',
])

/**
 * `python -m <module>` 里**整体**可以证明只读的模块。
 *
 * `python -m pytest` / `python -m json.tool` 是标准开发命令；
 * 而 `python -m 任意模块` 可能调用 `shutil.rmtree`。
 *
 * ## `pip` / `venv` 不在这里（2026-11-02 定版验收 F7-S3）
 *
 * 上一版把 `pip` 和 `venv` 整体列为安全。但：
 *
 * - `python -m venv --clear /tmp/env` —— `--clear` **会删除**已存在目标目录的内容
 *   （`python -m venv --help` 有原文说明）；
 * - `python -m pip uninstall -y demo` —— 卸载并**删除**已安装文件。
 *
 * 一个模块里有查询能力，不能推出它的**所有**调用都不删文件。
 * 所以这两个改为按子操作判断（见 `PROVEN_READ_ONLY_PY_SUBCOMMAND`）。
 */
const PROVEN_READ_ONLY_PY_MODULE = new Set([
  'pytest',
  'unittest',
  'json.tool',
  'http.server',
  'compileall',
  'pydoc',
])

/**
 * 需要看**子操作与参数**才能判断的 python 模块。
 *
 * 每条都只放行明确的查询形态；其余（`uninstall`、`--clear`、
 * 以及任何不认识的子命令/参数）都要求审批。
 */
const PROVEN_READ_ONLY_PY_SUBCOMMAND: Record<string, (args: readonly string[]) => boolean> = {
  /*
   * `pip` 的只读子命令。`uninstall` / `cache purge` 等会删文件 —— 不放行。
   * 另外 `--target` / `-t` 会写目录，也排除。
   */
  pip: (args) => {
    const sub = (args[0] ?? '').toLowerCase()
    const readOnly = new Set(['list', 'show', 'freeze', 'check', '--version', '-v', 'search', 'index', 'inspect'])
    if (!readOnly.has(sub)) return false
    // 写目录的参数即使出现在只读子命令里也不能证明。
    return !args.some((a) => /^(?:--target|-t|--prefix|--root|--clear)/i.test(a))
  },
  /*
   * `venv` 默认会在目标目录创建环境（写文件，但不删已有内容）。
   * `--clear` / `--upgrade` 会先清空目标 —— 必须拦。
   */
  venv: (args) => !args.some((a) => /^--(?:clear|upgrade)\b/i.test(a)),
}

/**
 * `git` 的只读子命令。
 *
 * 为什么单独判而不整条放行 `git`：`git clean -fdx` 会**真的删文件**，
 * 而 `git status` / `git log` / `git diff` 只读。按子命令区分才准确。
 */
const PROVEN_READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'remote',
  'rev-parse',
  'ls-files',
  'blame',
  'describe',
  'tag',
  'config',
  /*
   * `git add` / `git commit` 只改索引与仓库状态，**不删**工作区文件。
   * 第六轮复审测过 `git add rm`（文件名恰好叫 rm）被误判成删除。
   *
   * ## 刻意不收的 git 子命令
   *
   * - `clean`：`git clean -fdx` 会真的删文件；
   * - `checkout` / `restore` / `switch`：会**覆盖**工作区内容（未提交的修改丢失）；
   * - `stash`：把修改移走；
   * - `merge` / `rebase` / `cherry-pick`：可能改写工作区；
   * - `pull`：见下方说明。
   *
   * 它们不"删文件"，但都能让用户丢数据 —— 归入要求审批。
   */
  'add',
  'commit',
  'fetch',
  'push',
])

/*
 * ## `git pull` 不再是「只读」（2026-11-05 复审 A03）
 *
 * 旧版本把它收进只读表，理由是「只改索引与仓库状态，不删工作区文件」。
 * 前半句对 `add` / `commit` 成立，对 `pull` **不成立**：
 *
 * - 上游删除一个已跟踪文件时，`git pull`（fast-forward 或 merge）会把工作区
 *   里那份**一并删掉** —— 一次真实的文件消失，而插件放行了它；
 * - 它还会移动 HEAD、改动当前分支，语义上属于写操作。
 *
 * `fetch` / `push` 保留在只读表里：它们只更新远端与 remote-tracking 引用，
 * 从不改动工作区文件。把 `push` 也拦下只会让模型被要求改用 `safe_delete`，
 * 那对一次推送毫无意义 —— 误拦同样是失效的一种（用户会开始无脑点同意）。
 */

/**
 * `pnpm` / `npm` / `yarn` 的**查询类**子命令。
 *
 * ## 刻意不收 `build` / `start` / `test` / `typecheck` / `lint`（2026-11-05 复审 A03）
 *
 * 这些名字**执行的是 package.json 里的脚本**，而脚本内容由项目任意定义：
 *
 * ```json
 * { "scripts": { "build": "node scripts/cleanup-build.js" } }
 * ```
 *
 * 旧版本把它们收进来，注释里的理由是「赌构建脚本不删东西」—— 那与函数名
 * `isProvenReadOnlyCommand` 的「证明」语义直接矛盾。一个按惯例猜的豁免被写成
 * 「已证明只读」，等于把「插件声称无害」与「用户自己承担风险」混为一谈；
 * 仓库新增一个清理脚本就会静默变成绕过通道。
 *
 * 所以：**执行项目自定义脚本的入口一律要求审批**（与 `run` / `exec` / `dlx` 同类）。
 * 代价是每次构建多一次确认 —— 这是明示的取舍，见 README 的「已证明只读」一节。
 *
 * 保留的都是真正的查询：它们只读注册表 / 已安装清单，不执行项目脚本。
 */
const PROVEN_READ_ONLY_PKG = new Set([
  'ls',
  'list',
  'outdated',
  'why',
  'view',
  'info',
  /*
   * 刻意不收 `run` / `exec` / `dlx` / `build` / `start` / `test` / `typecheck` / `lint`：
   *
   * `run <script>` 与 `build` 这类**裸脚本名**最终都执行 package.json 里写的
   * 任意命令（`"clean": "rimraf dist"`）。它们与 `exec`/`dlx` 同类，
   * 不属于「已证明只读」。
   *
   * 注意 `pnpm build` 与 `pnpm run build` 都会执行 `scripts.build` ——
   * 两者都要问，不存在「不带 run 就安全」这回事。
   */
])

/**
 * 判断一个命令 token 是否是"已证明只读"的主命令。
 *
 * @param token 命令名（已小写、已去引号）。
 * @param next 紧邻的下一个 token（用于 `git` / `pnpm` 这类要看子命令的）。
 * @returns 能证明只读返回 true。
 */
function isProvenReadOnlyCommand(token: string, next?: string): boolean {
  const base = (token.split(/[\\/]/).pop() ?? token).replace(/\.(exe|com|cmd|bat)$/, '')
  if (PROVEN_READ_ONLY.has(base)) return true
  if (base === 'git') {
    const sub = (next ?? '').toLowerCase()
    // 没有子命令、或子命令不在只读表里 → 不能证明。
    return sub !== '' && PROVEN_READ_ONLY_GIT.has(sub)
  }
  if (base === 'pnpm' || base === 'npm' || base === 'yarn') {
    const sub = (next ?? '').toLowerCase()
    if (sub === '') return false
    /*
     * 版本查询是只读的，但它写成**旗标**而不是子命令：
     * `pnpm --version` / `npm -v`。
     *
     * 注意 `pnpm version`（不带横线）是**写**操作 —— 它会改 package.json
     * 并打 tag，所以只接受带横线的形态。
     */
    if (sub === '--version' || sub === '-v' || sub === '-version') return true
    return PROVEN_READ_ONLY_PKG.has(sub)
  }
  return false
}

/**
 * 判断一个执行段是否能**证明**不会删除任何东西。
 *
 * ## 为什么需要它（2026-11-02 架构调整）
 *
 * 五轮复审的共同根因：判定逻辑是"找删除证据"，找不到就放行。
 * 于是任何我没预料到的写法都是漏洞，而写法是无穷的。
 *
 * 这个函数是**正向证明**：只有落在已知安全的形态里才返回 true。
 * 调用方（`mentionsOnly`）在它返回 false 时要求审批 ——
 * 未知的默认归宿从"放行"变成"问"。
 *
 * ## 判据
 *
 * 1. 展开命令替换（`$(…)` / 反引号）后，**每一段**的主命令都能证明只读；
 * 2. 段内不含任何删除构造（动词、参数级标记、方法调用、`system(`）。
 *
 * @param segment 一个执行段（已按分隔符切开）。
 * @param depth 递归深度（防循环）。
 * @returns 能证明无害返回 true。
 */
function provenHarmless(segment: string, depth = 0): boolean {
  if (depth > 4) return false

  const text = segment.trim()
  if (text === '') return false

  /*
   * ## 容器操作不是文件删除（2026-11-02 架构调整时发现）
   *
   * `Map.delete(k)` / `Set.delete(v)` / `cache.delete(key)` 是内存数据结构
   * 的操作，不碰文件系统。而 `containsDeleteCommand` 看到 `.delete(` 就命中，
   * 于是 `node -e 'const m=new Map(); m.delete("k")'` 被判成删除。
   *
   * 第六轮复审专门测过这一点。在正向证明里把它排除掉：
   * 如果**唯一**的删除嫌疑来自容器方法调用，就不算否决理由。
   */
  const containerOnly = isContainerDeleteOnly(text)

  /*
   * `system(` / `exec(` 是"把字符串当命令执行"的通用通道 ——
   * awk / perl / 某些 DSL 都支持。看不清内容就不放行。
   *
   * 这条要排在容器判定**之前**：`m.delete(system('x'))` 里的 `system`
   * 会被执行，不能因为外层是容器调用就放过。
   */
  if (/\b(?:system|popen|execSync|spawnSync)\s*\(/i.test(text)) return false

  /*
   * 纯容器操作：`m.delete("k")` 是内存操作，不碰文件系统。
   *
   * 这里要**直接返回 true**，而不是像下面那样"跳过否决"——
   * 因为主命令 `m` 不在只读白名单里，走到末尾仍会被判 unverifiable。
   *
   * `isContainerDeleteOnly` 已确保"移除容器调用后没有其它删除痕迹"，
   * 所以 `m.delete(k); fs.rmSync(x)` 不会到这里。
   */
  if (containerOnly) return true

  // 段内任何删除构造都直接否决。
  if (containsDeleteCommand(text)) return false
  /*
   * ## `git` 的 `--delete` 删的是**引用**，不是文件
   *
   * `git branch --delete old` 与 `git branch -d old` 等价 —— 删的是分支，
   * 工作区文件不受影响。但 `--delete` 在 `DELETE_ARGUMENT_MARKERS` 里
   * （`rsync --delete` 用它删文件），于是长写法被误拦而短写法放行。
   *
   * 判据：主命令是 `git` 且子命令在只读表里 → 忽略参数级标记。
   * `git clean -fdx` 不在只读表里，仍会走完整判定。
   */
  const isGitReadOnly = (() => {
    const tokens = tokenize(text)
    const first = tokens[0]?.toLowerCase()
    if (first === undefined) return false
    const base = (first.split(/[\\/]/).pop() ?? first).replace(/\.(exe|com|cmd|bat)$/, '')
    return base === 'git' && isProvenReadOnlyCommand('git', tokens[1]?.toLowerCase())
  })()

  if (!isGitReadOnly && tokenize(text).some((t) => isDeleteArgumentMarker(t))) return false
  if (hasCallStyleDelete(blankQuotedContent(text))) return false

  /*
   * ## 两种"看着像删除但不会删文件"的形态
   *
   * `delete obj.key` —— JS 的 `delete` **运算符**，删的是对象属性，
   * 不碰文件系统。它与命令 `del` 只差一个字母，但语义完全不同。
   *
   * `rsync -a src/ dst/` —— **不带** `--delete` 时只做复制。
   * 而 `rsync --delete` 会删目标端多余文件（参数级标记已挡住那种）。
   */
  if (/^delete\s+[\w$.]+\s*(\[[^\]]*\])?$/.test(text)) return true
  if (/^rsync\b/i.test(text) && !/--(?:del|delete)/i.test(text)) return true

  /*
   * 命令替换里的内容会被执行 —— 递归证明。
   */
  for (const substitution of commandSubstitutions(text)) {
    if (!provenHarmless(substitution, depth + 1)) return false
  }

  /*
   * 主命令判定。把替换抹掉后看剩下的第一个 token。
   *
   * ## 命令名要按 `(` 截断
   *
   * `tokenize` 不把 `(` 当分隔符，于是 `console.log(1)` 会成为**一个** token，
   * 与白名单里的 `console.log` 对不上 —— 内侧无害的 `node -e 'console.log(1)'`
   * 因此被判 unverifiable（实测）。
   *
   * 这里取第一个 token 时截到 `(` 为止，与 shell 的"命令名 + 参数"形态一致。
   */
  const stripped = text.replace(/\$\([^)]*\)/g, ' ').replace(/`[^`]*`/g, ' ').trim()
  const tokens = tokenize(stripped)
  const rawFirst = tokens[0]?.toLowerCase()
  const first =
    rawFirst === undefined ? undefined : (rawFirst.split('(')[0] ?? rawFirst).trim() || undefined
  if (first === undefined) {
    // 整段就是一个替换 —— 已在上面递归证明过。
    return commandSubstitutions(text).length > 0
  }

  /*
   * `python -m <module>`：模块名不是文件，按已知只读模块判断。
   *
   * `python -m pytest` 是标准开发命令；`python -m 任意模块` 可能删文件。
   */
  if (/^(?:python[0-9.]*|py)$/.test(first) && tokens[1]?.toLowerCase() === '-m') {
    const module = (tokens[2] ?? '').toLowerCase()
    if (module === '') return false

    // 整体只读的模块。
    if (PROVEN_READ_ONLY_PY_MODULE.has(module)) return true

    /*
     * 要看子操作与参数的模块（`pip` / `venv`）。
     *
     * F7-S3：`venv --clear` 会清空目标目录、`pip uninstall` 会删安装文件 ——
     * 不能因为模块名在白名单里就整体放行。
     */
    const judge = PROVEN_READ_ONLY_PY_SUBCOMMAND[module]
    if (judge !== undefined) return judge(tokens.slice(3))

    return false
  }

  /*
   * 取子命令时注意：`console.log(1)` 的第一个 token 没有第二个，
   * 而 `git status` 有。用同一个 token 列表即可。
   */
  // env with operands executes another program; only the bare query is safe.
  if (first === 'env') return tokens.length === 1
  return isProvenReadOnlyCommand(first, tokens[1]?.toLowerCase())
}

/**
 * 判断文本里**唯一**的删除嫌疑是否来自容器方法调用。
 *
 * ## 为什么需要（2026-11-02 架构调整）
 *
 * `Map.delete(k)` / `Set.delete(v)` / `cache.delete(key)` 是内存操作，
 * 不碰文件系统。但 `containsDeleteCommand` 与 `hasCallStyleDelete` 看到
 * `.delete(` 就命中 —— 第六轮复审专门测过这类误判。
 *
 * ## 判据
 *
 * 1. 文本含 `<容器名>.delete(` 形态；
 * 2. 且**移除**这些调用后，不再有任何删除构造。
 *
 * 两条都满足才算"只是容器操作"。这样
 * `const m = new Map(); m.delete('k'); fs.rmSync('x')` 仍会被否决
 * —— 它的删除嫌疑不只来自容器。
 *
 * @param text 命令文本。
 * @returns 只有容器删除返回 true。
 */
function isContainerDeleteOnly(text: string): boolean {
  /*
   * 常见的容器/缓存变量名与标准容器类。
   *
   * 刻意收窄：只认这些明确是内存结构的名字。`.delete(` 前面是任意标识符
   * 时不算 —— 那可能是 `fs` 的包装、也可能是别的危险对象。
   */
  const pattern =
    /\b(?:map|set|weakmap|weakset|cache\w*|\w*map|\w*set|\w*cache|m|s|registry|store|pool|queue|list|dict|tree|index|memo)\s*\.\s*delete\s*\(/gi

  if (!pattern.test(text)) return false

  /*
   * 移除容器调用后，再检查是否还有删除痕迹。
   */
  const without = text.replace(pattern, ' ')

  if (containsDeleteCommand(without)) return false
  if (hasCallStyleDelete(blankQuotedContent(without))) return false
  if (tokenize(without).some((t) => isDeleteArgumentMarker(t))) return false

  return true
}

/**
 * 判断一段**表达式**（不是命令）是否只读。
 *
 * ## 为什么与 `provenHarmless` 分开
 *
 * `node -p 'process.version'` 的内层是表达式 —— `process.version` 不是
 * 命令名，所以 `provenHarmless` 的白名单判定不适用。
 *
 * 但表达式同样可能删东西：`node -p 'require("fs").rmSync("x")'`。
 *
 * 判据：不含任何删除构造、不含能执行字符串的调用（`eval` / `Function` /
 * `system`）、不含命令替换。
 *
 * @param text 表达式文本。
 * @returns 能证明只读返回 true。
 */
function isReadOnlyExpression(text: string): boolean {
  const t = text.trim()
  if (t === '') return false

  /*
   * ## 从"未命中即安全"改成"正向证明"（2026-11-02 定版验收 F7-S2）
   *
   * 上一版是列出若干危险模式，**都没命中就 return true**。于是
   * `pwsh -Command '[System.IO.Directory]::Delete("C:\Temp\x", $true)'`
   * 被放行 —— 而它的裸调用形式却能进 ask：
   *
   * | 输入 | 结果 |
   * |---|---|
   * | `[System.IO.Directory]::Delete("x", $true)` | ask ✓ |
   * | `pwsh -Command '[System.IO.Directory]::Delete("x", $true)'` | **放行** ✗ |
   *
   * 同一个删除，加了执行包装反而绕过 —— 与五轮复审的根因完全同型：
   * 黑名单挡不住没想到的写法。
   *
   * ## 现在的判据
   *
   * 只有落在下面这些**已知安全形态**里才返回 true：
   *   - 纯标量：数字、字符串字面量、布尔、null
   *   - 属性读取：`process.version`、`a.b.c`
   *   - 上述的简单组合（不含调用、不含运算副作用）
   *
   * 其余（含任何 `(`、`[`、`::`、`=>`）一律不能证明 —— 要求审批。
   */
  if (containsDeleteCommand(t)) return false
  if (tokenize(t).some((token) => isDeleteArgumentMarker(token))) return false
  if (hasCallStyleDelete(blankQuotedContent(t))) return false

  /*
   * 任何调用形态都不能证明：`f(`、`x.y(`、`::`、`=>`、`[`（索引器可能触发访问器）。
   */
  if (/[`$]/.test(t)) return false
  if (t.includes('(') || t.includes('::') || t.includes('=>')) return false
  if (/\b(?:require|import|eval|Function|new)\b/.test(t)) return false
  if (/[+\-*/%&|^~<>!=?]/.test(t)) return false

  /*
   * 正向形态：
   *   - 纯标量（数字 / 字符串 / 布尔 / 空值）
   *   - 属性链 `a.b.c`（读取属性无副作用）
   */
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return true
  if (/^(?:true|false|null|undefined|NaN|Infinity|True|False|None)$/.test(t)) return true
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.length >= 2
  }
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(t)) return true

  // 不认识 → 不能证明。
  return false
}

/**
 * 在参数位置表达删除的标记。
 */
const DELETE_ARGUMENT_MARKERS = [
  '-delete',
  '--delete',
  '--delete-after',
  '--delete-before',
  '--delete-during',
  '--delete-excluded',
  '--remove-source-files',
] as const

/**
 * 判断一个 token 是否是"参数位置的删除标记"。
 *
 * 也覆盖方法调用形态：`.delete()`、`.unlink()`、`.rmdir()`、`.remove()`
 * —— PowerShell 的 `(Get-Item x).Delete()` 与 Node 的 `fs.unlinkSync(x)`
 * 都是这种形状，动词不在段首。
 *
 * @param token token（已小写、已去引号）。
 * @returns 是删除标记返回 true。
 */
function isDeleteArgumentMarker(token: string): boolean {
  const cleaned = token.toLowerCase().replace(/^['"]|['"]$/g, '')
  if ((DELETE_ARGUMENT_MARKERS as readonly string[]).includes(cleaned)) return true
  /*
   * 方法调用形态：`(get-item c:\x).delete()`、`fs.rmdirsync(...)`、`.unlink()`。
   *
   * 只认"点 + 删除动词 + 左括号"这个紧凑形状，避免把
   * `console.log('delete')` 这种普通字符串也算进来。
   */
  return /\.(delete|deletemany|unlink|unlinksync|rmdir|rmdirsync|remove|removeitem)\s*\(/.test(cleaned)
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
  /*
   * ## 匹配前先抹掉字符串字面量（2026-11-01 定版复核第 9 项）
   *
   * `node -e "const note = 'file.Delete()'"` 里 `.Delete()` 只是字符串内容。
   * 若直接在原文上匹配 `DELETE_PATTERNS`，这条会被判成"有删除可能"，
   * 于是每个纯赋值脚本都弹一次审批 —— 审批疲劳本身会让保护失效。
   *
   * 抹掉引号内容后仍是代码的地方才继续判断。
   *
   * 注意顺序：**先抹再判**。反过来的话字符串里的模式已经命中了。
   */
  const bodyCode = blankQuotedContent(stripComments(body))
  if (OPAQUE_EXECUTION.some((pattern) => pattern.test(body))) return false
  if (DELETE_PATTERNS.some((pattern) => pattern.pattern.test(bodyCode))) return false
  if (containsDeleteCommand(bodyCode)) return false

  // 函数式调用形态：`fs.rmSync(...)`、`shutil.rmtree(...)`、`File.delete(...)`。
  //
  // `containsDeleteCommand` 只看"命令位的动词"，摸不到这种写法 —— 而
  // `node -e 'require("fs").rmSync("/x")'` 正是它。漏了这条就会把真删除
  // 判成无害（本轮改动一度造成这个回归）。
  if (hasCallStyleDelete(bodyCode)) return false

  // 命令替换里可能藏着删除，看不清就不算无害。
  if (commandSubstitutions(body).length > 0) return false

  return true
}

/**
 * 函数式删除调用。
 *
 * 覆盖语言标准库里"名字里就写着删除"的方法：`rmSync`、`rmtree`、`unlinkSync`、
 * `os.remove`、`File.delete`、`fs.unlink`…
 *
 * ## 为什么分成两个正则
 *
 * `.delete(` 必须**大小写敏感**：`Map.delete("k")`、`Set.delete(1)` 是容器操作，
 * 不碰文件系统。如果把 `.delete(` 放进带 `/i` 的那条里，大写 `.Delete(` 的模式
 * 会反过来匹配小写 —— 误伤面就被重新打开（第六轮审查实测确认）。
 *
 * 所以：无歧义的名字走 `/i`（`rmSync`、`rmtree`、`os.remove`…），
 * 有歧义的名字走大小写敏感（`File.delete`、`.Delete(`）。
 */
const CALL_STYLE_DELETE_ANY_CASE = new RegExp(
  [
    // 语言方法名里带 rm / unlink / rmtree 的，大小写不敏感也安全。
    String.raw`(?:^|[^\w])(?:rm|rmdir|removedir|unlink)(?:sync|_sync)?\s*\(`,
    String.raw`(?:rmtree|shutil\s*\.\s*rmtree)\s*\(`,
    // 资源路径限定的删除：os.remove / fs.unlink / shutil.rmtree。
    String.raw`(?:os|fs|shutil)\s*\.\s*(?:remove|unlink|rmdir)\s*\(`,
  ].join('|'),
  'i',
)

/**
 * 有歧义的 `.delete(` —— 只有明确是文件 API 的写法才算删除。
 *
 * 覆盖：
 *   - `File.delete(`（Ruby）
 *   - `.Delete(`（大写 D，C# / PowerShell 风格）
 *   - `[System.IO.File]::Delete(`（.NET 静态调用，双冒号）
 *
 * 排除容器操作：`Map.delete(`、`Set.delete(`、`cache.delete(`。
 */
const CALL_STYLE_DELETE_CASE_SENSITIVE =
  /*
   * .NET 的 File **和 Directory** 静态删除（2026-11-02 定版验收 F7-S2）。
   *
   * `[System.IO.Directory]::Delete("C:\Temp\x", $true)` 是递归删目录 ——
   * 上一版只匹配 `File`，于是这条标准 .NET 调用被当成无害。
   */
  /(?:System\s*\.\s*IO\s*\.\s*)?(?:File|Directory|DirectoryInfo|FileInfo)\]?\s*(?:\.|::)\s*[Dd]elete\s*\(|\.Delete\s*\(/

/**
 * 判断脚本体里是否有函数式删除调用。
 *
 * @param body 脚本体。
 * @returns 含删除调用时为 `true`。
 */
function hasCallStyleDelete(body: string): boolean {
  return CALL_STYLE_DELETE_ANY_CASE.test(body) || CALL_STYLE_DELETE_CASE_SENSITIVE.test(body)
}

/**
 * 解析命令文本。
 *
 * @param command 命令原文（可以是 shell 命令，也可以是 `run_code` 的代码体）。
 */
export function parseCommand(command: string): CommandVerdict {
  const raw = command ?? ''

  /*
   * ## 超长输入：判不了就要求审批（2026-11-05 复审 A04）
   *
   * 解析器是逐字符扫描 + 多处递归，输入长度没有上限。一条 400 KB 的
   * 「命令」让钩子跑 338ms，且结果不可靠 —— 真实 shell 命令不会有这个量级。
   *
   * 直接返回 destructive + target:null（= 目标不可解析 → 走审批而不是放行）。
   * 这比在别处加一堆长度检查更可靠：所有调用方都经过这个入口。
   */
  if (raw.length > MAX_COMMAND_CHARS) {
    return { destructive: true, kind: 'delete', confidence: 'unverifiable', recursive: false, target: null }
  }

  // 去掉注释（注释里的删除字样不会执行），再做转义归一化。
  // 两者都只影响判定，展示与拒绝理由仍用原始文本。
  const text = normalizeObfuscation(stripComments(raw))
  const lower = text.toLowerCase()
  const tokens = tokenize(text)

  // 只是"提到"删除（echo/grep/console.log 的参数里含 rm -rf），不会真的执行。
  // 这条必须排在所有删除判定之前，否则 `echo "rm -rf /tmp"` 会被误拦。
  if (mentionsOnly(raw)) return { destructive: false }

  /*
   * ## 纯赋值 / 纯变量声明不是命令（2026-11-01 定版复核第 9 项）
   *
   * `const note = "fs.unlinkSync('x')"` 与 `const s = "rm -rf /tmp"` 都只是把
   * 字符串赋给变量，不执行任何东西。但 `tokenize` 会剥掉引号、把内容并进
   * token 流，于是 `.unlinkSync(` 这类模式仍能被匹配到。
   *
   * 实测：`const note = "fs.unlinkSync('x')"` 被判 destructive=true、
   * target="x" —— 一次赋值被当成了删除。
   *
   * 判据刻意窄：整条形如 `<标识符> = <值>`（可选 const/let/var 前缀），
   * 且**不含命令分隔符**。这样既拦住赋值，又不放过
   * `x = 1; rm -rf /tmp`（含分隔符，交给后面的逐段判定）。
   */
  if (isPureAssignment(text)) return { destructive: false }

  // 不透明执行（Base64 编码命令等）：静态看不到内容，不能判成安全。
  //
  // **必须排在 unwrap 之前**：`powershell -EncodedCommand <base64>` 也会命中
  // unwrap 的包装器分支，而它的"脚本体"只是一串 base64 —— 若先走 unwrap，
  // 那串字符不含删除动词，会被判成无害放行。那是真实绕过。
  if (OPAQUE_EXECUTION.some((pattern) => pattern.test(raw))) {
    const recursive = RECURSIVE_FLAGS.some((flag) => lower.includes(flag))
    /*
     * 不透明执行是 `unverifiable`：我们**看不到**内容，不是"看到了删除"。
     * 它必须仍然要求审批（`ask` 下会弹卡），但 `never` 下不该被当成
     * "认出的删除"而拒绝 —— 那会把 `powershell -EncodedCommand` 之外的
     * 正常用法一起误伤。
     */
    return { destructive: true, kind: 'delete', confidence: 'unverifiable', recursive, target: null }
  }

  // 包装器命令：`cmd /c "…"`、`sh -c "…"`、`powershell -Command "…"`、
  // `Invoke-Expression "…"` —— 引号里那一段**会被真的执行**。
  //
  // 为什么必须单独处理：`tokenize` 会把整个引号段当成一个 token，于是里面的
  // `rd /s` / `Remove-Item -Recurse` 匹配不到动词，整条命令被判成"非删除"。
  // 这是一条完整的绕过通道（而且是很常见的写法），不能靠动词表兜住。
  const wrapped = unwrapExecutedCommand(text)
  if (wrapped !== null) {
    /*
     * ## 表达式先按表达式判（2026-11-02 架构调整）
     *
     * `node -p 'process.version'` 的内层是**表达式**，不是命令。
     * 若直接 `parseCommand(wrapped)`，`process.version` 会被当成命令名 ——
     * 既不在只读白名单、又"无法证明"，于是被判删除（实测）。
     *
     * 而 `node -p 'require("fs").rmSync("x")'` 必须继续拦住。
     *
     * 所以：能用 `isReadOnlyExpression` 证明只读时直接放行，
     * 否则才走 `parseCommand` 的完整判定。
     */
    if (isReadOnlyExpression(wrapped)) return { destructive: false }

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
    return { destructive: true, kind: 'delete', confidence: 'unverifiable', recursive: false, target: null }
  }

  // 不经过删除动词的构造（find -delete / rsync --delete / .Delete() / unlink …）。
  //
  // 这些写法里没有 `rm`、`del` 这类词，动词表永远匹配不到。漏掉它们就等于
  // 让一条真删除通道完全不设防 —— 而这正是"写了符号却拦截失效"那种最坏的失败。
  // 命中后仍尝试抽取目标；抽不出来就交给人类判断。
  //
  // ## 必须在**去注释后**的文本上匹配（2026-11-01 审查 SD-17）
  //
  // 第一版用 `raw`（原始命令）。于是注释和字符串里的字样也算命中：
  //
  // ```
  // # file.Delete() is an example       ← 注释，不会执行
  // const note = "file.Delete()"        ← 字符串，不会执行
  // ```
  //
  // 两者都被判 destructive=true —— 多出来的审批会让用户开始无脑点允许，
  // 那比少问一次更危险。
  //
  // 用 `stripComments(raw)` 之后的文本来匹配，与上面 `mentionsOnly` 走同一份
  // 词法处理。
  //
  // ## 为什么"抹引号内容"要分两步（2026-11-01 审查 SD-17）
  //
  // 字符串里的 `.delete()` 不会执行，而真实调用会。两者在纯文本上长得一样，
  // 只有引号状态能区分。
  //
  // 但**不能整体抹掉**：`node -e "...unlinkSync('C:\\x')"` 的删除调用就在
  // 双引号内部 —— 整体抹掉会把它当无害，那是把一个真删除放行了。
  //
  // 折中：
  //   1. 先用**原文本**匹配一遍 —— 删除字样出现在引号里也可能真的执行
  //      （`sh -c "rm x"`、`node -e "...unlink(...)"`），命中就是要人看；
  //   2. 若只在"抹掉引号内容"的版本里命中，说明那个字样纯粹在字符串里、
  //      没有任何引号外的调用形态 —— 那种才放行。
  //
  // 换句话说：**可疑就保守**。宁可多问一次，不可放过一条真删除。
  const commentFree = stripComments(raw)
  const quotedBlanked = blankQuotedContent(commentFree)

  /*
   * 判定顺序：
   *
   * 1. 先看**引号外**是否就有删除构造（`quotedBlanked`）——
   *    这是最确定的"真删除"，不受字符串干扰。
   * 2. 再看**原文本**里是否命中，但**排除执行包装器**的情况。
   *
   * 第 2 步的例外很关键：`sh -c "rm x"`、`node -e "...unlink..."` 的删除在
   * 引号内，但它**会被执行**。而 `const note = "file.Delete()"` 的同样字样
   * 只是普通字符串。两者的区别是前者有执行包装器在跑那段字符串。
   */
  /*
   * ## 容器操作不参与匹配（2026-11-02 架构调整时发现）
   *
   * `Map.delete(k)` / `Set.delete(v)` / `cache.delete(key)` 是内存操作。
   * 若直接在原文上匹配 `DELETE_PATTERNS`，`node -e 'm.delete("k")'`
   * 会被当成删除 —— 第六轮复审专门测过这类误判。
   *
   * 这里先算出"只有容器删除"的标记，命中时把容器调用从匹配文本里抹掉。
   */
  const containerOnly = isContainerDeleteOnly(commentFree)
  const containerPattern =
    /\b(?:weakmap|weakset|map|set|cache\w*|\w+map|\w+set|\w+cache|m|s|registry|store|pool|queue|list|dict|tree|index|memo)\s*\.\s*delete\s*\(/gi
  const matchSource = containerOnly ? commentFree.replace(containerPattern, ' ') : commentFree
  const matchBlanked = containerOnly ? quotedBlanked.replace(containerPattern, ' ') : quotedBlanked

  const outsideQuotesHit = DELETE_PATTERNS.find((entry) => entry.pattern.test(matchBlanked))
  const anyHit = DELETE_PATTERNS.find((entry) => entry.pattern.test(matchSource))

  /**
   * 是否在用包装器执行引号里的内容。
   *
   * `sh -c "rm x"`、`node -e "unlink(...)"`、`powershell -Command "..."` ——
   * 这些的删除字样在引号内，但**会被真的执行**。而
   * `const note = "file.Delete()"` 的同样字样只是普通字符串。
   *
   * 只看命令的第一个 token，避免把很长的脚本正文当成匹配对象。
   */
  const runsQuotedCode = (() => {
    const firstSegment = splitOutsideQuotes(commentFree)[0] ?? ''
    const segTokens = tokenize(firstSegment)
    /*
     * 逐一检查**前几个** token，而不是只看第一个。
     *
     * 为什么：含空格的路径会被 `tokenize` 拆开 ——
     * `C:\Program Files\nodejs\node.exe -e '...'` 的第一个 token 是
     * `C:\Program`，真正的命令是后面的 `node.exe`。
     *
     * 只看 `[0]` 会把这条真删除判成无害（回归实测）。
     * 检查前 4 个足够覆盖「路径 + 参数」的常见形态，又不会把
     * 很长的脚本正文当成命令头。
     */
    for (const token of segTokens.slice(0, 4)) {
      const cleaned = token.toLowerCase().replace(/^['"]|['"]$/g, '')
      const base = (cleaned.split(/[\\/]/).pop() ?? cleaned).replace(/\.(exe|com|cmd|bat)$/, '')
      if (RUNS_INLINE_CODE.has(base)) return true
    }
    return false
  })()

  const patternHit = outsideQuotesHit ?? (runsQuotedCode ? anyHit : undefined)
  if (patternHit !== undefined) {
    const recursive =
      /-delete\b/i.test(commentFree) ||
      /--del(?:ete)?\b/i.test(commentFree) ||
      /recursive\s*:\s*true/i.test(lower) ||
      RECURSIVE_FLAGS.some((flag) => tokens.includes(flag))
    return {
      destructive: true,
      kind: 'delete',
      confidence: 'identified',
      recursive,
      target: targetFromPattern(commentFree, patternHit.label),
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
      return { destructive: true, kind: 'delete', confidence: 'identified', recursive: false, target: null }
    }

    /*
     * ## 函数式调用也要认（2026-11-02 定版终审 F-03B）
     *
     * `containsDeleteCommand` 只看**命令位**的动词。而
     * `require("fs").rmSync("x")` 里没有命令位动词 —— `tokenize` 把
     * `require("fs").rmSync` 粘成一个 token，于是这里判成无害。
     *
     * 实测（修复前）：
     *
     * ```
     * fs.rmSync("x")                  → true
     * require("fs").rmSync("x")       → false   ← 漏
     * ```
     *
     * 两者会被真的执行，判据不该因为前面多了个 `require(...)` 就变。
     * 用与 `isPlainlyHarmless` 相同的 `hasCallStyleDelete`，
     * 且同样先抹掉字符串字面量再匹配。
     *
     * ## 容器操作要排除
     *
     * `Map.delete(k)` / `cache.delete(key)` 是内存操作。若这里不排除，
     * `node -e 'm.delete("k")'` 会被当成删除（第六轮复审测过）。
     */
    if (!isContainerDeleteOnly(text) && hasCallStyleDelete(blankQuotedContent(text))) {
      return { destructive: true, kind: 'delete', confidence: 'identified', recursive: false, target: null }
    }

    /*
     * ## 双引号包裹的命令替换（2026-11-02 定版验收，P1）
     *
     * `result="$(![]...)"` 这类写法里，删除在**双引号内部**。上面的
     * `blankQuotedContent` 会把双引号里的内容抹成空格，于是：
     *
     * ```
     * result="$(fs.rmSync("x"))"    ← 抹掉后 `.rmSync(` 消失
     * result="$(find /tmp -delete)" ← 同上
     * ```
     *
     * 而 Bash 的双引号**不抑制**命令替换 —— 它们是会执行的。
     *
     * 这里改用 `commandSubstitutions`：它按 shell 规则提取 `$(…)` 与反引号
     * 内容（单引号内的不提取），提取出来的每段都真的会被执行，用原文本判。
     */
    for (const substitution of commandSubstitutions(text)) {
      if (containsDeleteCommand(substitution)) {
        return { destructive: true, kind: 'delete', confidence: 'identified', recursive: false, target: null }
      }
      if (tokenize(substitution).some((t) => isDeleteArgumentMarker(t))) {
        return { destructive: true, kind: 'delete', confidence: 'identified', recursive: false, target: null }
      }
      if (hasCallStyleDelete(blankQuotedContent(substitution))) {
        return { destructive: true, kind: 'delete', confidence: 'identified', recursive: false, target: null }
      }
    }

    /*
     * ## 逐段递归判定（2026-11-01 定版复核第 6 项）
     *
     * `containsDeleteCommand` 只在**整串以包装器开头**时解包，而
     * `echo ready; sh -c "rm -rf /tmp/x"` 的包装器在第二段。
     *
     * `unwrapExecutedCommand` 也不认 `node -e` / `python -c` 这类
     * （它的正则只覆盖 shell 包装器），所以手写解包总会漏一种。
     *
     * 这里直接对该段再调一次 `parseCommand` —— 段内不含顶层分隔符，
     * 所以它的兜底循环里 `slice(1)` 为空，不会无限递归。好处是**复用全部
     * 既有判定**（包装器解包、`node -e`、不透明执行、参数级删除等），
     * 不再有"第二套缩水规则"。
     */
    /*
     * ## 兜底：不能证明无害就要求审批（2026-11-02 架构调整）
     *
     * 这里原来是 `return { destructive: false }` —— 整个五轮复审的根因。
     *
     * "没找到删除证据"和"证明不会删除"是两件事。旧的默认值把它们混为一谈，
     * 于是任何我没预料到的写法都自动放行，而写法是无穷的：
     * `awk system()`、`busybox rm`、`xargs sh -c`、base64 管道…
     *
     * 现在：走到兜底说明既没识别出删除、也没能正向证明无害 ——
     * 那是**未知**，未知必须问人。
     *
     * 判据用 `provenHarmless`（逐段正向证明）。能证明的放行，
     * 其余标为 `unverifiable` 交给审批，并在审计里写明原因。
     *
     * ## 但执行包装器要先看**内容**（开发高频写法）
     *
     * `node -e 'console.log(1)'` / `python -c 'print(1)'` / `sh -c 'echo hi'`
     * 是每天都在用的写法。它们"能执行任意代码"所以不能整体进白名单，
     * 但内容明显无害时不该弹卡 —— 否则审批疲劳会让保护失效。
     *
     * 所以先解包：内层用同样的正向证明判断。`node -e 'fs.rmSync(\'x\')'`
     * 的内层会被认出删除，照样拦。
     */
    for (const segment of splitOutsideQuotes(text)) {
      const inner = unwrapExecutedCommand(segment)
      if (inner !== null && provenHarmless(inner)) continue
      /*
       * `-p` / `--print` 的内层是**表达式**，不是命令：
       * `node -p 'process.version'` 里 `process.version` 不是命令名，
       * 因此 `provenHarmless` 会判它"主命令不在白名单"。
       *
       * 表达式另用一条判据：只要不含任何删除痕迹就放行。
       * `node -p 'require("fs").rmSync("x")'` 会被这条挡住。
       */
      if (inner !== null && isReadOnlyExpression(inner)) continue
      if (provenHarmless(segment)) continue
      /*
       * ## 这里是 `unverifiable`，不是"认出删除"（2026-11-10 回归修复）
       *
       * 走到这里说明既没认出删除、也没能证明无害。它必须仍然返回
       * `destructive: true`（`ask` 下要问人），但可信度是 `unverifiable` ——
       * 否则 `never` 策略会把 `Get-Process vivado`、`launch_rebuild.bat`
       * 这类正常调用全部拒绝。
       */
      return {
        destructive: true,
        kind: 'delete',
        confidence: 'unverifiable',
        recursive: RECURSIVE_FLAGS.some((flag) => tokens.includes(flag)),
        target: targetFromPattern(text, 'unverifiable command') ?? null,
      }
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
    return { destructive: true, kind: 'delete', confidence: 'identified', recursive, target: callTarget }
  }

  return {
    destructive: true,
    kind: 'delete',
    confidence: 'identified',
    recursive,
    target: targetAfterVerb(tokens, verbIndex, text),
  }
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