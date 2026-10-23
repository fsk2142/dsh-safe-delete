# 启动安全性：本插件会不会让 DSH 起不来

结论先行：**不会**。下面是判定依据，以及唯一一个我们无法消除的风险面。

## 三层失败，后果完全不同

DSH 的插件生命周期分三层，每一层的失败半径差得很远：

| 失败位置 | 后果 | 能否 try/catch |
|---|---|---|
| **模块顶层 `import`** | **可能中断启动** —— 插件加载失败会传染 | ✗ ESM 语法，无法包裹 |
| `apply()` 内抛错 | 插件降级/失效，DSH 继续 | ✓ |
| `tools/pre-execute` 钩子内抛错 | 只影响那一次工具调用 | ✓ |

所以对第 2、3 层，我们要求 **fail-soft**；对第 1 层，只能**把依赖面压到最小**。

## 第 1 层的实际依赖

`lib/index.js` 的顶层 import 只有这些：

```
./audit.js             本包内部
./delete-core-*.js     本包内部
./store-*.js           本包内部
./tools.js             本包内部
node:fs / node:os / node:path   运行时内置
@deepseek-ai/schemastery        宿主 peer
```

**唯一的宿主依赖是 `@deepseek-ai/schemastery`**（peer 声明 `^3.18.2`）。

这一条和真实的崩溃事故形成对照：`dsh-free-search` 在顶层 import 了
`@deepseek-ai/dsh-settings` 等**四个**宿主包，其中有的在新版宿主里已不存在，
于是加载即 `ERR_MODULE_NOT_FOUND`，整个 profile 起不来，只能重置。

`schemastery` 不同：它是**几乎所有插件共用**的宿主基础包（本机实测 3.18.5，
满足 `^3.18.2`）。如果它缺失，出问题的不会只有本插件。

> **残余风险**：如果将来宿主移除了 `schemastery`，本插件会和
> `dsh-free-search` 一样在加载期失败。这是 ESM 硬限制，无法用 try/catch 兜住。
> 缓解办法：升级插件时先跑 `verify-dsh-range`，并在 README 声明宿主范围。

## 第 2 层：`apply` 的 fail-soft

`apply` 外面包了 try/catch，异常只记日志、不向上抛：

```ts
export function apply(ctx, config) {
  try { applyInner(ctx, config) }
  catch (error) {
    try { ctx.get?.('logger')?.warn?.('apply failed — fail-soft, continuing boot', error) }
    catch { /* 记日志本身也不能抛 */ }
  }
}
```

实测（`tests/startup-safety.test.ts`，17 条）覆盖的坏宿主：

| 输入 | 结果 |
|---|---|
| `ctx.get` 全返回 `undefined` | 不抛 |
| `ctx.get` 自己抛错 | 不抛 |
| `ctx.on` 抛错（钩子注册失败） | 不抛 |
| `ctx.effect` 抛错 | 不抛 |
| `ctx` 为空对象 | 不抛 |
| `ctx` 为 `null` / `undefined` | 不抛 |
| 配置是垃圾值 | 不抛 |

`ctx.on` 抛错那条值得单独说：它意味着**拦截链装不上**。但那是"少一层保护"，
不该升级成"DSH 起不来"——宁可插件一边失效而宿主活着，也不要为了强制保护
而拖垮整个应用。

## 第 3 层：钩子对垃圾输入

同一个测试文件里另有一组，直接把畸形 `exec` 喂给真实钩子：

```js
null / undefined / {} / name 为数字 / arguments 为 null 或字符串 /
path 是对象 / paths 是数字 / agent 是垃圾字符串 / 深度嵌套垃圾
```

全部不抛。钩子内部的 3 处 try/catch 覆盖了：

- 路径归一化（`normaliseDeleteTargets`）
- 分级判定（`classifyPath` / `decideGate`）
- 跨卷空间预估（`statfsSync` 在某些文件系统上会抛）

## 第 4 层：客户端 bundle

设置页走 `window.__ModuleLoader__.load({ factory })`，**工厂函数惰性执行**：

- 不会污染全局（无 `window.xxx =` 赋值）
- 不直接操作 `document.body`
- 工厂即使抛错，也只影响本插件那张设置卡片

它不会白屏整个界面。

## 关于"崩溃"这个词

排查时值得区分三种现象，因为排查方向完全不同：

| 现象 | 典型原因 |
|---|---|
| 进程直接消失、有崩溃转储 | 原生层（Electron/显卡） |
| 窗口在但**无法启动/白屏** | 插件装配失败、模块加载失败 |
| 能启动但功能异常 | 单个插件逻辑问题 |

这次的现象是第二种：没有 Crashpad 转储，也没有 Windows 应用事件日志，
说明 Electron 进程本身没崩——是**装配阶段**失败。这类问题的元凶几乎总是在
第 1 层（顶层 import）。

## 给使用者的自查清单

怀疑某个插件拖垮启动时：

1. 看 `~/.dsh/_uninstall-backup/` —— 重置时被卸载的插件目录名通常就是元凶
2. 逐个检查插件的 `peerDependencies` 是否都能在 profile 的 `node_modules` 里找到
3. 直接 `node -e "import('file:///.../lib/index.js')"` 试加载，缺包会立刻报出来

第 3 条最快：它复现的正是宿主加载插件时做的事。
