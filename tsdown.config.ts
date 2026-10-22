import { defineConfig, type UserConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-safe-delete'

/**
 * 只有 host 一个入口：本插件不提供浏览器端产物（审批卡片由 DSH 自带的
 * `@deepseek-ai/dsh-client-ui-approval` 渲染，本包不写 UI）。
 *
 * `entry` 必须是对象映射：数组形式会让产物落到 `lib/src/...`，与 package.json
 * 里声明的 `./lib/index.js` 对不上（dsh-llm-account 踩过这个坑）。
 */
const hostConfig: UserConfig = {
  name: `${PACKAGE_NAME}/host`,
  entry: {
    index: 'src/index.ts',
    // 独立 CLI 需要能单独 import 安全区与清理策略：插件入口带着 cordis 接线，
    // 不该被一个只跑 `undo` 的命令行拉进来。
    store: 'src/store.ts',
    prune: 'src/prune.ts',
    tools: 'src/tools.ts',
    audit: 'src/audit.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  // tsdown 在 node 平台默认强制 `.mjs`；本包是 `type: module`，
  // 且 cordis.patch.yml 按包名解析 main → lib/index.js。
  fixedExtension: false,
}

export default defineConfig([hostConfig])
