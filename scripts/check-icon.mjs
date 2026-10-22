/**
 * 对 icon.svg 做结构校验：元素是否越出 viewBox、是否用了不支持的特性。
 * 无法代替人眼审美，但能挡住"画到画布外面"这类硬错误。
 */
import { readFileSync } from 'node:fs'

const path = '<repo>\\icon.svg'
const svg = readFileSync(path, 'utf8')

const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1]
console.log(`viewBox: ${viewBox}`)

// 收集所有坐标性属性，检查是否落在画布之外
const nums = [...svg.matchAll(/\b(?:d|x|y|cx|cy|rx|ry|width|height|r)="([^"]*)"/g)]
const outside = []
for (const m of nums) {
  for (const token of m[1].matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(token[0])
    if (v < -200 || v > 1300) outside.push(`${m[0].slice(0, 40)} -> ${v}`)
  }
}
console.log(`越界值: ${outside.length}`)
for (const item of outside.slice(0, 10)) console.log(`  ${item}`)

// 检查是否有外部引用（图标必须自包含）
const external = [...svg.matchAll(/(?:href|src)="(?!#)([^"]+)"/g)].map((m) => m[1])
console.log(`外部引用: ${external.length === 0 ? '无（自包含）' : external.join(', ')}`)

// 检查 script / foreignObject 等不安全元素
const unsafe = ['<script', '<foreignObject', 'onload=', 'javascript:'].filter((s) => svg.includes(s))
console.log(`不安全元素: ${unsafe.length === 0 ? '无' : unsafe.join(', ')}`)

// 统计
console.log(`大小: ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB`)
console.log(`<g> 分组: ${(svg.match(/<g[\s>]/g) || []).length}`)
console.log(`渐变定义: ${(svg.match(/<linearGradient/g) || []).length}`)
