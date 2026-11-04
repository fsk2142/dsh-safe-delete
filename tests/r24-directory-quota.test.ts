/*
 * R24-9 回归（2026-11-04 第 24 次审查）：目录超配额必须能被发现。
 *
 * ## 问题
 *
 * 回收站模式下 `stats:false` 跳过递归统计，目录的 `bytes` 恒为 0 ——
 * 而配额判定用的正是 `bytes`。于是**目录超配额永远不触发预警**，
 * 可目录恰恰最容易超（几个 G 的构建产物目录很常见）。
 *
 * ## 修法
 *
 * 不递归，但至少量**顶层直接子项**：O(顶层数)，通常几十个，可忽略。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { describeTarget, shallowBytes } from '../src/describe'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-r249-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('shallowBytes', () => {
  it('累计顶层文件的大小', () => {
    const dir = join(root, 'd')
    mkdirSync(dir)
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(1000))
    writeFileSync(join(dir, 'b.bin'), Buffer.alloc(2000))

    expect(shallowBytes(dir)).toBe(3000)
  })

  it('不展开子目录（那会退回 O(文件数)）', () => {
    const dir = join(root, 'd')
    mkdirSync(join(dir, 'nested', 'deep'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'deep', 'big.bin'), Buffer.alloc(50_000))
    writeFileSync(join(dir, 'top.bin'), Buffer.alloc(10))

    // 只算顶层文件；嵌套里的 50000 不计入。
    expect(shallowBytes(dir)).toBe(10)
  })

  it('空目录返回 0', () => {
    const dir = join(root, 'empty')
    mkdirSync(dir)
    expect(shallowBytes(dir)).toBe(0)
  })

  it('路径不存在时返回 0 而不是抛错', () => {
    expect(shallowBytes(join(root, 'nope'))).toBe(0)
  })
})

describe('stats:false 时目录仍记录顶层大小', () => {
  it('顶层有文件时 bytes 不再恒为 0', () => {
    const dir = join(root, 'd')
    mkdirSync(dir)
    writeFileSync(join(dir, 'huge.iso'), Buffer.alloc(4096))

    const d = describeTarget(dir, { stats: false })

    expect(d.statsOmitted, '仍要标记统计被跳过').toBe(true)
    expect(d.bytes, '顶层大小必须计入，否则配额判定对它失效').toBe(4096)
    expect(d.fileCount, '递归计数仍然跳过').toBe(0)
  })
})
