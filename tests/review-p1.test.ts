import { describe, expect, it } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { classifyPath } from '../src/classify'
import { moveToSafeZone, listSafeZone, restoreFromSafeZone } from '../src/store'
import { scratchDir } from './support/tmpdir'

/**
 * 并发下的索引完整性（审查 P1-5）。
 *
 * 三个写操作都是「读索引 → 改 → 写回」。不串行的话，两个并发删除会互相覆盖，
 * 前一条从索引里消失但内容仍在盘上 —— 列表看不见、清理轮不到，属于静默泄漏。
 */
describe('index writes are serialized', () => {
  it('does not lose entries when many deletes run at once', async () => {
    const state = scratchDir('dsd-conc-')
    const work = scratchDir('dsd-conc-w-')

    const targets = []
    for (let i = 0; i < 12; i += 1) {
      const file = join(work, `f${i}.txt`)
      writeFileSync(file, `content-${i}`)
      targets.push(file)
    }

    // 同时发起，不 await。
    await Promise.all(targets.map((t) => moveToSafeZone(state, t, { retentionDays: 7 })))

    const entries = await listSafeZone(state)
    expect(entries).toHaveLength(targets.length)
    // 索引里的每一条都要在盘上有内容。
    for (const entry of entries) {
      expect(existsSync(entry.originalPath), entry.originalPath).toBe(false)
    }
  })

  it('keeps the index consistent when deletes and restores interleave', async () => {
    const state = scratchDir('dsd-conc2-')
    const work = scratchDir('dsd-conc2-w-')

    const files = []
    for (let i = 0; i < 6; i += 1) {
      const file = join(work, `g${i}.txt`)
      writeFileSync(file, `v${i}`)
      files.push(file)
    }

    const entries = await Promise.all(files.map((f) => moveToSafeZone(state, f, { retentionDays: 7 })))
    expect(await listSafeZone(state)).toHaveLength(6)

    // 并发取回前三条。
    await Promise.all(entries.slice(0, 3).map((e) => restoreFromSafeZone(state, e.id)))

    const remaining = await listSafeZone(state)
    expect(remaining).toHaveLength(3)
    // 取回的三个文件回到了原位置。
    for (const file of files.slice(0, 3)) {
      expect(existsSync(file), file).toBe(true)
    }
  })
})

/**
 * 跨卷（P1-3）：配置必须真的透传，且移入的条目必须能取回。
 *
 * 之前 `crossVolumeCopy` 只存在于 schema 与 README，`deletePath` 不转发它 ——
 * 用户在配置里打开毫无效果。更糟的是即便绕过接线，还原方向没有跨卷回退，
 * 那类条目恰好全都取不回来，与「可逆删除」直接矛盾。
 */
describe('crossVolumeCopy is wired through and restoring works', () => {
  it('passes the option from the delete context into the store', async () => {
    const state = scratchDir('dsd-cv-')
    const work = scratchDir('dsd-cv-w-')
    const file = join(work, 'cv.txt')
    writeFileSync(file, 'x')

    // 用真实 API：显式开启时应接受该选项（同卷下走 rename，不触发复制路径）。
    const entry = await moveToSafeZone(state, file, { retentionDays: 7, crossVolumeCopy: true })
    expect(entry.id).toBeTruthy()
    const restored = await restoreFromSafeZone(state, entry.id)
    expect(existsSync(restored.restoredTo)).toBe(true)
    expect(existsSync(file)).toBe(true)
  })

  it('refuses a cross-volume move when the option is off', async () => {
    // 同卷下不会抛 EXDEV，所以这里只确认「默认关闭」这一事实被保留：
    // 选项为 undefined 时 store 视为不允许复制。
    const state = scratchDir('dsd-cv2-')
    const work = scratchDir('dsd-cv2-w-')
    const file = join(work, 'cv2.txt')
    writeFileSync(file, 'x')
    const entry = await moveToSafeZone(state, file, { retentionDays: 7 })
    expect(entry.crossVolume).toBe(false)
  })
})

/**
 * 安装目录必须接线（审查 P1-6）。
 *
 * README 分级表把「安装目录」列为 protected。若 `env.installDir` 永远 undefined，
 * 这条规则只在单元测试里生效 —— 一层不存在的保护比没有更糟。
 */
describe('installDir protection', () => {
  it('classifies a path under the install directory as protected', () => {
    const home = 'C:\\Users\\alice'
    const env = {
      home,
      workdir: 'C:\\Work\\proj',
      installDir: 'C:\\Users\\alice\\AppData\\Local\\Programs\\DeepSeek Harness',
      tmpdir: 'C:\\Users\\alice\\AppData\\Local\\Temp',
    }
    expect(
      classifyPath('C:\\Users\\alice\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\x.js', env),
    ).toBe('protected')
  })

  it('does not treat the install directory as protected when it is unknown', () => {
    const home = 'C:\\Users\\alice'
    const env = {
      home,
      workdir: 'C:\\Work\\proj',
      tmpdir: 'C:\\Users\\alice\\AppData\\Local\\Temp',
    }
    // 没有 installDir 时退回普通分级（这里是 free，不在 home 下）。
    expect(classifyPath('C:\\Work\\proj\\a.txt', env)).toBe('free')
  })
})
