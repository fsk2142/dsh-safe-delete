# dsh-safe-delete

DSH 删除的撤销层：删除先进安全区，到期移入系统回收站，清空回收站才真正消失。

## 功能

| 功能 | 说明 |
|---|---|
| 拦截裸 shell 删除 | `Remove-Item -Recurse`、`rm -rf`、`rd /s`、`del /s`、`fs.rmSync`、`shutil.rmtree` 被拦下，提示改用 `safe_delete` |
| 危险路径确认 | 家目录、插件源码、profile 清单、`node_modules`、安装目录的删除弹出审批卡片 |
| 删除进安全区 | 默认保留 1 天（可在插件页设置，1–365 天），期间可用 `safe_zone_restore` 取回 |
| 保护启动关键文件 | 写入 profile 清单、`cordis.patch.yml` 等路径直接拒绝 |
| 保护安全区自身 | 安全区目录不可被删除或写入 |
| 目标不明确时转人工 | 命令含变量、管道、通配符时列出原文，不猜路径 |

## 安装

```bash
dsh plugin --profile <profile> add link:<本地路径>
dsh plugin --profile <profile> add dsh-safe-delete
```

## 模型侧工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `safe_delete` | `path` / `paths` / `root`+`match`+`olderThan`+`exclude`，`preview`，`reason`，`force`（忽略） | 删除文件或目录，去向由 `deleteDestination` 决定（安全区或系统回收站）。详见下节 |
| `safe_zone_list` | `limit`（默认 20，**最大 200**） | 列出安全区条目 |
| `safe_zone_restore` | `id` | 取回条目。原路径被占用时落到 `<原路径>.restored-<时间戳>` |
| `safe_zone_status` | — | 条目数、占用大小、保留期、确认阈值、清理去向 |
| `safe_zone_journal` | `n`（默认 20，最大 200） | 审计流水，最新在前 |
| `safe_zone_check` | — | 只读体检：profile 清单解析、行 id 重复 |

### 三种删除方式

| 形态 | 参数 | 适用 |
|---|---|---|
| 单个 | `path` | 一个文件或目录 |
| 多个 | `paths` | 若干已知路径 |
| **模式** | `root` + `match` / `olderThan` / `exclude` | 清生成物 |

三者互斥，混用会被拒绝。

#### 模式形态

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

#### 性能：为什么用模式而不是枚举

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

## 删除去向

| 层 | 时机 | 取回方式 |
|---|---|---|
| 1 安全区 | 删除时（默认 `deleteDestination=safe-zone`） | `safe_zone_restore id=<id>`，默认 1 天内 |
| 1' 系统回收站 | 删除时（`deleteDestination=recycle-bin`） | 资源管理器「还原」；插件**不记录**这些条目 |
| 2 系统回收站 | 安全区条目保留期结束 | 资源管理器「还原」 |
| 3 永久消失 | 清空回收站 | 无法取回 |

`deleteDestination=recycle-bin` 时**没有第 1 层**：文件直接进回收站，`safe_zone_list`
里看不到它，`safe_zone_restore` 也取不回它 —— 那条路只有系统回收站。拦截裸 shell
删除时给出的提示会按当前配置改写，不会在回收站模式下错误承诺 `safe_zone_restore`。

## 路径分级

| 分级 | 范围 | 行为 |
|---|---|---|
| `free` | 工作区、系统临时目录、其他盘 | 直接进安全区 |
| `confirm` | 家目录、`$DSH_HOME` 下非清单内容、profile 目录 | 弹审批卡 |
| `protected` | profile 清单/补丁/lockfile、`node_modules`、安装目录**及其祖先**、安全区自身 | 弹审批卡 |

## 配置

界面：侧边栏 **插件** → `dsh-safe-delete` → **配置**。除下面三项数字外，
还有一组**删除去向**按钮（点一下立即生效，不用按保存）。

| 界面项 | 取值范围 |
|---|---|
| 删除去向 | 两个按钮：`放入安全区` / `直接进回收站` |
| 安全区保留天数 | 整数，1–365 天 |
| 单次删除条目数确认 | `0` 关闭，或正整数 |
| 单次删除大小确认 | `0` 关闭，或至少 1 MB |

低头改配置要重启 DSH 才生效；**删除去向按钮是例外**，点一下立即生效。

### 两种去向怎么选

| | 放入安全区（默认） | 直接进回收站 |
|---|---|---|
| 目录全树统计 | 做 | **不做** |
| 审批卡片显示 | 共 N 个文件 / X MB | 顶层 N 个条目 |
| 条目数 / 大小确认 | **生效** | **不生效** |
| 大量删除速度 | 与文件数成正比 | 与文件数无关 |
| 恢复方式 | 插件内 `safe_zone_restore` 按条目恢复 | 系统回收站，**保留原路径** |

一句话：**要能反悔且在插件里取回，选安全区；只想快点腾地方、去资源管理器还原，
选回收站。** 回收站模式的边界（配额、跨卷、组策略）见
[`docs/BOUNDARIES.md`](docs/BOUNDARIES.md)。

### 配置文件

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

### 弹二次确认的条件

任一命中就问一次，不叠加：

| 条件 | 判定 |
|---|---|
| 路径危险 | 家目录、`$DSH_HOME` 下非清单内容、profile 清单/补丁/lockfile、`node_modules`、安装目录、安全区自身 |
| 单次量过大 | 条目数超过 `confirmFileCount` 或字节数超过 `confirmBytes` |

`force: true` 不是授权。

### 审批策略

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

安全区模式维持原有规则。

> 同一条「不可恢复的删除必须有真实授权」的原则也适用于解析失败：命令**无法被
> 安全解析**时（超长、嵌套过深导致解析器抛错），`ask` 下返回审批、`never` 下
> 明确拒绝 —— 解析失败不等于放行。

## 兼容性

| 项 | 值 |
|---|---|
| `engines.dsh` | `>=0.2.0-rc.2` |
| 实测通过 | `0.2.1-rc.2`、`0.2.1-rc.3` |
| Node | `>=22.19.0` |

## 已知限制

| 限制 | 说明 |
|---|---|
| 动态构造的命令 | `$c = "Re" + "move-Item"; & $c -Recurse X` 无法静态识别 |
| 终端无审批通道 | CLI `delete` 遇到需确认的路径会拒绝 |
| 配置需重启生效 | 值立即写入，拦截线启动时装配 |
| `schemastery` 由宿主提供 | peer 依赖 |

## 文档

- [`docs/BOUNDARIES.md`](docs/BOUNDARIES.md) —— 保证什么、不保证什么、为什么
- [`docs/VERIFY.md`](docs/VERIFY.md) —— 手工验收清单
- [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md) —— 配置页排查
- [`docs/STARTUP-SAFETY.md`](docs/STARTUP-SAFETY.md) —— 启动安全性
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) —— 与其他插件的共存检查
- [`docs/CLEANUP-ARCHITECTURE.md`](docs/CLEANUP-ARCHITECTURE.md) —— 清理架构（后台子进程 + 批量回收）
- [`docs/DEVELOPING.md`](docs/DEVELOPING.md) —— 开发、验证脚本、隐私扫描
- [`docs/INCIDENT-2026-10-30.md`](docs/INCIDENT-2026-10-30.md) —— 2026-10-30 卡顿事故记录
- [`HANDOVER.md`](HANDOVER.md) —— 交接要点
