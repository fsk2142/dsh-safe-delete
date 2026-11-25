import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 全量并行时 CPU/磁盘争用会让真实回收与 3000 条 worker 测试超过 5 秒。
    // 保留文件级隔离，只放宽单测时限；关闭隔离会破坏模块级状态隔离。
    testTimeout: 15_000,
    // 187 个文件级 worker 同时争抢磁盘会让 500ms 性能阈值抖动；限制并发，
    // 保留 isolate 语义，不用关闭隔离来换速度。
    maxWorkers: 4,
  },
})
