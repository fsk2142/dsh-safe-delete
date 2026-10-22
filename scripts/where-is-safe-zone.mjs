/**
 * 打印插件解析出的默认安全区位置，以及它落在哪个磁盘卷上。
 *
 * 为什么值得单独看：安全区与目标在**不同卷**时 `rename` 会失败（EXDEV），
 * 默认行为是拒绝而不是偷偷复制。所以"默认放在哪"直接决定你删东西时会不会失败。
 */
import os from 'node:os'
import path from 'node:path'

const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
  ? path.resolve(process.env.DSH_HOME)
  : path.join(os.homedir(), '.dsh')

const stateDir = path.join(dshHome, '.dsh-safe-delete')
const tmp = os.tmpdir()
const workdir = process.cwd()

/** 取路径所在的卷（Windows 用盘符，POSIX 用根）。 */
function volumeOf(p) {
  const parsed = path.parse(path.resolve(p))
  return parsed.root.toUpperCase()
}

console.log('=== dsh-safe-delete 默认位置 ===')
console.log(`DSH_HOME        ${dshHome}`)
console.log(`安全区          ${stateDir}`)
console.log(`  卷            ${volumeOf(stateDir)}`)
console.log('')
console.log('=== 实际会发生什么 ===')
console.log(`工作区          ${workdir}  (卷 ${volumeOf(workdir)})`)
console.log(`临时目录        ${tmp}  (卷 ${volumeOf(tmp)})`)
console.log('')
const vs = volumeOf(stateDir)
for (const [label, p] of [['工作区', workdir], ['临时目录', tmp]]) {
  const same = volumeOf(p) === vs
  console.log(`${label}删除：${same ? '同卷 → rename，瞬间完成' : '跨卷 → 默认拒绝（需配置 crossVolumeCopy）'}`)
}
