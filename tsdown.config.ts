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
    /*
     * `cleanup-run` 也必须是独立入口 —— 同样的理由。
     *
     * `bin/dsh-safe-delete.mjs` 用 `import('../lib/cleanup-run.js')` 拿到
     * `pruneNowForWorker`，好让 CLI 的 `prune` 复用批量回收（否则要逐条
     * 调回收站，1000 条约 17 分钟）。它若被打包进 chunk，CLI 会直接报
     * `Cannot find module`。
     */
    'cleanup-run': 'src/cleanup-run.ts',
    /*
     * `describe` 也必须是独立入口（2026-11-09）。
     *
     * `bin/dsh-safe-delete.mjs` 用 `import('../lib/describe.js')` 拿
     * `createSharedMeasure` —— 目录配额判定的有界枚举要用它。漏了这个入口，
     * bundle 照样成功（代码被并进 `index.js`），但那个文件根本不存在，
     * CLI 的 `delete` 在真机上直接崩：
     *
     * ```
     * Cannot find module '.../lib/describe.js' imported from bin/dsh-safe-delete.mjs
     * ```
     *
     * 这正是上面注释说的那件事：**构建通过不代表那个文件作为独立模块存在**。
     */
    describe: 'src/describe.ts',
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
  /**
   * chunk 文件名**不带内容哈希**（2026-11-09 修）。
   *
   * ## 为什么
   *
   * tsdown 默认给被共享的模块起名 `store-B14ysChF.js` —— 后缀是内容哈希。
   * 于是**每次构建都会产生一批新文件名**，而 `lib/` 是提交进 git 的，
   * 每个版本带着自己那一套名字：
   *
   * ```
   * 2.3.0 发布时：store-CwWWfFFR.js  tools--GeJEyQY.js
   * 2.3.1 构建后：store-B14ysChF.js  tools-DVoS58JJ.js
   * ```
   *
   * 这在「本地构建直接同步进 profile」的工作流下会**把安装目录弄坏**：
   *
   * 1. `scripts/sync-install.mjs` 先删掉目标里"源目录没有"的文件，再覆盖复制；
   * 2. 于是安装目录里的 chunk 换成了本地构建的名字，`index.js` 也跟着换了版本，
   *    它 `import "./store-B14ysChF.js"`；
   * 3. 但 `package.json` 版本号仍与 GitHub 上的 tarball 相同；
   * 4. 插件管理器再装同一 spec 时，pnpm 看到版本未变 → 跳过 → **文件永久缺失**。
   *
   * 实测复现过：装完是好的，跑一次 `sync:install` 之后 `index.js` 引用的两个
   * chunk 就不存在了，且再装同一 spec 也修不回来（只能 `--force`）。
   *
   * ## 为什么去掉哈希就够了
   *
   * 文件名稳定之后，本地构建与 tarball 产生的是**同一组名字**：覆盖是安全的，
   * `sync-install` 没有"源目录没有"的文件可删，两边内容差异也只表现为覆盖。
   *
   * 缓存失效不是问题：宿主按文件系统加载，不缓存 ESM 模块的文件名。
   *
   * ## 之前试过但不行的写法
   *
   * `chunkFileNames: 'chunks/[name]-[hash].js'` —— tsdown **直接忽略**这个选项，
   * 产物名完全没变。保留 `[name]`、去掉 `[hash]` 才生效（实测两次构建 +
   * 改两行源码再构建，文件名都不变）。
   *
   * ## 子目录是必要的
   *
   * 不能写成 `'[name].js'`（平铺回 `lib/`）：`store.js` / `tools.js` 这些名字
   * 已经被**入口 shim** 占用，chunk 撞名会互相覆盖。`chunks/` 子目录天然隔离。
   */
  outputOptions: { chunkFileNames: 'chunks/[name].js' },
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
