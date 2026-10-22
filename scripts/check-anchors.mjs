/**
 * 检查 Markdown 里的锚点链接是否指向真实存在的标题。
 *
 * 为什么需要：这个规则文件靠锚点导航，而手写锚点极易和实际标题对不上
 * （GitHub 的锚点规则是「小写、空格转连字符、去掉大部分标点」）。
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'dsh-plugin-development-rules.md'
const text = readFileSync(path, 'utf8')

/** 按 GitHub 的规则把标题转成锚点。 */
function slugOf(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // 去掉非字母数字、非空白、非连字符
    .replace(/\s+/g, '-')
}

const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].trim())
const anchors = new Set(headings.map(slugOf))

// 收集所有 [text](#anchor) 形式的链接
const links = [...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1])

let broken = 0
const seen = new Set()
for (const link of links) {
  if (seen.has(link)) continue
  seen.add(link)
  if (!anchors.has(link)) {
    broken += 1
    console.log(`✗ #${link}  — 没有对应标题`)
  }
}

console.log(`\n标题 ${headings.length} 个，锚点链接 ${seen.size} 个，断链 ${broken} 个`)
if (broken === 0) console.log('全部锚点都能跳转。')
process.exitCode = broken === 0 ? 0 : 1
