/**
 * 用真实命令做一次分类抽查（不进测试套件，手工跑）。
 *
 * 目的：确认 `parseCommand` + `classifyPath` 在**你机器上真实出现过的命令**上
 * 给出正确结论 —— 这些命令来自 dsh-safety 的 journal 里被拦截的真实样本。
 */
import { classifyPath } from '../src/classify'
import { parseCommand } from '../src/command'

const home = process.env.USERPROFILE ?? 'C:\\Users\\alice'
const env = { home, workdir: process.cwd(), dshHome: `${home}\\.dsh` }

const samples = [
  // 来自 dsh-safety journal 的真实被拦命令形态
  'Remove-Item -Recurse $env:TEMP\\staging',
  'Remove-Item -Recurse $tmp',
  'Remove-Item -Recurse $_.FullName',
  'Remove-Item -Recurse $p',
  // 正常读命令，绝不该被拦
  'Get-ChildItem C:\\Work',
  'Get-Item C:\\Work\\form.txt',
  'echo "removable disk"',
  // 真实删除
  'Remove-Item -Recurse C:\\Work\\proj\\build',
  'Remove-Item C:\\my-report',
  'rm -rf /tmp/x',
  `Remove-Item -Recurse ${home}\\.dsh\\profiles\\desktop\\package.json`,
]

for (const command of samples) {
  const verdict = parseCommand(command)
  if (!verdict.destructive) {
    console.log(`ALLOW   ${command}`)
    continue
  }
  if (verdict.target === null) {
    console.log(`ASK     ${command}  -> target unresolvable (card shown)`)
    continue
  }
  const cls = classifyPath(verdict.target, env)
  console.log(`DENY    ${command}  -> ${cls} / recursive=${verdict.recursive}`)
}
