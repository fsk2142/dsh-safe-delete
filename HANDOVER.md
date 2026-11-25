# dsh-safe-delete 交接文档

这份文档描述**当前架构与维护不变量**，不记录会过期的 HEAD、tag 或测试数量。
当前版本用 `package.json`，提交用 `git log -1`，验证结果用 `gate-report.json`。

## 1. 产品边界

插件只保护经过 DSH 工具管线的删除：

- `safe_delete`：模型工具，支持单路径、显式路径列表和 `root + match` 模式。
- `/safe-delete`：会话内斜杠命令。
- `bash` / `pwsh` / `run_code` / `terminal_send`：静态识别出的 shell 删除。

其他插件直接调用 `fs.rm`、IDE 删除、资源管理器删除不在保护范围内。

删除去向有两种：

| 去向 | 恢复方式 | 代价 |
|---|---|---|
| `safe-zone`（默认） | `safe_zone_restore id=<id>` | 同卷 rename；目录需要递归统计 |
| `recycle-bin` | Windows 资源管理器还原 | 不递归统计；系统策略/配额可能让文件不可恢复 |

安全区条目到期后由独立 worker 批量送入系统回收站。回收站不是可靠保险；
组策略、`NukeOnDelete`、配额与文件系统都可能让第二层失效。

## 2. 模块职责

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 配置读取、工具注册、`tools/pre-execute` 钩子、调用级审批快照 |
| `src/command.ts` | shell/PowerShell 命令解析；区分 `identified` 与 `unverifiable` |
| `src/classify.ts` | 路径分级：`free` / `confirm` / `protected` |
| `src/delete-core.ts` | 单条删除核心：硬拒绝、描述、门禁、风险检查、移动 |
| `src/tools.ts` | 6 个工具；批量删除一次审批、逐条对账 |
| `src/store.ts` | 安全区索引、移动、还原、销毁与跨卷回滚 |
| `src/recycle.ts` | `SHFileOperationW`、策略/配额三态、半开熔断、TTL 缓存 |
| `src/describe.ts` | 目标描述、有界早退枚举、整批共享测量预算 |
| `src/prune.ts` / `src/cleanup*.ts` | 过期选择、后台 worker、批量聚合与崩溃恢复 |
| `src/batch-manifest.ts` | 批次清单与状态流转 |
| `src/index-lock.ts` | 索引写锁 |
| `src/audit.ts` | JSONL 审计 |
| `src/match.ts` | `root + match` 枚举 |
| `src/client/` | 插件页配置表单 |

## 3. 安全判定不变量

### 3.1 未知命令不等于删除

`parseCommand` 的 `destructive: true, target: null` 有两种含义，必须用
`confidence` 区分：

- `identified`：确实认出删除构造（`rm`、`Remove-Item`、`find -delete`、
  `fs.rmSync` 等）。目标不可解析时，`ask` 下问人，`never` 下拒绝。
- `unverifiable`：没有认出删除，但也不能正向证明无害。`ask` 下问人，
  `never` 下放行。`never` 表示“不要弹窗”，不是“只允许白名单命令”。

解析器抛错同样属于看不清：`ask` 下问人，`never` 下拒绝。

### 3.2 工具内审批桩不是安全边界

生产接线的 `requestApproval` 仍返回 `allowed-once`，因为模型工具进入执行体
意味着管线已经解决过 `ask`。因此：

1. 真实授权必须来自 `pre-execute` 的审批卡；
2. 执行体二次检查只能使用本次调用的 `DeleteExecutionSnapshot`；
3. 快照不存在、目标身份/规模变化、或出现未覆盖风险时，必须拒绝。

快照用宿主在 `pre-execute` 与 `execute` 间传递的同一执行对象作 `WeakMap` 键，
不存全局“当前调用”，并发工具不会串线。

### 3.3 三态不能压成二态

- 永久删除策略：`safe` / `risky` / `unknown`；
- 回收站配额：`within` / `over` / `unknown`；
- 目录测量：`exact` / `over` / `incomplete`。

`unknown` 在回收站模式下按风险处理：`ask` 下弹卡，`never` 下拒绝。

### 3.4 去向必须逐条对账

批量回收不能只看批级 `ok`：

- `succeededPaths` 中的路径算已回收，即使批级 `ok:false`；
- `failedPaths` 中的路径可以回落安全区；
- 两者都没有的路径是 unknown，不能报告成功；
- `notAttempted` 表示熔断/平台不支持，一个字节都没动，可按确定失败回落。

## 4. 性能与恢复

- 永久删除策略在第一次回收站决策时读取，60 秒 TTL；默认安全区启动不读注册表。
- 回收站熔断连续失败 3 次后进入 30 秒冷却；冷却结束放行一次试探，成功复位，
  失败重新冷却。不能做成永久锁。
- `never + safe-zone` 显式路径删除不需要审批统计，钩子只记录目标身份。
- 目录全树统计在宿主同步执行，默认最多 20 万条目；有界测量整批共享 1.5 秒预算。
- 清理在 detached 子进程执行，工具调用只投递任务，不等待回收。

## 5. 配置

完整参数见 [`docs/REFERENCE.md`](docs/REFERENCE.md)。维护时注意：

- `.volatile()` 字段无需重启即可读到新值；
- `blockShellDeletes` / `blockProtectedWrites` 在 `apply` 时决定是否挂线；
- 客户端“保存后重启生效”的提示针对装配行为，不是配置值本身；
- 回收站模式下 `confirmFileCount` / `confirmBytes` 不生效。

## 6. 验证

```bash
pnpm gate                         # 12 项门禁
node scripts/privacy-history-audit.mjs
npm pack --dry-run --json --ignore-scripts
node scripts/sync-install.mjs     # 同步到 DSH_PROFILE 对应安装副本
```

`gate-report.json` 是被忽略的本次运行证据，记录 SHA、时间、平台与逐项结果。
历史隐私基线只接受人工审核过的非凭据命中，凭据类命中永远不能进基线。

正式发布前仍建议另跑 `gitleaks` / `trufflehog`；仓库没有 CI artifact。

## 7. 安装与发版

```bash
pnpm build
node scripts/sync-install.mjs
# 重启 DSH 后生效
```

`sync-install` 会同步 `package.json` 与完整发布清单，并清理安装副本中的陈旧文件。
`lib/` 以自身为安全根，其余发布目录以插件安装根为安全根；符号链接/junction
一律拒绝跟随。

发版用 `node scripts/release.mjs --note "..."`。脚本会：

1. 计算并写回版本号；
2. 跑完整 `pnpm gate`；
3. 只暂存 `package.json` 与 `lib/`（不会吞入探针或本地笔记）；
4. 提交、打 annotated tag、推送；
5. 创建 GitHub Release；没有 token 时明确跳过 Release。

## 8. 修改前必看

1. 先跑 `pnpm gate` 建立绿色基线。
2. 每个修复先写能复现的回归测试，再改实现，立刻重跑。
3. 跨进程协议（PowerShell / `reg.exe`）没有类型系统保护，两边必须同步。
4. 不要把保护写进不会真实授权的回调，也不要用整批布尔替代逐条对账。
5. 改安全判定时同时覆盖“该拦的”与“不该拦的”用例。

## 9. 文档索引

| 文件 | 内容 |
|---|---|
| `README.md` | 用户操作说明；插件页通过 locale 的 `meta.detail` 渲染 `docs/DETAIL.md` |
| `docs/DETAIL.md` | 插件页操作正文 |
| `docs/REFERENCE.md` | 参数、配置、分级、审批策略 |
| `docs/BOUNDARIES.md` | 保证范围与设计取舍 |
| `docs/DEVELOPING.md` | 开发命令与验证脚本 |
| `docs/CLEANUP-ARCHITECTURE.md` | 后台清理架构 |
| `docs/INCIDENT-2026-10-30.md` | 会话卡死事故复盘 |
| `docs/COMPATIBILITY.md` | 宿主与其他插件共存检查 |
| `docs/DIAGNOSTICS.md` | 配置页排查 |
| `docs/STARTUP-SAFETY.md` | 启动期安全 |
| `docs/VERIFY.md` | 真机验收清单 |
