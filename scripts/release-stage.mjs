import { execFileSync } from 'node:child_process'

/**
 * 只暂存发版脚本真正生成的两类文件。
 *
 * 不能用 `git add -A`：工作树里的 `.probe.*`、`.state/`、本地笔记都会被
 * 顺手带进提交，已经真实发生过。源码改动应由发版前的功能提交负责。
 */
export function stageReleaseFiles() {
  execFileSync('git', ['add', '--', 'package.json', 'lib'], { stdio: 'inherit' })
}
