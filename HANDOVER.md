# dsh-safe-delete 交接文档

> 最后更新：2026-11-08
> 版本：**2.3.1**（含目录配额的自适应上界、回收站设置在所有通道生效、插件页正文独立成文件）
>
> **本文件刻意不写 HEAD 与"工作区干净"**：那两栏每次提交都会过期，而读者会拿它当事实
> （第二轮复审 R05、第三轮复审 R06 都指出过这一点）。想知道现在在哪，跑
> `git log -1 --oneline`；想知道测试结果，看 `gate-report.json` 里的 `sha`。

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

> **本节是快照**，日期见文件头。HEAD / 远端 / 测试数字都会随提交变化 ——
> 以 `git log -1` 与 `gate-report.json` 为准，不要引用旧快照里的数字。

| 项 | 值 |
|---|---|
| 版本 | 2.3.1（目录配额自适应上界 + 回收站设置全通道生效 + 插件页正文独立成文件） |
| tag | `v2.3.1`（annotated，指向本版提交；上一个 tag 是 `v2.3.0`） |
| Release | [v2.3.1](https://github.com/fsk2142/dsh-safe-delete/releases/tag/v2.3.1)（上一个：[v2.3.0](https://github.com/fsk2142/dsh-safe-delete/releases/tag/v2.3.0)） |
| 源码规模 | 21 个 `.ts`（约 1.2 万行） |
| 测试 | `tests/` 下的 `*.test.ts`，全绿（**数量会变**：跑 `pnpm gate` 或 `pnpm test` 看当次结果，不要引用本表的数字） |
| 运行时依赖 | **零** |
| 本地安装 | `C:\Users\<user>\.dsh\profiles\desktop\node_modules\dsh-safe-delete` |

> **为什么不再写 HEAD 与"远端已同步"**：那两栏每次提交都会过期，而交接文档的
> 读者会拿它当事实（第二轮复审 R05 正是这么指出来的）。想知道现在在哪，
> 跑 `git log -1 --oneline`；想知道测试结果，看 `gate-report.json` 里的 `sha`。

### 一键验证

```bash
pnpm gate          # 12 项，任一红即非零退出
node scripts/privacy-history-audit.mjs   # 历史隐私（不在 gate 里，见下）
```

`gate` 包含：typecheck · 测试 · 构建 · 隐私审计 · 文档一致 · 死代码 · 拦截链 · 设置契约 · **变异检查** · 对抗探针 · 误伤探针 · 客户端渲染

跑完会生成 `gate-report.json`（**不入库**）：`sha` / `branch` / `dirty` / `at` / `platform` / 逐项 `ok`。提交说明里写「gate 全绿」时，这份文件是唯一可核实的证据。

**历史隐私扫描为什么不在 gate 里**：它扫**全部可达提交**的 diff（数字随提交数增长，实测约 0.5 秒），每次改代码都跑没意义；而且它的命中不会因为"改一下就没了"——那是发布前的检查。4 处已知命中已进 `scripts/privacy-history-baseline.json`（精确到 `SHA + 文件 + 规则`），脚本因此**只在出现新增命中时**返回 1 —— 一个永远红的门禁等于没有门禁。见 §7b。

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
| **配额判定分三态** | 超限 → 弹窗；**完整**大小确认未超 → 静默；**无法确认** → 按风险处理（弹窗，`never` 下拒绝） |
| 目录只量顶层 | 目录大小只是一个**下界**。下界已超 → 确定超限；下界没超 → **unknown**，仍然弹窗（2026-11-05 第二轮 R01 修的就是这一条：此前会静默放行） |
| 读不到注册表 → **unknown** | 不再判「无风险」。受限账户 / 策略拦截 / 非标准卷上，这层保护会**问人**而不是静默失效（第二轮 R02） |
| 超配额条目 | Windows 会**永久删除并返回成功**，插件无法阻止也无法事后感知 |
| 「移进回收站」的语义 | 只是**原路径消失**的观测。插件不读回收站的 `$I`/`$R`，不做「可还原」验证 |
| 目录名匹配 | `match: "build"` 对名为 `build` 的目录返回 **0 结果**——目录会被递归进入，但目录本身从不加入匹配集。要删整个目录用 `paths: [...]` |

**要保证可恢复，请用安全区模式。**

### 6.2 通用

| 边界 | 说明 |
|---|---|
| `pattern` 形态不枚举 | 钩子只拿 `root` 做分类判定，不扫盘（`node_modules` 量级要 529 ms） |
| `never` 审批策略 | 危险路径降级放行（只剩「可恢复」一层）；但**不可恢复删除明确拒绝** —— 包括 `never + recycle-bin + pattern`（目标大小无法预判，工具侧的审批是恒允许的桩）与**解析器抛错**（解析失败 ≠ 放行） |
| 索引损坏 | 拒绝一切写入，保留原文件。`safe_zone_list` 明确报错而不是显示空列表 |
| 批次聚合回收 | 回收站里记录的是**批次目录**路径，不是每个文件的原路径 |

---

## 7. 2026-11-05 首轮复审（固定 SHA `077d27f`）与整改

外部复审报告给出 12 条（A01–A12）。**A01–A04 已在源码中确认并修复**，A05–A10 一并处理；A11（历史隐私扫描范围）与 A12（设计约束）作为已知边界记入本文档，不改代码。

| ID | 问题 | 修复 |
|---|---|---|
| **A01** | `never + recycle-bin + pattern` 绕过真实审批：钩子不枚举目标，工具侧 `requestApproval` 是恒返回 `allowed-once` 的桩 | 该组合**直接拒绝**，理由里给出三条出路；`never + safe-zone` 与显式 `paths` 不受影响 |
| **A02** | `isPureLiteralValue` 只看首尾引号：`["a" + require("fs").rmSync(x) + "b"]` 被判纯字面量 | 改为「整串必须**恰好是**一个字符串」（扫描引号闭合位置 + 转义）；深度 ≤32、单字面量 ≤4 KB |
| **A03** | `pnpm build` / `npm test` / `git pull` 被写成「已证明只读」，但都执行项目自定义内容 | 从白名单移除；保留真正的查询（`list` / `ls` / `why` / `outdated` / `--version`）；`git pull` 单独说明 |
| **A04** | `parseCommand` 抛错时钩子 `next()` —— fail-open | 改为 `ask`（`never` 下 `deny`）；进钩子前先按输入长度上限处理（64 KB） |
| **A05** | `SHFileOperationW` 部分成功时脚本把整批记失败，调用方整批回落安全区 | 脚本改为**逐条复核**是否仍在原处，输出 `moved`；调用方按 `succeededPaths` / `failedPaths` / unknown 三类对账 |
| **A06** | 调用方仍用 `split(' : ')[0]` 从人类可读文案反推路径 | 只读结构化字段；实现没给 `failedPaths` 时记 unknown，**不**回退到字符串解析 |
| **A07** | 审计持久化命令原文（`text.trim().slice(0,200)`）与自由文本 reason | 钩子改记**指纹**（长度 + sha256 前 16 位）；`readAudit` 侧不新增原文 |
| **A08** | `safe_zone_journal` 每次全量读取并解析整个 JSONL | 改为从文件尾部按 16 KB 块回读，凑够 N 条即停（80,000 行下读取量从 11.4 MB 降到数十 KB） |
| **A09** | 重复语句与过期注释（`$present` 连续初始化两次、旧协议注释、错位 JSDoc、`BATCH_SIZE` 写死 500） | 逐条订正；测试里加静态契约（`$present` 只能初始化一次） |
| **A10** | 工具描述与拦截文案写死「进安全区 / 可用 safe_zone_restore 取回」 | 按 `deleteDestination` 生成；README 的删除去向章节同步 |

**A11 / A12（不改代码，记边界）**：`privacy-audit.mjs` 只覆盖工作区 + 暂存区，不覆盖 Git 历史、不可达对象与二进制产物；目录配额只有**下界**（只量顶层），配置风险缓存按 Reader 身份缓存。这些是设计取舍，已在 README 与本节写明。

**新增回归测试**（都能在修复前的代码上变红）：

| 文件 | 覆盖 |
|---|---|
| `tests/audit-20261105-command.test.ts` | A02 / A03（含合法字面量与只读查询的反向用例、深度与长度上限） |
| `tests/audit-20261105-hook.test.ts` | A01 / A04（`never` / `ask` × 单条 / 批量 / 模式） |
| `tests/audit-20261105-recycle.test.ts` | A05 / A06（逐条对账、计数不一致） |
| `tests/audit-20261105-audit.test.ts` | A07 / A08（尾部读取字节数、半行、超长单行、多字节） |

> 反转了一条旧断言：`tests/pattern-never-consistency.test.ts` 过去锁的是「无策略风险时 `never + recycle-bin` 不该拒绝」。那条推理漏掉了**配额**这一类风险（钩子不枚举 → 大小未知 → 工具侧桩放行），现在改为断言拒绝。

---

## 7b. 2026-11-05 第二轮复审（固定 SHA `d08d951`）与整改

上一轮整改后又有一次复审，确认 A01–A10 已进入生产代码，另提 6 条（R01–R06）。本轮修了 R01–R03、R05；R04 部分处理（工具已补，历史内容不重写）；R06 用工具解决（gate 自报 SHA）。

| ID | 问题 | 处理 |
|---|---|---|
| **R01** | 目录配额只量顶层，嵌套深处的 20 GB 文件不触发预警，且判成「无风险」静默进回收站 | `assessQuota` 加 `sizeIsLowerBound`：下界已超 → over；下界没超 → **unknown**，走审批。钩子、`deletePath`、`deleteMany` 三条路径全部接线 |
| **R02** | 注册表读失败 / 值解析不了时返回 `risky: false`（= 确认安全） | `PermanentDeleteRisk` 改为三态 `risky/safe/unknown`；`unknown` 按风险处理。**三个决策点全部接线**：`decideHookRisk`、`deletePath`、`deleteMany` —— 只改函数不改调用点是这一条最容易漏的半边。配额上限同理（`assessQuota` 三态） |
| **R03** | 审计尾部读取**每块单独解码**，多字节字符跨块时被替换成 U+FFFD，路径静默损坏 | 改为累积 `Buffer` 后**只解码一次**；换行在字节层数。测试精确构造「块边界落在续字节上」，修复前实测 2 条记录被破坏 |
| **R04** | `privacy-audit.mjs` 不覆盖 Git 历史与二进制 | 新增 `scripts/privacy-history-audit.mjs`（`git log --all` 的 diff + 提交信息），**明确打印不覆盖的范围**；跳过规则载体/测试夹具并**报出跳过行数**。历史内容本身不重写 —— 见下方「历史命中」 |
| **R05** | HANDOVER 的 HEAD / 远端状态过期 | §2 改成快照 + 明确「以 `git log -1` 与 `gate-report.json` 为准」，不再写会过期的两栏 |
| **R06** | gate 结果只存在于提交说明里，没有与 SHA 绑定 | `gate.mjs` 生成 `gate-report.json`：`sha` / `branch` / `dirty` / `at` / `platform` / 逐项结果 |

**新增回归测试**（都能在修复前的代码上变红）：

| 文件 | 覆盖 |
|---|---|
| `tests/r01-lower-bound-quota.test.ts` | 下界未超 → unknown；下界已超 → over；目录接线 |
| `tests/r02-unknown-risk.test.ts` | 注册表抛错 / 值解析不了 → unknown；配额读不到 → unknown |
| `tests/r03-utf8-boundary.test.ts` | 多字节字符跨 16 KB 块边界（精确构造续字节落在边界上） |

**历史隐私命中（4 处，已在远端历史里，不重写）**：

| 提交 | 位置 | 内容性质 |
|---|---|---|
| `2bc5f62` | `HANDOVER.md:44` | 本机用户名路径（当前版本已脱敏为 `<user>`） |
| `2af67b79` | `docs/INCIDENT-2026-10-30.md:57` | 同上的 PowerShell 举例（当前版本已改写） |
| `f7b445b5` | `src/client/index.tsx:879` | 注释里引用了用户一句界面反馈（当前版本已去掉） |
| `98fe8443` | `scripts/release.mjs:10` | 注释里提到过一次用户现场的反馈语（当前版本已去掉） |

这四处都是**路径 / 措辞**，不是凭据。按 `privacy-history-audit.mjs` 的建议：先判断是否仍是有效凭据（都不是），再决定是否值得改写历史。**改写历史会改变所有下游 SHA**，对一个已公开、已打 tag 的仓库，代价高于收益 —— 所以这里是知情接受，不是遗忘。

这四处现在写进 `scripts/privacy-history-baseline.json`（精确到 `SHA + 文件 + 规则`），历史扫描因此稳在退出码 0；任何**新增**命中仍然失败。凭据类命中永远不能进基线 —— 基线里出现凭据条目时脚本直接退出 2。

---

## 7c. 2026-11-05 第三轮复审（固定 SHA `ddbbb21`）与整改

第三轮复审确认上一轮的 A/R 整改已进生产代码，另提 7 条（R01–R07）。**R01 与 R02 是安全问题**（P1），都落在"不可恢复删除"这条链上；其余是扫描器可靠性与文档准确性。

| ID | 问题 | 处理 |
|---|---|---|
| **R01** | 三态风险函数本身正确，但**生产默认适配器** `readRegistryViaReg` 自己 `catch { return undefined }`，异常到不了外层的三态判定 —— 访问被拒绝 / `reg.exe` 起不来 / 输出解析不了，全都变成 `safe`（= 不问、直接进回收站） | 读取结果改为**判别式类型** `{kind:'value'\|'missing'\|'error'}`，`undefined` 不再被接受。默认适配器 `createRegReader()` 用**同语言控制探针**区分"找不到"与"读不了"：正值探针 `reg query HKCU\Software` 必须成功，负值探针取本机"找不到"消息，目标查询与之**逐字相同**才判 `missing`。不比对任何绝对文本，因此换系统语言不会静默退化。值行按"值名整列相等"匹配（旧 `includes` 会把 `NoRecycleFilesBackup` 当主值） |
| **R02** | 多卷配额：某个卷读失败时**跳过**该卷，取成功卷的最小值当成全局上界，并缓存这个不完整结果。D 盘 500 MB 读失败、C 盘 10 GB 成功 → 缓存 10 GB → D 盘的 1 GB 文件被判"没超"→ 永久删除 | `quotaLimitBytes` 改为返回 `QuotaLimit = known \| unknown`；**任意卷**读失败 / 值缺失 / 0 / 负数 / NaN / Infinity → 整体 `unknown`。缓存的是三态结论而不是数字：`unknown` 可以记住（不可能变成错误的安全结论），不完整的最小值不能 |
| **R03** | 历史扫描按**文件路径**跳过 `tests/` 与 `*.test.ts` 的**全部规则**，包括凭据 —— "真 token 误写进测试文件、后来删掉"这种**只有历史扫描能发现**的泄露永远报不出来 | 豁免改成**按规则**：`fixtureSkippable` 只给上下文规则（本机路径、对话痕迹、会话标识）。凭据 / Token 与邮箱在规则载体与测试文件里**照扫** |
| **R04** | 文件头文档写着 `--staged`，但脚本根本不读 `process.argv` | 删除那条说明，并让**未知参数直接退出 2** —— 一个被静默忽略的安全审计参数比没有更危险 |
| **R05** | 4 处已确认的历史命中没有基线，脚本永远返回 1 | 新增 `scripts/privacy-history-baseline.json`，精确到 `SHA + 文件 + 规则`。基线内命中单独打印为「已接受」，只有**新增**命中让门禁变红。基线读不懂 → 退出 2（不能当成空基线）。**凭据条目出现即退出 2**，永不放行 |
| **R06** | HANDOVER 头部仍写 `HEAD: 077d27f · 工作区干净`，正文还写死测试文件数 | 头部删除 HEAD 与"工作区干净"字段；测试数与提交数不再硬编码，改为"跑 `pnpm gate` / `git log -1` 看当次结果" |
| **R07** | `gate-report.json` 被 `.gitignore` 忽略，远端历史上没有这份报告，CI artifact 未确认 | 见 §8.1 —— 报告由脚本自报 SHA / dirty，但**当前没有 CI**，所以它以本地文件形式存在，不以提交形式存在。这是已知限制，不是"已验证" |

**新增回归测试**（都能在修复前的代码上变红）：

| 文件 | 覆盖 |
|---|---|
| `tests/review3-r01-registry-adapter.test.ts` | T01 访问拒绝 → unknown；T02 确认不存在 → safe；T03 `reg.exe` 起不来 → unknown；T04 输出解析不了 / 值名相近 → unknown；外加真实 `reg.exe` 契约（4 条） |
| `tests/review3-r02-quota-partial.test.ts` | T05 双卷一成功一失败 → unknown（含抛错、0、负数、NaN、Infinity）；T06 不完整结果不转化为数字缓存；未知结论仍只读一次 |
| `tests/review3-r03-history-scan.test.ts` | T07 测试文件里曾提交后删除的 token 仍报；T08 `--staged` 被拒绝（退出码 2）；T09 基线精确覆盖 / 新增仍红 / 凭据不可基线 / 坏基线退出 2 |
| `tests/review3-selfcheck-runtime-guard.test.ts` | 读取函数返回 `undefined` / `null` / 数字 / 无 `kind` 的对象时收敛成三态而**不抛错**；调用点仍排在 `createTools()` 与钩子注册之前 |
| `tests/privacy-audit-sdp.test.ts` | 新增一条：本仓库当前审计通过；基线文件没有被整份塞进 `SCANNERS`；两个扫描器的规则标签都不含自己的触发词 |

---

## 7d. 提交后自检（2026-11-05，`ba15a12` 已推送后）

按用户的四项要求（插件 BUG / 隐私泄露 / 无用文件与缓存 / 异常注释）复查刚推的提交，**找到 2 个真实问题，都是我这一轮自己引入的**。

| # | 问题 | 性质 | 处理 |
|---|---|---|---|
| 1 | 运行时兜底缺失：`RegistryReader` 的类型收窄成判别式后，漏网的 `undefined` / `null` 会让 `detectPermanentDeleteRisk()` 抛 `TypeError` | **我引入**（P1） | 加 `coerceRegistryRead()`：不认识的返回值一律判 `unknown`。类型层防"写错"，运行时层防"加载崩" |
| 2 | 规则标签含自己的触发词：这条规则原来的标签在括号里写了它的一个检测词，而那个词正是该规则的分支，导致**任何写出规则名的文件**（基线、报告、文档）都被判泄露 | **我引入**（P1） | 标签改成 `对话痕迹`，并把上一轮为此加的 `ignoreFiles` 豁免**删掉** —— 那是给症状打补丁 |

第 1 条为什么算 P1 而不是无关紧要：`applyInner()` 在**第 281 行**同步调用它，而 `createTools()`（339）与 `on('tools/pre-execute')`（924）都在后面。`apply()` 是 fail-soft 的，所以宿主不会崩 —— 但插件会变成完全无效（`safe_delete` 不注册、拦截线不接），失败只在日志里留一行。**一个保护性检查的崩溃让保护完全消失**，比它想修的 fail-open 更糟。

> 我第一次把这条写成"`apply()` 没有 try/catch"—— 那是**没读代码就下的判断**。`apply()` 有 try/catch（第 170–181 行）。影响面因此从 P0 降到 P1：不是"宿主崩溃"，而是"插件静默失效"。这个区别决定了要不要半夜发版，所以值得较真。

第 2 条的教训值得单列：**标签是标识，不该与它检测的内容同形**。我第一次的修法是给那个文件加 `ignoreFiles` 豁免 —— 那会让「每多一个要写规则名的文件就多一条豁免」，把症状按文件数重复一遍。正确的修法是把触发词从标识里拿掉，一次解决。

**自检里确认没问题的**：

- 无用文件：`git status --ignored` 只有 `.superpowers/`、`gate-report.json`、`node_modules/`（都在 `.gitignore` 里，且都是刻意忽略的）；探针脚本 `zz-probe-undefined.ts` 用完已删；仓库根没有 `*.log` / `*.tmp` / `*.orig` 残留
- 隐私：工作区扫描 6 条规则全绿；历史扫描 7 处在基线内、**0 处新增**
- 死代码：0 个零引用导出、0 个无人导入的文件
- 异常注释：清掉了 `src/recycle.ts` 里一段描述**旧配额行为**的孤立文档注释（`quotaLimitBytes` 改签名后它已经失真，留着就是错误信息）

---

## 7e. 发版前自检（2026-11-05，第四轮）

按同样的四项要求（插件 BUG / 隐私泄露 / 过期注释 / 无用文件）在发 2.3.0 前又查了一遍，**找到 1 个真实的功能缺口**——这次不是我自己引入的，是**前四轮复审都漏掉的**。

| # | 问题 | 性质 | 处理 |
|---|---|---|---|
| 1 | **每卷 `NukeOnDelete` 策略从未被检查** | **历史遗留**（P1） | `detectPermanentDeleteRisk()` 增加每卷检查；任一卷 `=1` → risky；某卷读不到 → unknown |

### 为什么这条重要

判「删除会被永久执行」原来只看一个**全局**开关：

```text
HKCU\...\Policies\Explorer\NoRecycleFiles
```

但 Windows 还有一条**按卷**的开关，就在插件为了读配额**已经访问**的那个键下面：

```text
HKCU\...\Explorer\BitBucket\Volume\{GUID}
    MaxCapacity    REG_DWORD    0x...   ← 配额，读了
    NukeOnDelete   REG_DWORD    0x1     ← 永久删除，从来没读
```

`NukeOnDelete = 1` 表示该卷**不使用回收站**。它比 `NoRecycleFiles` 更隐蔽：全局策略没动，只把系统盘设成清空就行——而那正是想彻底删干净的人会做的配置。

后果与前几轮修的那几条完全一样：三个决策点都判 `safe`，不弹审批；用户以为文件进了回收站（UI 文案也这么说），实际已经没了。

### 为什么前几轮没发现

R01/R02 修的是**读取失败**的处理（读到了但异常 / 部分卷失败）。这一条是**压根没读**——同一类失败形态（静默放行），完全不同的根因。复审报告都在看「已经读到的东西怎么处理」，没人问「该读的东西读全了吗」。

这条恰好说明：**复审能发现实现与它自己声明的契约不一致，但发现不了契约本身漏了一项。**

### 判据

三态，与全局策略一致：

| 事实 | 状态 |
|---|---|
| 任一卷 `NukeOnDelete = 1` | **risky** |
| 全部卷读到且为 0（或该值不存在，默认 0） | **safe** |
| 列不出卷 / 某卷读不到 / 值解析不了 | **unknown** |

「任一卷为 1 就 risky」是刻意的保守：钩子层拿不到可靠的「目标 → 卷」映射，所以按最坏情况问人。误报的代价是多一次点击，漏报的代价是不可恢复的数据丢失。要精确消除误报，得把每卷策略与目标实际所在的卷对应起来（需要额外查询盘符到卷 GUID 的映射），那是另一个工作量。

### 验收

`tests/review4-nuke-on-delete.test.ts`（7 条）。其中 3 条在修复前的代码上变红（stash 掉 `src/recycle.ts` 验证过），覆盖：卷设了 `NukeOnDelete=1` 要报、全部为 0 要放行、列不出卷要 unknown、某卷读不到要 unknown。

**本轮其他项都干净**：

- 无用文件 / 空文件夹：`Get-ChildItem -Recurse -Directory` 无空目录；`git status --ignored` 仍只有 `.superpowers/`、`gate-report.json`、`node_modules/`（刻意忽略）；无 `*.log` / `*.tmp` / `*.orig` / `zz-*` 残留
- 隐私：工作区 6 条规则全绿；历史扫描 7 处在基线内、**0 处新增**；本轮 diff 里无凭据 / 真实路径
- 过期注释：`readRegistryViaReg` 已彻底移除且无残留引用；无「读不到时不判风险」这类已被推翻的说法残留；README 的永久删除说明已同步成两个开关
- 文档：HANDOVER 的 §7 子节按时间重排（原来 7c/7d/7e 顺序错乱，是前几轮插入时没看顺序）

---

## 7g. 2026-11-08：目录配额的下界把所有目录删除都判成风险

### 症状

一个 244.8 MB 的备份目录，`deleteDestination` 已经是 `recycle-bin`、本机回收站上限 49686 MB（约 48.5 GB），删不掉。钩子拒绝，理由是「无法在不枚举的前提下证明它可恢复」。

`never` 策略下这个组合是**必然**发生的，不是偶发：

1. 回收站模式刻意不递归统计目录（6000 文件 529 ms，而钩子对每次工具调用都跑），只量顶层 → `bytes` 是一个**下界**；
2. `assessQuota` 对「下界小于上限」返回 `unknown` —— 这个判断本身没错，下界确实不能证明真实大小；
3. 钩子把 `unknown` 当风险 → `ask`；
4. `never` 下管线驳回 `ask` → 变成**拒绝**。

于是**任何目录**在 `never + recycle-bin` 下都删不掉，与它实际多大毫无关系。

### 为什么当初这么写不算错，但现在必须改

`unknown` 的保守是**正确**的：下界 0 字节、深处藏 60 GB 的目录确实存在，而那正是会静默永久删除的形态。错的是**没有出口** —— 判定只有「不知道就拒绝」，没有「不知道就去查清楚」。

所以修法不是放宽判定，而是**补上取证手段**。

### 修法：有界早退枚举

新增 `measureTreeBounded(path, limitBytes)`（`src/describe.ts`），三态返回：

| 结果 | 含义 |
|---|---|
| `exact` | 走完整棵树，`bytes` 是确定总大小 |
| `over` | 累计已超上限，**提前停止**；`bytes` 确定超过上限 |
| `incomplete` | 出错 / 撞到条目上限 / 根不可读 |

关键在于**早退**：一旦累计超过上限就立刻停，继续走不会改变结论。所以代价只落在「确实小于上限」的目录上 —— 而那正是删除时本来就要遍历的树。超限的目录反而**比以前更省**（走到上限就停，不用走完）。

语义与 `describeTarget` 的 `walk` 对齐：不跟随符号链接、链接按 0 字节计、读不到就退回 `incomplete`（绝不少算）。

### 接线位置

`assessQuota` 新增可选 `measureBounded`，**只在 `sizeIsLowerBound === true` 时**调用；`decideHookRisk` 新增可选 `measureBounded(target, limitBytes)`，只对下界目标调用。

钩子**只在 `never` 下传它**（`src/index.ts`，`decideHookRisk` 调用点）：

- `never`：`unknown` 等于拒绝，必须付这次遍历换确定结论；
- `ask` / `absent`：`ask` 本来就能弹卡，没有理由为了一次审批去遍历整棵树。

### 验收

`tests/quota-directory-bounded.test.ts`（13 条）+ `tests/hook-directory-bounded.test.ts`（5 条）。

**修复前 12 条变红**（`git stash push -- src/` 验证过），覆盖：整套枚举三态、嵌套累加、链接不跟随、早退确实没有走完、条目上限退回 `incomplete`、`exact` 小目录放行、`exact`/`over` 超限仍然 `ask`、只有下界目标才触发遍历。

### 仍然存在的限制

**模式形态**（`root` + `match`）在 `never + recycle-bin` 下**仍然直接拒绝**（`src/index.ts:530`）。那条分支连目标清单都没有，要证明就得先枚举 —— 而枚举正是模式形态存在的意义。有界早退只能在**已知目标**上工作。

出路写在拒绝理由里：传显式 `paths`、临时切 `ask`、或把目的地改回 `safe-zone`。

---

## 7h. 2026-11-08 续：回收站的设置必须在**每一条**通道上生效

### 症状

用户把 `deleteDestination` 设成 `recycle-bin`，得到的却是三种行为：

```
safe_delete 工具     → 检查后进回收站   ✅
/safe-delete <路径>  → 进安全区         ❌ 设置被忽略
CLI delete <路径>    → 进安全区，目录一律删不掉
```

用户的判断是对的：「两个选项里有一个不起作用，等于只做了一个」。

### 三个独立根因

| # | 根因 | 后果 |
|---|---|---|
| 1 | `commandAdapter` 与 CLI 调 `deletePath` 时**都没传 `destination`**（它可选，缺省 `safe-zone`） | 设置被静默忽略；预览文案读真实配置，于是它说"会进回收站"而实际进安全区 —— 承诺与行为相反 |
| 2 | `deletePath` / `deleteMany` 用 `assessQuota(…, { sizeIsLowerBound })` 判配额，目录恒 `unknown` → 要审批；CLI 的 `requestApproval` 恒 `rejected` | CLI 删不了**任何**目录，哪怕几 KB |
| 3 | 7g 的有界枚举只接在**钩子层**，工具体 / 斜杠命令 / CLI 三条路都没接 | 它们仍停在"下界 → unknown" |

### 修法

- `commandAdapter` 与 CLI 都传 `destination`；CLI 新增从 profile patch 读 `deleteDestination`
- `delete-core` 与 `tools` 在目录下界不足以判定时**默认**做有界枚举，不再要求调用方记得传可选字段（漏传就退回"一律问人"，那正是 CLI 删不掉东西的原因）
- `createSharedMeasure` 从插件入口移到 `describe.ts` —— `delete-core` 与 `tools` 都要用它，不该为了一个预算函数去 import 整份 `apply`

### 语义没有放宽

| 情况 | 行为 |
|---|---|
| 实测证明放得下 | 放行 |
| 实测超过上限 | 仍然审批 |
| 枚举失败 / 超预算 | 退回 `unknown`，仍然审批 |

### 验收

`tests/destination-wiring-all-routes.test.ts`（8 条，**5 条在修复前变红**）。

`tests/r01-lower-bound-quota.test.ts` 里有一条旧断言被新语义推翻：「下界没超就问人」收紧成「下界没超**且测不出来**才问人」。已按新语义改写，并补了反面用例（枚举证明放得下时不弹卡）。

真实工程目录实测（不经测试替身）：`synth`（顶层下界约 730 KB）与 `doc`（约 337 KB）在回收站模式下均 `asked=0`。

---

## 7i. 2026-11-08 续：插件页正文独立成文件

### 为什么反复修不好

前两次都改**设置组件的文案**，而屏幕上的大段内容是**详情文档整篇**渲染 —— 改的是另一个地方。

真正的约束一直没查清楚：DSH 的详情文档按固定顺序选源：

1. `locale/<语言>.json` 的 `meta.detail` 指向的 Markdown
2. 包根的 `README.md`
3. 仓库 README（只有市场条目）

之前只用得上第 2 条，于是 README 被迫兼任「npm 项目说明」与「插件界面正文」—— 它天然会越长越全，插件页就成了开发笔记。

### 修法

用第 1 条：新增 `locale/zh.json` / `locale/en.json`，`meta.detail` → `docs/DETAIL.md`（46 行，只有删除 / 取回 / 设置 / 遇到提示）。

| 文件 | 行数 | 用途 |
|---|---|---|
| `docs/DETAIL.md` | 46 | 插件页正文 |
| `README.md` | 35 | 项目说明 |
| `docs/REFERENCE.md` | — | 参数表、配置全表、路径分级、审批策略 |
| `docs/BOUNDARIES.md` | — | 保证什么、不保证什么、为什么 |

### 连带改动

- `package.json` 的 `files` 补 `locale/` 与 `docs/`。locale 不发布则 `meta.detail` 读不到；docs 不发布则详情页指向不存在的文件，报 `DetailFailure invalid`
- `check-docs.mjs` 的校验对象从 README 换成 `docs/REFERENCE.md` —— 检查不删，只是搬家
- `sync-install.mjs` 增加同步 `locale/` 与 `docs/`

### 验收

`tests/plugin-page-detail-source.test.ts`（6 条）守住：locale 声明 detail、detail 文件存在、路径形如 `docs/*.md`、DETAIL 与 README 都不再长成手册、`files` 确实发布这两个目录。

---

## 7j. 2026-11-10 复审（固定 SHA `90c7756`）与整改

外部复审给出 15 项。逐条核对源码后**13 项成立**，1 项是设计取舍（D13），
1 项是注释层面（D15）。这一节只记**根因**与**为什么之前没发现**，
细节在各自测试文件的头注释里。

### 最严重的不是报告说了什么

**D05 我按原样复现了**：造一个 `installed/lib/chunks` 指向外部的 Windows
junction，跑真实的 `scripts/sync-install.mjs` —— 它崩在
`ERR_FS_CP_DIR_TO_NON_DIR`（那反而救了一半），但**崩之前已经执行完
`pruneStale`**，`outside/OUTSIDE_MARKER.txt` 被移进了系统回收站。
我在回收站里找到了它。报告说的"词法前缀成立但真实路径越界"不是推演。

**D04 也复现了**：插件 `apply()` 时创建 `createSharedMeasure()`，那个闭包在
创建瞬间就记下 `deadline = Date.now() + 1500`。实测 1.8 秒后同一闭包：
`{"kind":"incomplete","reason":"... budget ... exhausted"}`。

### 共同的根因

**"修了这条路径"不等于"修了这一类路径"。** D01/D03/D04/D06 都是同一个形状：

| 项 | 修好了一条 | 漏了另一条 |
|---|---|---|
| D01 | `safe_delete` 查策略与配额 | 后台 Worker 不查 |
| D03 | 模型工具经钩子审批 | 斜杠命令不经过钩子，却共用那个恒放行的桩 |
| D04 | hook 每次调用新建预算 | 工具执行体用的是 apply 时的闭包 |
| D06 | `lib/` 有陈旧检测 | `locale/` `bin/` 根本不同步 |

前四轮的复审都在看「这条判定对不对」，没人问「这个判定在**所有入口**上
都跑了吗」。D02 是同一件事的另一面：把 `never` 当成"放行开关"而忘了它
只该关闭"弹窗"。

### 改法

| 项 | 改动 |
|---|---|
| D01 | `recycleBatch` 在交给 recycler 前插闸门；拒绝就搬回 `items/`、记 `blockedReason` |
| D02 | `never` + 不可解析删除 → `deny`（附可执行的下一步） |
| D03 | 斜杠命令用自己的、会拒绝的 `requestApproval` |
| D04 | `ToolDeps` / `DeleteContext` 换成工厂 `makeMeasureBounded()` |
| D05 | `lstatSync` 认链接 + `realpathSync` 核真实位置；拒绝并报告 |
| D06 | 以 `package.json#files` 为唯一清单 |
| D08 | 有去向不明的条目 → `ok: false` |
| D09 | 系统提示末句跟目的地走 |
| D10 | 成功 ≤3 条、失败/未知 ≤10 条，总数完整 |
| D11 | `reason` 先脱敏再截断 |
| D14 | 配额缓存 60 秒 TTL |
| D15 | 三条过期注释按现行契约改写 |

### 没改的两项

- **D13**（未知命令频繁弹审批）：`command.ts` 的"必须正向证明只读"是**设计**，
  报告自己也说"不能为了静默把所有未知命令自动放行"。记录为体验债务。
- **D07**（safe-zone 扫描无墙钟预算）/ **D12**（工具适配契约）：需要先有
  Windows 与大目录的实测数据再动。**在测之前不动**，避免凭感觉重构。

### 验收

新增 11 个测试文件；关键用例在修复前**全部变红**。
三个既有测试按新契约调整 —— 其中一个（`never-policy-fallback`）原来的断言
是"`never` 下应当 allow"，那正是 D02 的缺陷本身。

177 文件 / 1313 条全绿，`pnpm gate` 12/12。

---

## 7f. 附：2026-11-04/05 自检修复（更早的一批，按时间排在最后）

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
pnpm gate                                 # 12 项
pnpm test                                 # 全部单元测试
node scripts/privacy-history-audit.mjs    # 历史隐私（发布前跑，不在 gate 里；无参数）
```

历史扫描接受**已审核基线** `scripts/privacy-history-baseline.json`（精确到 `SHA + 文件 + 规则`）：基线内的命中单独打印为「已接受」并返回 0，**新增**命中返回 1，环境/基线不可用或基线里出现凭据条目返回 2。

**变异检查**（`scripts/mutation-check-core.mjs`）会故意破坏保护代码，确认测试变红。当前 **7 抓 0 漏，零 SKIP**。

> 如果它报 SKIP，说明锚点漂移了 —— 那比失败更糟，因为看起来像通过。

**`gate-report.json`** 由 `gate.mjs` 写出（不入库）：`sha` / `branch` / `dirty` / `at` / `platform` / 逐项结果。提交说明里写「gate 全绿」时，这是唯一可核实的证据；`dirty: true` 的报告不代表那个 SHA。

> **已知限制（第三轮复审 R07）**：本仓库**没有 CI**（没有 `.github/`），所以这份报告只以**本地文件**形式存在，远端历史里没有对应 artifact。审阅者拿到的是一个提交 SHA 加一句"gate 全绿"，仍然无法独立核验。真要闭环，需要加一条 CI 作业把 `gate-report.json` 按 SHA 上传为 artifact；在那之前，这条只能算"已实现生成"，不能算"已验证"。

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

另外两件只有真机能确认的事：

- **`SHFileOperationW` 的部分成功行为**：`moved` 是靠「原路径是否还在」推断的，插入真实的权限拒绝 / 锁定文件才会走到那条分支（需要在可丢弃的测试卷上做）。
- **注册表受限时的三态**：`unknown` 分支在正常账户上永远不会触发；用受限账户或组策略拦 `reg` 才能验证它确实变成了「问人」而不是「放行」。

---

## 9. 常见操作

### 安装 / 更新

```bash
pnpm build
node scripts/sync-install.mjs    # 复制到 profile，陈旧 chunk 走回收站
# 然后重启 DSH
```

> **2026-11-09 起 chunk 名不带哈希**（见 `tsdown.config.ts` 的 `chunkFileNames`）。
> 在此之前，构建产物叫 `store-B14ysChF.js` 这种形状，每次构建都换一批新名字；
> 于是 `sync-install.mjs` 会把 profile 里的 chunk 全换成"本地构建的那一套"，
> 而 `package.json` 版本号没变 —— 插件管理器再装同一 spec 时 pnpm 判定
> 「已是最新」，直接跳过，安装目录就**永久停在半套文件**的状态（只能 `--force` 修）。
> 现在名字固定为 `chunks/store.js`，本地构建与 tarball 产生同一组名字，覆盖是安全的。

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

三条已有的不变量，改动时别破坏：

1. **未知 = 问**（`never` 下 = 拒绝）。解析器抛错、目标不可解析、`never + 回收站 + pattern`、**风险判定为 unknown**（注册表读不到、目录只量了顶层）都走这条。
2. **「已证明只读」只装真正能证明的项**。执行项目自定义脚本的入口（`run` / `build` / `test` / `lint` / `typecheck` / `start`）不在里面。
3. **去向按条报告**。任何「整批一个布尔」的汇总都会在部分成功时骗人；`succeededPaths` / `failedPaths` / unknown 三类必须分开。

第 1 条的推论：**任何 `X ? 'risky' : 'safe'` 形式的二态压缩都值得怀疑**。R02 的根因就是把「读到了且没设置」「读不到」都写成了 `risky: false`；R01 的根因是把「没超」「不知道」都写成了 `undefined`。加判定时先问：这个函数的返回类型能不能表达"我不知道"？

第 1 条的第二个推论（第三轮复审 R01 的教学案例）：**三态函数本身正确，不等于调用链上是三态的**。`detectPermanentDeleteRisk` 上一轮就改成了三态，但它的默认适配器仍然 `catch { return undefined }` —— 异常在到达判定之前就消失了。函数签名改了要看**每一个返回 undefined 的地方**：那里是不是把两种状态压成了一个值？

### 当前遗留

- `v2.3.1` 是本版 tag（annotated）。上一个 `v2.3.0` 指向 `4ddbbc3`，保持不动。
- `v2.3.0` 曾含 breaking change（相对 2.2.0）：`pnpm build` / `npm test` 现在要审批，`never + 回收站 + pattern` 现在直接拒绝
- `match: "build"` 匹配目录名返回 0 结果——语义有歧义（删目录本身还是删里面？），未改
- **目录配额的下界问题在 2.3.1 已有出口**：下界不足以判定时做一次有界早退枚举（1.5 s 整批共享预算，超了退回 unknown）。但这仍不是"精确统计所有情况"——超预算或撞条目上限时仍然问人。模式形态（`root` + `match`）在 `never + 回收站` 下依然直接拒绝，它连目标清单都没有
- `privacy-audit.mjs` 只扫工作区 + 暂存区；历史扫描现在是独立脚本 `privacy-history-audit.mjs`，**范围有限**（不覆盖 reflog / 不可达对象 / 二进制 / Release 附件）。发布前仍应跑 `gitleaks` / `trufflehog`
- 历史里 4 处命中是**知情接受**，不是遗忘（见 §7b 表格），已写进 `scripts/privacy-history-baseline.json`
- **没有 CI**（没有 `.github/`），所以 `gate-report.json` 只是本地文件，远端没有对应 artifact（第三轮复审 R07）
- `reg` 的"找不到 vs 读不到"依赖**同语言控制探针**：同一台机器上两种消息必须不同。如果某个系统把这两种失败都输出成同一条消息，适配器会把"读不到"判成"不存在" —— 那时正值探针仍能挡住"整台机器 reg 全挂"的情况，但挡不住"只有目标键被拒绝且消息与找不到相同"。这是设计取舍，写在这里是为了不被当成"已完全闭环"
- **每卷 `NukeOnDelete` 按最坏情况判**：插件在钩子层拿不到可靠的"目标 → 卷"映射（盘符到卷 GUID 还要额外查询 `mountvol` / `IOCTL`），所以只要有**任一**卷设了 `NukeOnDelete=1`，所有回收站模式的删除都会判为「删除即永久」并弹窗。这是刻意的误报方向：多一次点击 vs 数据不可恢复。要精确消除误报，需要把每卷策略与目标的实际卷对应起来
- 目录全树统计仍在宿主进程同步执行（复审 A12 第 4 点），大目录有可见延迟；要动之前先测，不要凭感觉搬进 Worker

---

## 11. 文档索引

| 文件 | 内容 |
|---|---|
| `README.md` | 用户向：怎么删、怎么取回、提示什么意思（**插件页整篇渲染它**，所以只放操作说明，35 行） |
| `docs/REFERENCE.md` | 参数表、配置全表、路径分级、审批策略、兼容性 |
| `docs/BOUNDARIES.md` | 保证什么、不保证什么、为什么（第 2 层边界 / 两个开关 / 2.0 锁变更 / 保护范围 / 证明只读） |
| `docs/DEVELOPING.md` | 开发命令、验证脚本、两套隐私扫描的分工 |
| `docs/CLEANUP-ARCHITECTURE.md` | 清理架构与三条已知边界 |
| `docs/INCIDENT-2026-10-30.md` | 会话卡死事故复盘 |
| `docs/COMPATIBILITY.md` | 平台兼容性 |
| `docs/DIAGNOSTICS.md` | 排查手册 |
| `docs/STARTUP-SAFETY.md` | 启动期安全 |
| `docs/VERIFY.md` | 验证方法 |
| `docs/superpowers/specs/2026-11-04-delete-destination-design.md` | 删除去向的设计 |
| `docs/superpowers/plans/2026-11-04-delete-destination.md` | 实施计划 |
