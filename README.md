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
| `safe_delete` | `path` 或 `paths`，`preview`，`reason` | 删除文件或目录，移入安全区 |
| `safe_zone_list` | — | 列出安全区条目 |
| `safe_zone_restore` | `id` | 取回条目。原路径被占用时落到 `<原路径>.restored-<时间戳>` |
| `safe_zone_status` | — | 条目数、占用大小、保留期、确认阈值、清理去向 |
| `safe_zone_journal` | `limit` | 审计流水，最新在前 |
| `safe_zone_check` | — | 只读体检：profile 清单解析、行 id 重复 |

### 批量删除

```
safe_delete({ paths: ["a.log", "b.log", "c.log"], preview: true })
safe_delete({ paths: ["a.log", "b.log", "c.log"] })
```

`paths` 一次调用一次确认；逐条调用是 N 次调用 N 次确认。每条独立走完整流程，单条失败不影响其他条。

`path` 与 `paths` 二选一，同时传会被拒绝。

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
| 1 安全区 | 删除时 | `safe_zone_restore id=<id>`，默认 1 天内 |
| 2 系统回收站 | 保留期结束 | 资源管理器「还原」 |
| 3 永久消失 | 清空回收站 | 无法取回 |

## 路径分级

| 分级 | 范围 | 行为 |
|---|---|---|
| `free` | 工作区、系统临时目录、其他盘 | 直接进安全区 |
| `confirm` | 家目录、`$DSH_HOME` 下非清单内容、profile 目录 | 弹审批卡 |
| `protected` | profile 清单/补丁/lockfile、`node_modules`、安装目录、安全区自身 | 弹审批卡 |

## 配置

界面：侧边栏 **插件** → `dsh-safe-delete` → **配置**，可改下面三项，以及使用「立即清理安全区」按钮。

| 界面项 | 取值范围 |
|---|---|
| 安全区保留天数 | 整数，1–365 天 |
| 单次删除条目数确认 | `0` 关闭，或正整数 |
| 单次删除大小确认 | `0` 关闭，或至少 1 MB |

配置文件：

| 键 | 默认 | 含义 |
|---|---|---|
| `stateDir` | `<DSH_HOME>/.dsh-safe-delete` | 安全区目录 |
| `retentionDays` | `1` | 保留天数，到期移入回收站 |
| `autoPrune` | `true` | 关掉后只能手动清理 |
| `confirmFileCount` | `5000` | 单次删除条目数超过此值需确认；`0` 关闭 |
| `confirmBytes` | `2147483648` | 单次删除字节数超过此值需确认；`0` 关闭 |
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

## 兼容性

| 项 | 值 |
|---|---|
| `engines.dsh` | `>=0.2.0-rc.2` |
| 实测通过 | `0.2.1-rc.2`、`0.2.1-rc.3` |
| Node | `>=22.19.0` |

## 开发

```bash
pnpm install
pnpm typecheck
pnpm vitest run
pnpm build                        # 产物到 lib/，需一起提交
node scripts/clean-test-tmp.mjs   # 清测试遗留临时目录
```

### 验证脚本

| 脚本 | 作用 |
|---|---|
| `verify-interception.ts` | 拦截链集成 |
| `verify-settings-contract.mjs` | 设置页读写契约 |
| `verify-client.mjs` | 客户端 `apply()` |
| `verify-activation.mjs` | `inject` 可满足性 |
| `verify-client-contract.mjs` | 客户端静默失败模式 |
| `verify-client-render.mjs` | 表单渲染 |
| `verify-dsh-range.mjs` | 版本范围与 peer 写法 |
| `adversarial-probe.ts` | 该拦未拦 |
| `false-positive-probe.ts` | 误拦 |
| `privacy-audit.mjs` | 隐私与凭据扫描 |
| `check-docs.mjs` | 文档与实现一致性 |
| `mutation-check-core.mjs` | 变异检验 |
| `where-is-safe-zone.mjs` | 安全区位置与所在卷 |
| `render-icon.mjs` | 渲染图标预览 |

### 升级 DSH 后

1. 确认 `engines.dsh` 是否需要改
2. 确认插件 import 的包都在新版本 `app.asar` 里
3. 确认关键 API 未变
4. `pnpm vitest run` 全绿

## 已知限制

| 限制 | 说明 |
|---|---|
| 动态构造的命令 | `$c = "Re" + "move-Item"; & $c -Recurse X` 无法静态识别 |
| 终端无审批通道 | CLI `delete` 遇到需确认的路径会拒绝 |
| 配置需重启生效 | 值立即写入，拦截线启动时装配 |
| `schemastery` 由宿主提供 | peer 依赖 |

## 文档

- [`docs/VERIFY.md`](docs/VERIFY.md) —— 手工验收清单
- [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md) —— 配置页排查
- [`docs/STARTUP-SAFETY.md`](docs/STARTUP-SAFETY.md) —— 启动安全性
