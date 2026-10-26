# 启动安全性

本插件不会阻止 DSH 启动。以下是分层结论与自查方法。

## 三层失败半径

| 失败位置 | 后果 | 可 try/catch |
|---|---|---|
| 模块顶层 `import` | 可能中断启动 | 否，ESM 语法限制 |
| `apply()` 内抛错 | 插件降级，DSH 继续 | 是 |
| `tools/pre-execute` 钩子内抛错 | 只影响该次工具调用 | 是 |

## 顶层依赖

`lib/index.js` 的顶层 import：

| 来源 | 包 |
|---|---|
| 本包内部 | `./audit.js`、`./delete-core-*.js`、`./store-*.js`、`./tools.js` |
| 运行时内置 | `node:fs`、`node:os`、`node:path` |
| 宿主 peer | `@deepseek-ai/schemastery`（`^3.18.2`） |

唯一的宿主依赖是 `schemastery`。

**残余风险**：若宿主移除 `schemastery`，本插件会在加载期失败。缓解办法：升级前跑 `scripts/verify-dsh-range.mjs`。

## apply 的异常处理

```ts
export function apply(ctx, config) {
  try { applyInner(ctx, config) }
  catch (error) {
    try { ctx.get?.('logger')?.warn?.('apply failed — fail-soft, continuing boot', error) }
    catch { /* 记日志本身也不能抛 */ }
  }
}
```

已测的坏宿主（`tests/startup-safety.test.ts`）：

| 输入 | 结果 |
|---|---|
| `ctx.get` 返回 `undefined` | 不抛 |
| `ctx.get` 抛错 | 不抛 |
| `ctx.on` 抛错 | 不抛 |
| `ctx.effect` 抛错 | 不抛 |
| `ctx` 为空对象 | 不抛 |
| `ctx` 为 `null` / `undefined` | 不抛 |
| 配置为垃圾值 | 不抛 |

## 钩子对畸形输入

已测输入：`null`、`undefined`、`{}`、`name` 为数字、`arguments` 为 `null` 或字符串、`path` 为对象、`paths` 为数字、`agent` 为字符串、深度嵌套垃圾。全部不抛。

钩子内 3 处 try/catch 覆盖：路径归一化、分级判定、跨卷空间预估。

## 客户端 bundle

设置页走 `window.__ModuleLoader__.load({ factory })`，工厂惰性执行：不污染全局，不操作 `document.body`，抛错只影响本插件的设置卡片。

## 现象区分

| 现象 | 典型原因 |
|---|---|
| 进程消失、有崩溃转储 | 原生层（Electron / 显卡） |
| 窗口在但无法启动或白屏 | 插件装配失败、模块加载失败 |
| 能启动但功能异常 | 单个插件逻辑问题 |

## 排查其他插件拖垮启动

| 顺序 | 操作 |
|---|---|
| 1 | 看 `~/.dsh/_uninstall-backup/`，重置时被卸载的插件目录名通常是元凶 |
| 2 | 检查各插件 `peerDependencies` 是否都能在 profile 的 `node_modules` 找到 |
| 3 | `node -e "import('file:///.../lib/index.js')"` 试加载，缺包会立即报错 |
