import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { scratchDir } from './support/tmpdir'

/**
 * 跨代清理锁。
 *
 * ## 守的是什么
 *
 * 清理是异步的（每条目一次 PowerShell，可达 20 秒），`apply` 不等待它。
 * 如果清理期间用户又改配置，HMR 会重建插件模块——新实例的 `serialized()` 队列
 * 与旧实例那条**互不互斥**，于是两代可能并发写索引，丢记录。
 *
 * 模块变量扛不过重载，所以锁必须在文件系统上。这里测的是它的语义：
 *
 *   - 独占创建（第二次必然失败）
 *   - 释放后可再次获取
 *   - 过期锁可被接管（上次进程崩溃留下的）
 */

const CLEAN_LOCK = 'clean.lock'
const STALE_MS = 5 * 60 * 1000

/**
 * 复现 index.ts 的获取语义。
 *
 * @param stateDir 状态目录。
 * @returns 释放函数或 undefined。
 */
async function acquire(stateDir: string): Promise<(() => void) | undefined> {
  const lockPath = join(stateDir, CLEAN_LOCK)
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(lockPath, '{}', { encoding: 'utf8', flag: 'wx' })
    return () => {
      try {
        require('node:fs').rmSync(lockPath, { force: true })
      } catch {
        /* ignore */
      }
    }
  } catch {
    try {
      const stat = statSync(lockPath)
      if (Date.now() - stat.mtimeMs > STALE_MS) {
        writeFileSync(lockPath, '{}', 'utf8')
        return () => {
          try {
            require('node:fs').rmSync(lockPath, { force: true })
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* 锁在检查途中消失 */
    }
    return undefined
  }
}

describe('cross-generation clean lock', () => {
  it('is exclusive: a second acquire fails while held', async () => {
    const dir = scratchDir('dsd-lock-')
    const first = await acquire(dir)
    expect(first, '第一次应拿到锁').toBeDefined()

    const second = await acquire(dir)
    expect(second, '持锁期间第二次必须失败').toBeUndefined()

    first?.()
  })

  it('can be acquired again after release', async () => {
    const dir = scratchDir('dsd-lock2-')
    const first = await acquire(dir)
    first?.()
    expect(existsSync(join(dir, CLEAN_LOCK)), '释放后锁文件应消失').toBe(false)

    const second = await acquire(dir)
    expect(second, '释放后应能再次获取').toBeDefined()
    second?.()
  })

  it('takes over a stale lock left by a crashed generation', async () => {
    const dir = scratchDir('dsd-lock3-')
    mkdirSync(dir, { recursive: true })
    const lockPath = join(dir, CLEAN_LOCK)
    writeFileSync(lockPath, '{"pid":99999}', 'utf8')

    // 把 mtime 推到 10 分钟前 —— 超过 5 分钟阈值。
    const old = new Date(Date.now() - 10 * 60 * 1000)
    utimesSync(lockPath, old, old)

    const taken = await acquire(dir)
    expect(taken, '过期锁应被接管，而不是永久卡死').toBeDefined()
    taken?.()
  })

  it('does not take over a fresh lock', async () => {
    const dir = scratchDir('dsd-lock4-')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, CLEAN_LOCK), '{"pid":1}', 'utf8')

    const taken = await acquire(dir)
    expect(taken, '未过期的锁不能被抢').toBeUndefined()
  })
})
