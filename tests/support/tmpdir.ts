/**
 * 测试用的临时目录夹具。
 *
 * 每个测试都要自己收尾 —— 否则一次全量测试会在系统临时目录里留下上百个
 * dsd-* 残留（实测一次泄漏 111 个）。用 `afterEach` 统一清理。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach } from 'vitest'

const created: string[] = []

/** 建一个自动回收的临时目录。 */
export function scratchDir(prefix = 'dsd-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir === undefined) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 被占用时跳过，不因为清理失败而让测试变红 */
    }
  }
})
