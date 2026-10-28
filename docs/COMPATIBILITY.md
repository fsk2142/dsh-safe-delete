# 与其他插件的共存检查

本插件挂了一个**全局钩子**（`tools/pre-execute`），对每一次工具调用都执行。
这类插件出问题时表现为「DSH 崩溃」或「工具莫名被拒」，而单元测试看不到。
`pnpm check:conflict` 做四类只读检查。

## 1. 工具名冲突

本插件注册 6 个工具：

```
safe_delete  safe_zone_list  safe_zone_restore
safe_zone_status  safe_zone_check  safe_zone_journal
```

重名会让宿主拒绝注册或覆盖。脚本比对 profile 里其他插件的源码（去注释后匹配
字面量），确认无冲突。

## 2. `tools/pre-execute` 钩子共存

宿主内置有 3 个包**真正注册**这个钩子（判据是注册形态 `ctx.on('tools/pre-execute'`，
不是字符串包含 —— 否则调用方 `dsh-tools` 会被误算进来）：

| 包 | 与本插件的关系 |
|---|---|
| `dsh-experimental-auto-review` | 包装式：先 `await next()`，再决定是否升级为 `ask` |
| `dsh-tool-jobs` | 只管自己的工具 |
| `dsh-workspace-changes` | 只管自己的工作区变更 |

**cordis waterfall 语义**（从 `cordis/lib/index.js` 读到）：

```js
waterfall(...args) {
  const cbs = this.dispatch('waterfall', args)   // 注册顺序
  const inner = args.pop()
  const next = () => (cbs.shift() ?? inner)(...args)
  args.push(next)
  return next()
}
```

每个钩子拿到 `next`，**返回非 `next()` 结果就终止整条链**。

### 为什么不互相削弱

`dsh-experimental-auto-review` 的关键三行：

```js
const downstream = await next()
if (decision.decision === 'allow' || downstream.kind !== 'allow') return downstream
return askUser(exec, decision.reason)
```

- `downstream` 不是 `allow`（本插件 deny 了）→ 原样保留本插件的否定
- 两边都 `allow` → 它升级成 `ask`（更严格）

模拟验证 8 个组合全部符合预期，两种注册顺序下本插件的 `deny` 都不会被覆盖。

### 钩子开销

实测 0.03 ms/次（安全路径）、0.005 ms（非本插件工具）。50 并发总耗时 1 ms
（DSH 的 `maxParallelToolCalls` 是 50）。不构成阻塞。

## 3. 斜杠命令

`/safe-delete` 未被其他插件占用。子命令 `list` / `restore` / `clean` /
`config` / `status` 都在 `commands.ts` 里实现。

## 4. 配置兼容

profile 的 `cordis.patch.yml` 里本插件条目可能残留**已删除**的字段。实测：

```
配置: maxBytes, pruneAtPercent, autoPruneIntervalMs   ← 已从 schema 移除
      confirmFileCount, confirmBytes, cleanRequestedAt  ← 有效
```

**schemastery 对未知键是宽容的**：不抛错、且会原样保留。所以这不是崩溃风险，
但属于脏数据，建议删掉这三行。

## 崩溃风险评估结论

| 风险点 | 结论 |
|---|---|
| 钩子抛异常 | **不会崩溃**。宿主 `prepareExecution` 用 `try/catch` 包住 `waterfall`，异常转成 `toolErrorResult`（一次工具调用错误） |
| `apply()` 抛异常 | **不会崩溃**。本插件 `apply` 自带 try/catch，失败只记录 |
| 未知配置字段 | **不会崩溃**。schemastery 宽容 |
| 工具名/命令重名 | 已确认无重名 |
| 钩子互相覆盖 | 已确认不互相削弱 |

## 何时重跑

宿主升级后必跑一次——`dsh-experimental-auto-review` 等是宿主内置模块，
它们的实现可能变。

```bash
pnpm check:conflict
```
