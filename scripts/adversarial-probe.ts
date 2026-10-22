/**
 * 对抗性探测：专门找"该拦却没拦"的漏洞。
 *
 * 这份脚本的价值不在于全部通过，而在于**列清楚已知的边界**。
 * 每一项 `KNOWN_GAP` 都是一份明示的已知限制，而不是假装它不存在。
 */
import { parseCommand } from '../src/command'
import { classifyPath } from '../src/classify'
import os from 'node:os'
import path from 'node:path'

const home = os.homedir()
const env = { home, workdir: process.cwd(), dshHome: path.join(home, '.dsh') }

type Expect = 'BLOCK' | 'ASK' | 'KNOWN_GAP'

interface Probe {
  label: string
  text: string
  expect: Expect
}

const probes: Probe[] = [
  // 基本形态
  { label: 'Remove-Item -Recurse', text: 'Remove-Item -Recurse C:\\x', expect: 'BLOCK' },
  { label: 'rm -rf', text: 'rm -rf /tmp/x', expect: 'BLOCK' },
  { label: 'rd /s', text: 'rd /s C:\\x', expect: 'BLOCK' },
  { label: 'del /s', text: 'del /s C:\\x', expect: 'BLOCK' },
  { label: 'rmdir /s', text: 'rmdir /s C:\\x', expect: 'BLOCK' },
  { label: 'fs.rmSync', text: "fs.rmSync('C:\\\\x',{recursive:true})", expect: 'BLOCK' },
  { label: 'shutil.rmtree', text: "shutil.rmtree('/tmp/x')", expect: 'BLOCK' },

  // 转义 / 拼接
  { label: 'r\\m', text: 'r\\m -rf /tmp/x', expect: 'BLOCK' },
  { label: 'r""m', text: 'r""m -rf /tmp/x', expect: 'BLOCK' },
  { label: "r''m", text: "r''m -rf /tmp/x", expect: 'BLOCK' },
  { label: '^rm', text: '^rm -rf /tmp/x', expect: 'BLOCK' },
  { label: '\\rm（行首）', text: '\\rm -rf /tmp/x', expect: 'BLOCK' },

  // 别名
  { label: 'ri（Remove-Item 别名）', text: 'ri -Recurse C:\\x', expect: 'BLOCK' },
  { label: 'erase', text: 'erase C:\\x', expect: 'BLOCK' },

  // 包裹
  { label: 'cmd /c', text: 'cmd /c "rd /s /q C:\\x"', expect: 'BLOCK' },
  { label: 'Invoke-Expression', text: 'Invoke-Expression "Remove-Item -Recurse C:\\x"', expect: 'BLOCK' },
  { label: 'sh -c', text: "sh -c 'rm -rf /tmp/x'", expect: 'BLOCK' },

  // 看不清 → 必须 ASK（不是放行）
  { label: '$tmp 变量', text: 'Remove-Item -Recurse $tmp', expect: 'ASK' },
  { label: '$env:TEMP', text: 'Remove-Item -Recurse $env:TEMP\\x', expect: 'ASK' },
  { label: '管道', text: 'Get-ChildItem | Remove-Item -Recurse', expect: 'ASK' },
  { label: '通配 *', text: 'Remove-Item -Recurse *', expect: 'ASK' },
  { label: 'Base64 编码', text: 'powershell -EncodedCommand UgBlAG0AbwB2AGU=', expect: 'ASK' },

  // ── 已知边界：静态不可判的构造（明示限制，靠人工把关） ──
  { label: 'find -delete', text: 'find /tmp -name "*.log" -delete', expect: 'BLOCK' },
  { label: 'rsync --delete', text: 'rsync -a --delete src/ dst/', expect: 'BLOCK' },
  { label: 'perl unlink', text: "perl -e 'unlink q(/tmp/x)'", expect: 'ASK' },
  { label: 'PowerShell .Delete() 方法', text: '(Get-Item C:\\x).Delete()', expect: 'ASK' },
  { label: '环境变量拼接构造命令（静态不可判）', text: '$c = "Re" + "move-Item"; & $c -Recurse C:\\x', expect: 'KNOWN_GAP' },
]

let block = 0
let ask = 0
let gapFound = 0
let unexpected = 0

const rows: string[] = []

for (const p of probes) {
  const v = parseCommand(p.text)
  let actual: 'BLOCK' | 'ASK' | 'ALLOW'
  if (!v.destructive) actual = 'ALLOW'
  else if (v.target === null) actual = 'ASK'
  else {
    void classifyPath(v.target, env)
    actual = 'BLOCK'
  }

  let verdict: string
  if (actual === 'BLOCK') { block += 1; verdict = p.expect === 'BLOCK' ? 'ok' : 'UNEXPECTED' }
  else if (actual === 'ASK') { ask += 1; verdict = p.expect === 'ASK' ? 'ok' : 'UNEXPECTED' }
  else { verdict = p.expect === 'KNOWN_GAP' ? 'known-gap' : 'UNEXPECTED' }

  if (verdict === 'known-gap') gapFound += 1
  if (verdict === 'UNEXPECTED') unexpected += 1
  rows.push(`${verdict.padEnd(11)} ${p.label.padEnd(28)} ${actual}`)
}

console.log(rows.join('\n'))
console.log('')
console.log(`拦下 ${block} · 问人 ${ask} · 已知边界 ${gapFound} · 意外 ${unexpected}`)
console.log('')
console.log('已知边界说明（这些写法当前不做静态识别，属于明示的限制）：')
for (const p of probes.filter((x) => x.expect === 'KNOWN_GAP')) {
  console.log(`  - ${p.label}: ${p.text}`)
}

process.exitCode = unexpected === 0 ? 0 : 1
