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
    /*
     * 下面这些是**独立入口**，只保留真正需要的。
     *
     * 判据：`bin/dsh-safe-delete.mjs` 用动态 import 按需加载它们（CLI 不该把整个
     * 插件入口连同 cordis 接线一起拉进来），或 `package.json#exports` 对外导出。
     *
     * 曾经还多出四个入口（config / commands / settings-guide / recycle）。它们既不在
     * exports 里、CLI 也不加载，代码已经打包进 index.js，独立产物纯属冗余 —— 删掉
     * 可让 lib/ 少 4 个文件，也少一份"这个模块是公开 API"的误导。
     */
    store: 'src/store.ts',
    prune: 'src/prune.ts',
    tools: 'src/tools.ts',
    audit: 'src/audit.ts',
    'delete-core': 'src/delete-core.ts',
    /*
     * `cleanup-worker` **必须是独立入口**。
     *
     * `src/cleanup.ts` 用 `spawn(process.execPath, [workerPath, ...])` 派生它，
     * 路径是 `lib/cleanup-worker.js`。若它被打包进 `index.js`，运行时找不到
     * 那个文件 —— 清理会静默不执行，而宿主看起来一切正常。
     *
     * 这也是为什么"构建通过"不能当作验证：bundle 成功不代表那个文件
     * 作为独立模块存在。
     */
    'cleanup-worker': 'src/cleanup-worker.ts',
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
