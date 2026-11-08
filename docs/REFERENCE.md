# 参考手册（REFERENCE）

面向查细节的人：参数、全部配置项、分级规则、审批策略、兼容性。
**插件页显示的只有 [`README.md`](../README.md) 里的操作说明** —— 那些表都在这里。

---

## 模型侧工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `safe_delete` | `path` / `paths` / `root`+`match`+`olderThan`+`exclude`，`preview`，`reason`，`force`（忽略） | 删除文件或目录，去向由 `deleteDestination` 决定 |
| `safe_zone_list` | `limit`（默认 20，**最大 200**） | 列出安全区条目 |
| `safe_zone_restore` | `id` | 取回条目。原路径被占用时落到 `<原路径>.restored-<时间戳>` |
| `safe_zone_status` | — | 条目数、占用大小、保留期、确认阈值、清理去向 |
| `safe_zone_journal` | `n`（默认 20，最大 200） | 审计流水，最新在前 |
| `safe_zone_check` | — | 只读体检：profile 清单解析、行 id 重复 |

## safe_delete 的三种形态

| 形态 | 参数 | 适用 |
|---|---|---|
| 单个 | `path` | 一个文件或目录 |
| 多个 | `paths` | 若干已知路径 |
| **模式** | `root` + `match` / `olderThan` / `exclude` | 清生成物 |

三者互斥，混用会被拒绝。

### 模式形态

```
# 删 .tmp 里所有 .log
safe_delete({ root: "C:\\proj\\.tmp", match: "**/*.log", preview: true })

# 只删 7 天前的日志，保留 latest/
safe_delete({
  root: "C:\\proj\\logs",
  match: "*.log",
  olderThan: "7d",
  exclude: ["latest/**"],
})
```

| 参数 | 说明 |
|---|---|
| `root` | 搜索起点。**root 本身不会被删**，只删它内部的匹配项 |
| `match` | glob，相对 root：`**` 跨层、`*` 同层（不跨目录）、`?` 单字符、`{a,b}` 多选。省略则匹配全部文件 |
| `olderThan` | `30m` / `6h` / `7d`，按修改时间筛选。裸数字按天 |
| `exclude` | 相对 root 的 glob，命中即跳过。**exclude 优先于 match** |

`match` 与 `exclude` 都是**锚定整条相对路径**的匹配，所以写 `*.log` 只命中
`root` 下第一层，要跨层得写 `**/*.log`。匹配为空时报错（不是静默成功），
并在错误里给出扫描过的条目数。

### 性能：为什么用模式而不是枚举

| 方式 | 1000 个文件 |
|---|---|
| 传 1000 条 `paths` | ~1.1 s |
| 删整个目录（一次 `path`） | ~24 ms |
| `root` + `match` | ~1.1 s（等价于 `paths`，但只需一次调用） |

`paths`/`match` 都是逐条移动（每条独立分级、独立审计、单条失败不影响其他条），
索引在整批结束时只写一次。**能整目录删就用 `path` 指向目录**，那是一次 `renameSync`。

## 斜杠命令

```
/safe-delete <路径>              移入安全区
/safe-delete <路径> --preview    只预览，不移动
/safe-delete list                列出安全区条目
/safe-delete restore <id>        取回条目
/safe-delete clean               立即清空安全区
/safe-delete clean --dry-run     只报告，不动手
/safe-delete config              查看所有配置项
/safe-delete config <项> <值>     修改一项，例如 config confirmBytes 512MB
/safe-delete status              安全区概况
```

## 命令行工具

不依赖 DSH 运行。

```bash
dsh-safe-delete delete <路径> [--preview]
dsh-safe-delete list
dsh-safe-delete undo <id>
dsh-safe-delete prune [--dry-run]
dsh-safe-delete status
dsh-safe-delete check
dsh-safe-delete journal
```

`delete` 遇到需要人工确认的路径会拒绝，提示改用 DSH 内的 `/safe-delete`。

## 删除去向的三层结构

| 层 | 时机 | 取回方式 |
|---|---|---|
| 1 安全区 | 删除时（默认 `deleteDestination=safe-zone`） | `safe_zone_restore id=<id>`，默认 1 天内 |
| 1' 系统回收站 | 删除时（`deleteDestination=recycle-bin`） | 资源管理器「还原」；插件**不记录**这些条目 |
| 2 系统回收站 | 安全区条目保留期结束 | 资源管理器「还原」 |
| 3 永久消失 | 清空回收站 | 无法取回 |

`deleteDestination=recycle-bin` 时**没有第 1 层**：文件直接进回收站，`safe_zone_list`
里看不到它，`safe_zone_restore` 也取不回它 —— 那条路只有系统回收站。

## 路径分级

| 分级 | 范围 | 行为 |
|---|---|---|
| `free` | 工作区、系统临时目录、其他盘 | 直接进安全区 |
| `confirm` | 家目录、`$DSH_HOME` 下非清单内容、profile 目录 | 弹审批卡 |
| `protected` | profile 清单/补丁/lockfile、`node_modules`、安装目录**及其祖先**、安全区自身 | 弹审批卡 |

## 配置项全表

| 键 | 默认 | 含义 |
|---|---|---|
| `stateDir` | `<DSH_HOME>/.dsh-safe-delete` | 安全区目录 |
| `deleteDestination` | `safe-zone` | 删除去向；`recycle-bin` 直接进系统回收站 |
| `retentionDays` | `1` | 保留天数，到期移入回收站 |
| `autoPrune` | `true` | 关掉后只能手动清理 |
| `confirmFileCount` | `5000` | 单次删除条目数超过此值需确认；`0` 关闭。**回收站模式不生效** |
| `confirmBytes` | `2147483648` | 单次删除字节数超过此值需确认；`0` 关闭。**回收站模式不生效** |
| `blockShellDeletes` | `true` | 拦截裸 shell 删除 |
| `blockProtectedWrites` | `true` | 拦截对启动关键路径的写入 |
| `crossVolumeCopy` | `false` | 跨卷时是否允许复制式移入 |
| `cleanRequestedAt` | `0` | 「立即清理」按钮的触发戳 |

### 两种去向的取舍

| | 放入安全区（默认） | 直接进回收站 |
|---|---|---|
| 目录全树统计 | 做 | **不做** |
| 审批卡片显示 | 共 N 个文件 / X MB | 顶层 N 个条目 |
| 条目数 / 大小确认 | **生效** | **不生效** |
| 大量删除速度 | 与文件数成正比 | 与文件数无关 |
| 恢复方式 | 插件内 `safe_zone_restore` 按条目恢复 | 系统回收站，**保留原路径** |

### 弹二次确认的条件

任一命中就问一次，不叠加：

| 条件 | 判定 |
|---|---|
| 路径危险 | 家目录、`$DSH_HOME` 下非清单内容、profile 清单/补丁/lockfile、`node_modules`、安装目录、安全区自身 |
| 单次量过大 | 条目数超过 `confirmFileCount` 或字节数超过 `confirmBytes` |

`force: true` 不是授权。

## 审批策略

| 策略 | 危险路径删除 | 其他删除 |
|---|---|---|
| `ask` | 弹卡片，点「允许一次」才执行 | 直接进安全区 |
| `never` | 直接进安全区，无确认 | 直接进安全区 |

`never` 下另一处例外：删除命令目标含变量、管道、通配符时放行执行。

模式删除（`root` + `match` / `olderThan`）在**回收站模式**下无法提前确认每个
匹配项的大小及可恢复性，因此：

- `never` 策略下**一律拒绝**。拒绝对话里会给出三条出路：临时改 `ask`、
  改用显式 `paths`（大小可以 stat 出来，风险可预判）、或切回 `safe-zone`。
- `ask` 策略下弹卡片，卡片说明实际回收站去向与可能永久删除的风险。

> 同一条「不可恢复的删除必须有真实授权」的原则也适用于解析失败：命令**无法被
> 安全解析**时（超长、嵌套过深导致解析器抛错），`ask` 下返回审批、`never` 下
> 明确拒绝 —— 解析失败不等于放行。

## 兼容性

| 项 | 值 |
|---|---|
| `engines.dsh` | `>=0.2.0-rc.2` |
| 实测通过 | `0.2.1-rc.2`、`0.2.1-rc.3` |
| Node | `>=22.19.0` |
| `schemastery` | 由宿主提供（peer 依赖） |

## 已知限制

| 限制 | 说明 |
|---|---|
| 动态构造的命令 | `$c = "Re" + "move-Item"; & $c -Recurse X` 无法静态识别 |
| 终端无审批通道 | CLI `delete` 遇到需确认的路径会拒绝 |
| 配置需重启生效 | 值立即写入，拦截线启动时装配 |
