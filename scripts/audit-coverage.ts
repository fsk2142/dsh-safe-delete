/**
 * 覆盖度核对：用真实威胁样本探测当前实现的行为。
 *
 * 这不是测试套件的一部分 —— 它是"我以为的防线"与"实际防线"的对账表。
 */
import { classifyPath } from '../src/classify'
import { parseCommand } from '../src/command'

const home = process.env.USERPROFILE ?? 'C:\\Users\\alice'
const env = { home, workdir: process.cwd(), dshHome: `${home}\\.dsh` }

interface Probe {
  label: string
  text: string
  expectation: 'BLOCK' | 'ASK' | 'ALLOW'
}

const probes: Probe[] = [
  // ── 基本形态 ──
  { label: 'PowerShell 递归删除', text: 'Remove-Item -Recurse -Force C:\\Work\\x', expectation: 'BLOCK' },
  { label: 'POSIX rm -rf', text: 'rm -rf /tmp/x', expectation: 'BLOCK' },
  { label: 'rd /s', text: 'rd /s /q C:\\Work\\x', expectation: 'BLOCK' },
  { label: 'node fs.rmSync', text: "fs.rmSync('C:\\\\x', { recursive: true })", expectation: 'BLOCK' },
  { label: 'python shutil.rmtree', text: "shutil.rmtree('/tmp/x')", expectation: 'BLOCK' },

  // ── 变量引用 ──
  { label: '变量目标 $tmp', text: 'Remove-Item -Recurse $tmp', expectation: 'ASK' },
  { label: '环境变量 $env:TEMP', text: 'Remove-Item -Recurse $env:TEMP\\x', expectation: 'ASK' },

  // ── 绕过尝试：转义 ──
  { label: '反斜杠转义 rm', text: 'r\\m -rf /tmp/x', expectation: 'BLOCK' },
  { label: '字符串拼接 rm', text: 'r""m -rf /tmp/x', expectation: 'BLOCK' },
  { label: 'cmd 转义符', text: '^rm -rf /tmp/x', expectation: 'BLOCK' },

  // ── 绕过尝试：别名 / 全路径 ──
  { label: 'Remove-Item 别名 ri', text: 'ri -Recurse C:\\Work\\x', expectation: 'BLOCK' },
  { label: '全路径 Remove-Item', text: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command "Remove-Item -Recurse C:\\Work\\x"', expectation: 'BLOCK' },

  // ── 绕过尝试：编码 ──
  { label: 'Base64 编码命令', text: 'powershell -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtACAALQBSAGUAYwB1AHIAcwBlACAAQwA6AFwAVwBvAHIAawBcAHgA', expectation: 'BLOCK' },

  // ── 绕过尝试：间接执行 ──
  { label: 'cmd /c 包裹', text: 'cmd /c "rd /s /q C:\\Work\\x"', expectation: 'BLOCK' },
  { label: 'Invoke-Expression', text: 'Invoke-Expression "Remove-Item -Recurse C:\\Work\\x"', expectation: 'BLOCK' },

  // ── 正常命令，必须放行 ──
  { label: '读目录', text: 'Get-ChildItem C:\\Work', expectation: 'ALLOW' },
  { label: '读文件', text: 'Get-Content C:\\Work\\a.txt', expectation: 'ALLOW' },
  { label: '构建', text: 'npm run build', expectation: 'ALLOW' },
  { label: 'git status', text: 'git status', expectation: 'ALLOW' },
]

let pass = 0
let fail = 0
let gap = 0

for (const probe of probes) {
  const verdict = parseCommand(probe.text)
  let actual: 'BLOCK' | 'ASK' | 'ALLOW'
  if (!verdict.destructive) actual = 'ALLOW'
  else if (verdict.target === null) actual = 'ASK'
  else {
    const cls = classifyPath(verdict.target, env)
    actual = 'BLOCK'
    void cls
  }

  const ok = actual === probe.expectation
  if (ok) pass += 1
  else {
    fail += 1
    // ALLOW 该拦的是真漏洞；其余是行为差异
    if (actual === 'ALLOW' && probe.expectation !== 'ALLOW') gap += 1
  }
  const mark = ok ? 'ok  ' : 'DIFF'
  console.log(`${mark}  ${probe.label.padEnd(24)} 期望=${probe.expectation.padEnd(5)} 实际=${actual}`)
}

console.log(`\n通过 ${pass} / 差异 ${fail}（其中"该拦却放行" ${gap} 项）`)
