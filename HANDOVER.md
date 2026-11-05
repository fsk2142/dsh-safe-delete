# dsh-safe-delete 交接文档

> 最后更新：2026-11-05
> 版本：**2.2.0** · HEAD：`077d27f` · 工作区干净

---

## 1. 这个插件解决什么问题

DSH 的删除工具一旦被模型写错一次（例如把 `rm -rf ./build` 写成 `rm -rf ./`），整个工作区就没了，无法挽回。

本插件把删除变成**可反悔**的：

```
用户/模型调用 safe_delete
   ↓
pre-execute 钩子判定 → 危险路径或超阈值 → 弹审批卡
   ↓
内容移入安全区（同卷 rename，瞬时）
   ↓
保留期到期后，清理任务送进系统回收站（第二层保险）
   ↓
用户清空回收站（第三层，唯一的不可逆点）
```

**三层里只有最后一层不可逆，而那一步是用户自己做的。**

---

## 2. 当前状态速查

| 项 | 值 |
|---|---|
| 版本 | 2.2.0 |
| HEAD | `077d27f` |
| 远端 | 已同步（`eb2e53c..077d27f` 已推送） |
| tag | `v2.2.0`（annotated `6af8433`，指向提交 `eb2e53c`；**之后 6 个提交没有新 tag**） |
| Release | [v2.2.0](https://github.com/fsk2142/dsh-safe-delete/releases/tag/v2.2.0) |
| 提交总数 | 202 |
| 源码规模 | 13,493 行 / 21 个 `.ts` |
| 测试 | **1,112 个 / 149 个文件，全绿** |
| 运行时依赖 | **零** |
| 本地安装 | `C:\Users\FSK\.dsh\profiles\desktop\node_modules\dsh-safe-delete`（30 个文件） |

### 一键验证

```bash
pnpm gate     # 12 项，任一红即非零退出
```

`gate` 包含：typecheck · 测试 · 构建 · 隐私审计 · 文档一致 · 死代码 · 拦截链(25 例) · 设置契约 · **变异检查** · 对抗探针 · 误伤探针 · 客户端渲染

> **为什么强调 gate**：2026-11-04 之前有三个验证脚本不在任何 gate 里，重构后静默失效，而提交信息仍写着「full gate clean」。变异检查尤其危险——锚点漂移会让它**静默 SKIP**，报告出「5 抓 0 漏」这种看起来完美的结果。现在全部串进 `pnpm gate`。

---

## 3. 架构

### 3.1 模块职责

| 文件 | 职责 |
|---|---|
| `index.ts` | 插件入口：配置读取、**pre-execute 钩子**、工具注册 |
| `command.ts` | 命令解析器：判定一条 shell 命令是否会删东西 |
| `delete-core.ts` | 单次删除的核心：描述 → 门禁 → 审批 → 移动 |
| `tools.ts` | 6 个工具的实现，批量删除 |
| `store.ts` | 安全区存储：索引、移动、还原、销毁 |
| `recycle.ts` | 系统回收站：SHFileOperation、配额/策略检测、熔断 |
| `describe.ts` | 目标描述（大小、条目数、顶层内容） |
| `classify.ts` | 路径分类：free / sensitive / protected |
| `prune.ts` / `cleanup*.ts` | 过期清理：后台 worker + 批量聚合回收 |
| `batch-manifest.ts` | 批次清单，崩溃恢复用 |
| `index-lock.ts` | 索引文件锁 |
| `audit.ts` | 审计日志（JSONL） |
| `match.ts` | `root` + `match` 模式的文件枚举 |
| `settings-guide.ts` / `client/` | 设置页 |

### 3.2 关键设计决策

**① 判定逻辑是「正向证明」，不是「找删除证据」**

`command.ts` 从「找删除动词，找不到就放行」改成「逐段正向证明无害，否则要求审批」。前者是黑名单，写法无穷、永远漏；后者默认归宿是「问」。

代价（明示的 breaking change）：执行脚本文件（`python script.py`）现在要审批。

**② 工具内的 `requestApproval` 是恒放行的桩**

```ts
const requestApproval = async (): Promise<ApprovalOutcome> => 'allowed-once'
```

前提是「走到工具执行体，说明管线已经把 `ask` 解决了」。

**因此任何「在工具里问人」的保护都等于没有。** 所有真正需要拦住的判定必须写在 **pre-execute 钩子**里。这是第 24 次审查的 P0 教训（见 §6）。

**③ 清理在独立进程里跑**

`spawn` detached worker，工具调用只投递（9 ms 返回）。起因是 2026-10-30 事故：28,724 条过期条目 × 1 秒节流 → 事件循环被同步 fs 卡死 → 会话无响应。详见 `docs/INCIDENT-2026-10-30.md`。

**④ 回收站用 `SHFileOperationW`，不用 shell 动词**

见 §5.1。

---

## 4. 工具与配置

### 4.1 工具

| 工具 | 参数 |
|---|---|
| `safe_delete` | `path` / `paths` / `root`+`match`+`olderThan`+`exclude`，`preview`，`reason` |
| `safe_zone_list` | `limit`（默认 20，上限 200） |
| `safe_zone_restore` | `id` |
| `safe_zone_status` | 无 |
| `safe_zone_check` | 无 |
| `safe_zone_journal` | `n`（默认 20，上限 200） |

三种形态**互斥**，混用会被拒绝。

### 4.2 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `stateDir` | `<DSH_HOME>/.dsh-safe-delete` | 安全区目录 |
| `retentionDays` | 1 | 保留天数 |
| `autoPrune` | true | 自动清理 |
| **`deleteDestination`** | `safe-zone` | **`safe-zone` \| `recycle-bin`**，`.volatile()` 立即生效 |
| `confirmFileCount` | 5000 | 超过则要求审批（回收站模式下失效） |
| `confirmBytes` | 2 GB | 同上 |
| `blockShellDeletes` | true | 拦截 shell 删除命令 |
| `blockProtectedWrites` | true | 保护关键文件写入 |
| `crossVolumeCopy` | false | 跨卷时复制而非移动 |
| `cleanRequestedAt` | — | 清理请求时间戳 |

---

## 5. 两种删除去向

### 5.1 安全区模式（默认）

- 内容 `rename` 进 `items/<id>/<basename>`（同卷瞬时）
- 索引记录原路径，`safe_zone_restore` 可取回
- **做完整递归统计**，`confirmFileCount` / `confirmBytes` 生效
- 过期后由清理任务送进系统回收站

### 5.2 回收站模式（2.2.0 新增）

- **跳过递归统计**（只量顶层直接子项），删除速度与文件数无关
- 真实路径交给系统回收站，**保留原位置**
- 两个阈值**失效**（依赖统计）
- 失败回落安全区，绝不静默永久删除

**技术细节：用 `SHFileOperationW` + `FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI`**

- `FOF_ALLOWUNDO` 是**承重标志**：没有它 `SHFileOperation` 是永久删除
- `FOF_SILENT`/`FOF_NOERRORUI` 压掉 Windows 的「正在准备回收」进度窗口

**为什么不用 `Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory`**：它的 `UIOption` 只有 `OnlyErrorDialogs` 和 `AllDialogs`，**没有「完全不显示」这一档**。删大目录时会弹出盖在前台的进度窗口，而 `windowsHide` 管不了它（那是 shell 绘制的，不是控制台窗口）。

**为什么不用 `Shell.Application` 的 `InvokeVerb('delete')`**：那等于替用户点了右键删除，shell 照常显示进度 UI，且慢约 24 倍（1187 ms vs 49 ms，主要开销是新建 COM 对象 + `ParseName` 往返）。

---

## 6. 已知边界（**必须如实转达给用户**）

### 6.1 回收站模式

| 边界 | 后果 |
|---|---|
| **配额预检是尽力而为** | 读注册表上限，判单文件与目录顶层。但目录**只量顶层不递归**，嵌套深处的超大文件不触发预警 |
| 读不到注册表 → 判「无风险」 | 不能因为一次读失败就拦住所有删除，但受限环境下这层保护不生效 |
| 超配额条目 | Windows 会**永久删除并返回成功**，插件无法阻止也无法事后感知 |
| 目录名匹配 | `match: "build"` 对名为 `build` 的目录返回 **0 结果**——目录会被递归进入，但目录本身从不加入匹配集。要删整个目录用 `paths: [...]` |

**要保证可恢复，请用安全区模式。**

### 6.2 通用

| 边界 | 说明 |
|---|---|
| `pattern` 形态不枚举 | 钩子只拿 `root` 做分类判定，不扫盘（`node_modules` 量级要 529 ms） |
| `never` 审批策略 | 危险路径降级放行（只剩「可恢复」一层）；但**不可恢复删除明确拒绝** |
| 索引损坏 | 拒绝一切写入，保留原文件。`safe_zone_list` 明确报错而不是显示空列表 |
| 批次聚合回收 | 回收站里记录的是**批次目录**路径，不是每个文件的原路径 |

---

## 7. 最近一轮修复（2026-11-04/05）

8 个发现，**5 个是修改过程中自己引入的**。

| # | 问题 | 性质 |
|---|---|---|
| 1 | 配额检测每个文件读一次注册表（162.8 ms/次 → 1000 文件 108 秒） | 我引入 |
| 2 | 清理时 Windows 弹出「正在准备回收」窗口盖在前台 | 我用错 API |
| 3 | 用字符串拼结构化数据（`split(' : ')[0]` 反推路径） | 我引入 |
| 4 | 改成 JSON 后漏改空清单分支 → 空清理被报成失败 | 我引入 |
| 5 | 路径插值进 AppleScript（含换行就永远删不掉） | 历史遗留 |
| 6 | `HKCU` 缩写前缀 `startsWith` 静默失败 → 配额完全读不到 | **我引入** |
| 7 | `paths` 混入非字符串被静默丢弃（与 `exclude` 报错不一致） | 历史遗留 |
| 8 | `limit` 小数依赖 `slice` 的隐式截断 | 历史遗留 |

### 最值得记住的两个教训

**① 保护写在不会生效的地方**

工具内的 `requestApproval` 是恒放行的桩。把 `permanentDeleteRisk` 的审批写在那里，等于没问。**判定必须在钩子层。**

**② 失败是静默的**

第 6 个：`reg query HKCU\...` 接受缩写，输出却是 `HKEY_CURRENT_USER\...`。`startsWith(root + '\\')` 永远为 false → 卷键列表为空 → 配额读不到 → 超配额文件被判「无风险」→ **静默永久删除**。

不抛错、不打日志，保护性检查只是停止保护。

---

## 8. 验证体系

### 8.1 自动化

```bash
pnpm gate          # 12 项
pnpm test          # 1,112 个测试
```

**变异检查**（`scripts/mutation-check-core.mjs`）会故意破坏保护代码，确认测试变红。当前 **7 抓 0 漏，零 SKIP**。

> 如果它报 SKIP，说明锚点漂移了 —— 那比失败更糟，因为看起来像通过。

### 8.2 真实回收站往返（需要手动跑）

`scripts/` 下没有保留这个脚本（用完即删），但验证过：

- 3 个目标 → 3 条独立回收站记录，**原位置正确**
- 30,000 个文件 → 5.09 秒，`OK=1 FAIL=0`，**全程无窗口**
- 5 个并发任务 → 全部成功，无临时目录残留

### 8.3 **未验证的（重要）**

**从未在真实 DSH 宿主里手动操作过。**

所有验证都在仓库内模拟。以下必须人工确认：

1. 重启 DSH → 设置页两个按钮能点、能保存、刷新后状态保持
2. 选「直接进回收站」→ 删一个测试文件 → 去 Windows 回收站确认存在、原位置正确
3. 点回「放入安全区」→ 删文件 → `safe_zone_list` 能看到 → `safe_zone_restore` 能取回

---

## 9. 常见操作

### 安装 / 更新

```bash
pnpm build
node scripts/sync-install.mjs    # 复制到 profile，陈旧 chunk 走回收站
# 然后重启 DSH
```

### 发版

```bash
node scripts/next-version.mjs
# 改 package.json 版本 → pnpm gate → git commit → git tag -a vX.Y.Z
git push origin main && git push origin vX.Y.Z
```

### 排查

| 症状 | 先看 |
|---|---|
| 删除没反应 | 审批策略是否 `never`；`safe_zone_status` |
| 回收站里找不到 | 是否回落安全区了；`safe_zone_journal` |
| 清理卡住 | `cleanup-job.json`；`cleanup.lock` 是否残留 |
| 配额预警不触发 | 注册表能否读；目录只量顶层 |

---

## 10. 交接要点

### 如果你要改代码

1. **先跑 `pnpm gate`**，确认基线绿
2. 改完**立刻验证**，不要等全部改完——我这轮 5 个自造 bug 里，有 4 个是「改完没立刻跑」的窗口期被发现的
3. **不要用「找最近的注释」作为插入锚点**——文件里有模板字符串含 `/**`，会把字符串切断
4. 跨进程协议（PowerShell / AppleScript / reg）**没有类型系统保护**，改一边必须同步改另一边
5. 加测试时问自己：**删掉这段代码，测试会红吗？** 不会红就是空转

### 如果你要改安全判定

**判定必须写在 `index.ts` 的 pre-execute 钩子里。** 写在工具里等于没写（`requestApproval` 是桩）。

### 当前遗留

- `v2.2.0` tag 指向 `eb2e53c`，之后 6 个提交（含 5 个 bug 修复）**没有 tag**。建议补 `v2.2.1`
- `match: "build"` 匹配目录名返回 0 结果——语义有歧义（删目录本身还是删里面？），未改
- 目录配额只量顶层，嵌套深处的超大文件不预警（已写进 README）

---

## 11. 文档索引

| 文件 | 内容 |
|---|---|
| `README.md` | 用户向：功能、边界、配置 |
| `docs/CLEANUP-ARCHITECTURE.md` | 清理架构与三条已知边界 |
| `docs/INCIDENT-2026-10-30.md` | 会话卡死事故复盘 |
| `docs/COMPATIBILITY.md` | 平台兼容性 |
| `docs/DIAGNOSTICS.md` | 排查手册 |
| `docs/STARTUP-SAFETY.md` | 启动期安全 |
| `docs/VERIFY.md` | 验证方法 |
| `docs/superpowers/specs/2026-11-04-delete-destination-design.md` | 删除去向的设计 |
| `docs/superpowers/plans/2026-11-04-delete-destination.md` | 实施计划 |
