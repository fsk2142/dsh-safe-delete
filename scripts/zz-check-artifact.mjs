/** 确认发布产物的 inject 形状正确。 */
import { readFileSync } from 'node:fs'

const s = readFileSync('lib/client.js', 'utf8')
const m = /const inject = \[([^\]]*)\]/.exec(s)
console.log('顶层 inject:', m ? m[1].replace(/\s+/g, ' ') : '未找到')

const remoteRequest = /\["remote",\s*"remote\.settings"\]/.test(s) || s.includes('remote", "remote.settings')
console.log('ctx.inject 同时请求 remote + remote.settings:', remoteRequest)

const configRequest = s.includes('["configForms"]')
console.log('ctx.inject 请求 configForms:', configRequest)

// 渲染路径里不应有代码级的 ctx.remote 访问（注释里有是正常的）
const codeLines = s.split('\n').filter((line) => {
  const t = line.trim()
  return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
})
const bareAccess = codeLines.filter((line) => line.includes('ctx.remote'))
console.log('代码级 ctx.remote 访问:', bareAccess.length === 0 ? '无' : bareAccess)
