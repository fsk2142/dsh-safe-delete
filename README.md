# dsh-safe-delete

让 DSH 里的删除变成**可逆**操作。

一次写错的移除命令可以抹掉整个工作区 —— 而且没有后悔药。这个插件只做一件事：让"
删错了"不再致命。

## 它做什么

- **拦下裸 shell 删除**：`Remove-Item -Recurse`、`rm -rf`、`rd /s`、`del /s`、
  `fs.rmSync`、`shutil.rmtree` 都会被拦，理由里告诉模型走安全删除。
- **危险路径在界面里点一下**：删家目录、插件源码、profile 清单、`node_modules`
  时，DSH 聊天框上方弹出审批卡片，点「允许一次」才执行。**不需要另开终端。**
- **删掉的东西进安全区**：7 天内可原样取回，容量超 20 GB 时最旧的先清。
- **看不清就问**：命令目标含变量（`$tmp`、`$env:TEMP`）、管道、通配符时，
  不猜路径，直接把原文交给人看。

## 为什么不用 `@suagr_xl/dsh-safety`

那个插件用 `ctx.tools.guard()`，是一个**只能拒绝**的单调守卫 —— 拦下来之后没有
回话通道，所以批准必须离开 DSH、另开终端敲 `dsh-safety allow <id>`。

本插件用 `tools/pre-execute` 瀑布，它除了 `deny` 还能返回 `ask`，而 `ask` 会走到
DSH 自带的 `@deepseek-ai/dsh-user-approval` + `dsh-client-ui-approval`，也就是
那张「允许一次 / 拒绝」卡片。审批回到界面里。

另外修掉了它的一个真实缺陷：它把 `$tmp`、`$_.FullName` 这类**未展开的变量原文**
当作相对路径拼到会话目录下，再判成"在家目录里"，于是制造了大量莫名其妙的拒绝
（在作者机器上 124 次拦截里有 25 次是这类）。

## 装

```bash
# 本地开发（把 <本地路径> 换成你 clone 下来的绝对路径）
dsh plugin --profile <profile> add link:<本地路径>

# 或已发布
dsh plugin --profile <profile> add dsh-safe-delete
```

**前提**：会话的审批策略必须是 `ask`。在 `never` 下（例如 `danger-full-access`
权限预设），`ask` 会被直接驳回、卡片不出现 —— 拦车闸仍然工作，但安全删除不可用。
这是刻意的 fail-closed：**没有审批通道，就不许删。**

## 用

模型侧工具：

| 工具 | 作用 |
|---|---|
| `safe_delete` | 唯一的删除通道。`preview:true` 先看，再去掉执行 |
| `safe_zone_list` | 安全区里有什么 |
| `safe_zone_restore` | 按 id 取回（原路径被占用时落到 `.restored-<时间戳>`） |
| `safe_zone_status` | 条目数、占用、保留期、容量上限、确认阈值 |
| `safe_zone_journal` | 审计流水：被拦的删除、被拦的写入、删除、取回、清理，最新在前 |
| `safe_zone_check` | 只读体检：profile 清单能否解析、行 id 是否跨层重复 |

人侧命令行（**不依赖 DSH 运行**）：

```bash
dsh-safe-delete list
dsh-safe-delete undo <id>
dsh-safe-delete prune --dry-run
dsh-safe-delete status
dsh-safe-delete check
```

## 分级

| 分级 | 范围 | 行为 |
|---|---|---|
| `free` | 工作区、系统临时目录、其他盘 | 直接进安全区，不打扰 |
| `confirm` | 家目录、`$DSH_HOME` 下非清单内容、profile 目录 | 弹审批卡 |
| `protected` | profile 清单/补丁/lockfile、`node_modules`、安装目录、安全区自身 | 弹审批卡 |

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `stateDir` | `<DSH_HOME>/.dsh-safe-delete` | 安全区目录 |
| `retentionDays` | `7` | 保留天数 |
| `maxBytes` | `21474836480`（20 GB） | 容量上限，超出最旧先清 |
| `autoPrune` | `true` | 关掉后只剩手动清理 |
| `autoPruneIntervalMs` | `3600000`（1 小时） | 清理的检查间隔：工具调用时顺路看一眼，超过才真跑 |
| `confirmFileCount` | `5000` | 单次删除超过这么多条目就额外确认一次；`0` 关闭 |
| `confirmBytes` | `2147483648`（2 GB） | 单次删除超过这么大就额外确认一次；`0` 关闭 |
| `blockShellDeletes` | `true` | 拦车闸开关 |
| `blockProtectedWrites` | `true` | 拦截对启动关键路径的写入 |
| `crossVolumeCopy` | `false` | 安全区与目标不同卷时是否允许复制式移入 |

### 什么时候会弹二次确认

两个**相互独立**的理由，任一命中就问一次（不会叠加问两次）：

1. **路径危险**：家目录、`$DSH_HOME` 下的非清单内容、profile 清单/补丁/lockfile、`node_modules`、安装目录、安全区自身。
2. **这一单太大量**：条目数超过 `confirmFileCount`，或总字节超过 `confirmBytes`。普通工作区文件也会因此确认一次。

卡片上会写明是哪一条触发的，例如「5 entries exceeds the limit of 2」。`force: true` 永远不是授权。

## 不做

- **不存快照、不做回滚**：桌面版自带 `sanitizeProfile`（配置坏到起不来时的原生
  恢复），插件安装器也会自己回滚 `package.json` 与 lockfile。重复实现只会多一份
  要维护的代码。
- **不拦读操作**：`str_replace_editor view` 照常放行。
- **不写浏览器端 UI**：审批卡片由 DSH 自带，配置走 Cordis 配置文件。

## 开发

```bash
pnpm install
pnpm typecheck     # 类型检查
pnpm vitest run    # 73 个测试
pnpm build         # 产物到 lib/（必须一起提交）
node scripts/clean-test-tmp.mjs   # 清掉测试遗留的临时目录
```

`lib/` 是发布产物且**必须进版本库**：`main` 与 `cordis.patch.yml` 都指向它，
不提交的话克隆下来直接安装会加载不到。改完 `src/` 记得重新 `pnpm build`。

验收清单见 [`docs/VERIFY.md`](docs/VERIFY.md)。
