/**
 * 从 GitHub API 逐个拉取远端文件内容，检查是否含个人信息。
 *
 * 为什么不在本地判断：本地干净不等于远端干净。只有拉取真实数据才作数。
 */
import { execFileSync } from 'node:child_process'

const repo = 'fsk2142/dsh-safe-delete'
const token = execFileSync(
  'powershell',
  ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('GITHUB_TOKEN','User')"],
  { encoding: 'utf8' },
).trim()

if (token === '') {
  console.error('GITHUB_TOKEN not found')
  process.exit(1)
}

const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}

const tree = await api(`/repos/${repo}/git/trees/main?recursive=1`)
const blobs = tree.tree.filter((n) => n.type === 'blob')
console.log(`远端文件：${blobs.length}\n`)

const PATTERNS = [
  ['本机用户名', /FSK|fsk21/],
  ['对话痕迹', /用户原话|用户报障|用户说[：:]|经用户确认/],
  ['凭据', /ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}/],
  ['会话标识', /session-[0-9a-f]{8}-[0-9a-f]{4}|dsh-spill/],
]

let leaks = 0
let checked = 0

for (const node of blobs) {
  if (/\.(png|jpg|jpeg|svg|woff2?)$/i.test(node.path)) continue
  // 本文件与隐私审计脚本都内嵌了检测规则（规则不是泄露），跳过它们。
  if (node.path === 'scripts/privacy-audit.mjs' || node.path === 'scripts/verify-remote.mjs') continue

  const data = await api(`/repos/${repo}/git/blobs/${node.sha}`)
  const text = Buffer.from(data.content, 'base64').toString('utf8')
  checked += 1

  for (const [label, pattern] of PATTERNS) {
    if (pattern.test(text)) {
      const lines = text.split('\n')
      const hit = lines.findIndex((l) => pattern.test(l))
      console.log(`[LEAK] ${node.path}:${hit + 1} (${label})  ${lines[hit]?.trim().slice(0, 90)}`)
      leaks += 1
    }
  }
}

console.log(`\n已检查 ${checked} 个文本文件，泄露 ${leaks} 处`)

// 顺带核对提交信息
const commits = await api(`/repos/${repo}/commits?per_page=100`)
console.log(`提交数：${commits.length}`)
let msgLeaks = 0
for (const c of commits) {
  for (const [label, pattern] of PATTERNS) {
    if (pattern.test(c.commit.message)) {
      console.log(`[LEAK] commit ${c.sha.slice(0, 7)} (${label})`)
      msgLeaks += 1
    }
  }
}
console.log(`提交信息泄露：${msgLeaks} 处`)

process.exitCode = leaks === 0 && msgLeaks === 0 ? 0 : 1
