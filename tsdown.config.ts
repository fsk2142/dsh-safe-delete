import { defineConfig, type UserConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-safe-delete'

/**
 * 宿主运行时提供的包：必须保持 external。
 *
 * 为什么：这些包的实例身份由宿主决定。inline 一份进去会得到**不同的类身份**，
 * 宿主那边的 `instanceof` / 服务注册就会认不出来。
 *
 * `schemastery` 尤其关键：`.volatile()` 的引用语义依赖同一个实现。
 */
const HOST_PROVIDED = ['@deepseek-ai/schemastery']

/**
 * 浏览器端由宿主 loader 用 `require` 注入的包。
 *
 * react 不随本包安装（宿主提供），所以客户端 bundle 必须把它当外部依赖。
 */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']

/**
 * Host 入口。
 *
 * `entry` 必须是对象映射：数组形式会让产物落到 `lib/src/...`，与 package.json
 * 里声明的 `./lib/index.js` 对不上。
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
    config: 'src/config.ts',
    'delete-core': 'src/delete-core.ts',
    commands: 'src/commands.ts',
    'settings-guide': 'src/settings-guide.ts',
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
  deps: { neverBundle: HOST_PROVIDED },
}

/**
 * 浏览器入口：插件页里的设置表单。
 *
 * 与斜杠命令并存：命令负责「改得快」，界面负责「看得清」。
 * 两条路径写的是同一份配置（都走宿主的 settings 服务），不会分叉。
 *
 * 为什么是 CJS 而不是 ESM：宿主 loader 用 `window.__ModuleLoader__.load({id, factory})`
 * 包装这个产物，`require` 由 loader 注入，最后读 `module.exports` 上的 `{ apply, inject }`。
 */
const clientConfig: UserConfig = {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // 别漏：否则按 engines.node 编译，浏览器跑不了。
  target: 'es2022',
  dts: false,
  // 不能清空 host 产物。
  clean: false,
  outputOptions: {
    entryFileNames: 'client.js',
    // 复现宿主 loader 约定的包装格式。
    banner: [
      'window.__ModuleLoader__.load({',
      `\tid: ${JSON.stringify(PACKAGE_NAME)},`,
      '\tfactory: (require) => {',
    ].join('\n'),
    intro: '\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;',
    footer: '\t\treturn module.exports;\n\t}\n});',
  },
  deps: { neverBundle: [...CLIENT_EXTERNALS, ...HOST_PROVIDED] },
}

export default defineConfig([hostConfig, clientConfig])
