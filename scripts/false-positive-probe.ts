/**
 * 误伤检查：新增的删除模式会不会把正常操作当成删除？
 *
 * 这是上一个探测的反面。拦得太松是漏洞，拦得太紧是骚扰 —— 两者都要测。
 */
import { parseCommand } from '../src/command'

interface Case {
  label: string
  text: string
  expect: 'not-destructive' | 'destructive'
}

const cases: Case[] = [
  // 这些只是"看起来像"，不是删除。
  { label: '对象字面量 delete 键', text: 'const cfg = { delete: true }', expect: 'not-destructive' },
  { label: 'TypeScript delete 运算符', text: 'delete obj.key', expect: 'not-destructive' },
  { label: '字符串里提到 unlink', text: 'console.log("call unlink to remove")', expect: 'not-destructive' },
  { label: '注释里提到 rm -rf', text: '// never run rm -rf here', expect: 'not-destructive' },
  { label: '测试名里含 delete', text: "test('deletes files', () => {})", expect: 'not-destructive' },
  { label: 'git 命令含 delete', text: 'git branch --delete old-branch', expect: 'not-destructive' },
  { label: 'find 只列不删', text: 'find /tmp -name "*.log"', expect: 'not-destructive' },
  { label: 'rsync 不带 --delete', text: 'rsync -a src/ dst/', expect: 'not-destructive' },
  { label: '读文件内容含 delete', text: 'Get-Content README.md', expect: 'not-destructive' },
  { label: 'npm 脚本名含 clean', text: 'npm run clean', expect: 'not-destructive' },
  { label: 'grep 搜 rm', text: 'grep -rn "rm -rf" docs/', expect: 'not-destructive' },
  { label: 'echo 打印删除命令', text: 'echo upgrade-guide.md', expect: 'not-destructive' },

  // 这些确实是删除，必须识别。
  { label: 'find -delete', text: 'find /tmp -name "*.log" -delete', expect: 'destructive' },
  { label: 'rsync --delete', text: 'rsync -a --delete src/ dst/', expect: 'destructive' },
  { label: '.Delete()', text: 'file.Delete()', expect: 'destructive' },
  { label: 'Get-Item .Delete()', text: '(Get-Item C:\\x).Delete()', expect: 'destructive' },
  { label: '.unlinkSync()', text: 'await fs.unlinkSync(p)', expect: 'destructive' },
  { label: '.rmdir()', text: 'fs.rmdir(p)', expect: 'destructive' },
  { label: 'Map.delete() 不是文件删除', text: 'map.delete("key")', expect: 'not-destructive' },
]

let failures = 0
for (const c of cases) {
  const v = parseCommand(c.text)
  const actual = v.destructive ? 'destructive' : 'not-destructive'
  const ok = actual === c.expect
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.label.padEnd(26)} 期望=${c.expect.padEnd(15)} 实际=${actual}`)
}

console.log('')
console.log(failures === 0 ? '没有误伤。' : `${failures} 处需要处理。`)
process.exitCode = failures === 0 ? 0 : 1
