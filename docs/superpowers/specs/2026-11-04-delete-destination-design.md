# 删除目的地开关 + 回收站模式快速路径 设计文档

日期：2026-11-04
状态：已定稿，待实施
版本目标：2.2.0（新增配置项 + 行为变更）

## 意图与原因

两个诉求，来自同一个抱怨「大量删文件时卡顿」：

1. **可选目的地**：让用户选择删除的文件经过安全区，还是直接进系统回收站。
2. **大量删除不卡顿**：用户经常一次删几千上万个文件。

调研 `sugarxl/dsh-safety`（用户点名对照）后确认：**卡顿与回收站无关，与删除前的全树统计有关**。该项目的 `describeTarget` 只读顶层一层，源码注释写明理由：`synchronously on every deny would stall the event loop`。

## 现状（实测确认）

| 环节 | 位置 | 行为 |
|---|---|---|
| 删除前描述 | `src/describe.ts:26-54` `walk()` | **递归整棵树**，每条目一次 `lstatSync`，上限 20 万 |
| 安全区索引 | `src/store.ts:572`（`stageInto` 内） | **再调一次** `describeTarget` |
| 审批钩子描述 | `src/index.ts:508-551` | **第三次遍历**，且文案硬编码「移入安全区，N 天内可恢复」 |
| 批量删除 | `src/tools.ts:360` → `moveManyToSafeZone` | **不走 `deletePath`**，且逐路径 `describeTarget`（`tools.ts:380`） |
| 空间预估 | `src/delete-core.ts:189` | 复用 `description.bytes`，不额外遍历 |
| 删除动作 | `src/store.ts` `stageInto` | 同卷 `rename`，本身很快 |
| 删除后清理 | `src/tools.ts:716` | 已派生独立 worker，不阻塞 |

**一次目录删除最多遍历三遍全树**，全发生在审批卡片出现之前。

索引校验（`src/store.ts:344-350`）只要求 `bytes`/`fileCount` 为非负有限数，写 0 合法。

## 已确定的产品决定（用户拍板）

1. **开关同时出现在配置文件、斜杠命令、设置页**；设置页用**可直接点的按钮**（分段按钮），**不用下拉框**。
2. **检测到系统策略会把删除变成永久删除时，弹窗提示**；用户不同意就**放弃这次删除**。
3. **回收站模式下 `confirmFileCount` / `confirmBytes` 完全失效**（不统计就拿不到数字）。

## 核心决定：统计按模式区分

| | 安全区模式（默认） | 回收站模式 |
|---|---|---|
| 目录全树统计 | 做 | **不做** |
| 单文件 `statSync` | 做（O(1)） | 做（O(1)，免费） |
| 卡片显示 | 共 N 个文件 / X MB | 顶层 N 个条目 |
| `confirmFileCount` / `confirmBytes` | 生效 | **不生效** |
| 大量删除速度 | 与文件数成正比 | 与文件数无关 |
| 恢复方式 | 插件内按条目恢复 | 系统回收站，**保留原路径** |

## 目标

- 回收站模式删除耗时与文件数**无关**（不做全树统计）。
- 新增全局配置 `deleteDestination: 'safe-zone' | 'recycle-bin'`，默认 `safe-zone`。
- 回收站模式**保留原始路径**：用户从回收站还原，文件回到原处。
- 任何情况下都不静默永久删除。

## 非目标

- 不做「每次删除单独选目的地」。
- 不实现「回收站条目的插件内恢复」。
- 不改动清理链路（已是独立进程）。
- 不追求安全区模式也变快。

## 反目标（技术上能跑但算失败）

- 回收站模式逐文件 spawn 一个 PowerShell 进程。
- 把多个目标聚合进一个暂存目录再交给回收站 —— **实测会导致还原路径错乱**（见下）。
- 回收站不可用/有永久删除风险时静默继续。
- 安全区模式仍重复统计。

## 方案与取舍

### 被否决的方案：聚合后一次性交回收站

原设计 C4 打算把 N 个目标 `rename` 进 `recycle-batch/<id>/items/`，再对那个目录调一次回收站。**实测否决**：

- 回收站里只会出现**一个叫 `items` 的文件夹**，原位置记录为 `<stateDir>/recycle-batch/<id>/items`；
- 用户点还原，文件回到那个内部路径 —— 不是他删除的地方；
- 该路径还可能被清理任务删掉。

聚合还会引入：跨卷 `EXDEV`、崩溃后暂存目录无人扫描（成为唯一副本）、把 N 个条目并成一项后更容易超回收站配额。

**结论：不聚合，不动文件位置，直接把真实路径交给回收站。**

### 采用的方案：一个进程内批量 SendToRecycleBin

实测（21 个条目 = 1 目录 + 20 文件）：

| 指标 | 结果 |
|---|---|
| 总耗时 | 3398ms（**162ms/项**） |
| PowerShell 进程数 | **1** |
| 成功/失败 | 21 / 0 |
| 回收站条目 | `file-4.txt`、`file-11.txt` 各自独立 |
| 原位置 | `Temp\dsd-vb-...` —— **正确保留** |

机制：一次 PowerShell 调用，脚本内循环，用
`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory/DeleteFile($path, "OnlyErrorDialogs", "SendToRecycleBin")`。

要点：

- **`OnlyErrorDialogs`** —— 不弹确认框（避免模态对话框把进程挂住）。
- 目录与文件分别走 `DeleteDirectory` / `DeleteFile`。
- 每条 `try/catch` 单独计数，返回 `OK=n FAIL=m` 与逐条错误。
- 路径用单引号转义（`'` → `''`），不拼接进双引号。

## 实现要点（含审查发现的收口）

**1. `describeTarget` 双模式**（`src/describe.ts`）

- 新增 `stats: boolean` 选项：`true` 走现有递归 `walk`，`false` 只读顶层 `readdirSync`。
- **单文件两种模式都 `statSync`**（O(1)，给出真实 `bytes`/`fileCount: 1`）——否则单文件删除会显示「0 条目 0 B」。
- 目录在 `stats: false` 时 `bytes: 0`、`fileCount: 0`，并带 `statsOmitted: true`。

**2. 修掉重复统计**（`src/store.ts:563` `stageInto`）

把 `description` 作为参数传入 `stageInto`，不要在里面再调 `describeTarget`。放在 `stageInto` 而非 `moveToSafeZone`，这样 `moveManyToSafeZone` 也自动受益。

**3. 修掉 `-10 more` 文案 bug**（`src/delete-core.ts:461,485`）

`${d.fileCount - 10} more` 在 `fileCount: 0` + `truncated: true` 时会打印负数。加守卫：仅当 `fileCount > 10` 时输出，否则改用顶层条目数。

**4. 目的地分支要覆盖两条删除路径**

- 单路径：`deletePath`（`src/delete-core.ts:352`）。
- 多路径/模式匹配：`deleteMany` → `moveManyToSafeZone`（`src/tools.ts:360`）。**必须同样分支**，否则「一次删几千个」这条主路径不生效。

**5. 审批钩子要感知模式**（`src/index.ts:508-551`）

钩子里的描述调用按当前模式传 `stats`；文案（`index.ts:575-581`）按模式改写：安全区说「N 天内可恢复」，回收站说「将进入系统回收站」。

**6. 配置项**

```ts
deleteDestination: z.enum(['safe-zone', 'recycle-bin']).default('safe-zone').volatile(),
```

读取时做净化：未知值一律回落到 `'safe-zone'`（防止旧配置/手改配置产生 `undefined`）。

**7. 熔断器修正**（`src/recycle.ts`）

- 成功时**重置**计数（现有逻辑在 `moveToSystemRecycleBin` 内已有，新增路径也要走同一入口）。
- 失败文案不再写「entries stay in the safe zone」（那是清理链路的措辞），改为中性描述。

**8. 永久删除风险 → 弹窗确认**

回收站模式执行前检查：

- 系统策略 `NoRecycleFiles`（`HKCU\...\Explorer\NoRecycleFiles`，或组策略同名项）为真；
- 或本次目标为单文件且 `statSync().size` 超过该卷回收站上限（读 `BitBucket\Volume\*\MaxCapacity`）。

命中任一条 → 通过现有审批通道**弹窗**说明「这次删除会被系统永久删除」，用户拒绝则**放弃本次操作**（返回失败，不动任何文件）。

**9. 设置页：分段按钮，不用下拉框**

`src/client/index.tsx` 增加一种控件：两个并排按钮「放入安全区」/「直接进回收站」，点击即写入 `deleteDestination`。复用现有 `<button>` 样式（参考 `index.tsx:1388` 的「立即清理」）。同步更新 `src/settings-guide.ts` 与 README 的利害说明。

**10. 结果类型**

`DeleteResult` 新增 `{ ok: true; kind: 'recycled'; target; description; gate }`。审查确认 `DeleteResult` 是内部类型，不在工具 JSON schema 里；消费者只有 `tools.ts:740-742`、`index.ts:762`（都经 `describeMoved`，编译期会检查）与 2 处测试断言。

**11. 回收站注入点**

`DeleteContext` 增加 `recycler` 可选字段（对齐 `ToolDeps.recycler`，`tools.ts:143-145`），供测试注入计数用。

## 约束

- 零运行时依赖不变（PowerShell 是系统自带）。
- 工具输入兼容；输出新增 `kind: 'recycled'`。
- 索引格式不变（`bytes`/`fileCount` 仍为数字）。
- 现有 955 条测试继续通过；预期一批断言卡片含字节数的测试需按新文案更新，**逐条记录理由，不删断言**。

## 留给实现者决定的

- 分段按钮的具体样式与文案。
- `NoRecycleFiles` 的读取范围（仅 HKCU 还是含 HKLM 组策略）。
- 单文件超配额时是「拒绝」还是「弹窗确认」——按第 8 条统一走弹窗。

## 验证方式

- **性能**：构造 2 万条目的目录，回收站模式删除，断言不触发递归遍历（`readdirSync` 调用次数上界）且耗时在秒级。
- **路径保真**：回收站模式下删除后，回收站条目的原位置等于删除时的真实路径（不是暂存目录）。
- **进程数**：N 个目标只 spawn 1 个 PowerShell（注入 fake 执行器计数）。
- **两条路径**：单路径 `deletePath` 与多路径 `deleteMany` 都遵守目的地开关。
- **第三处遍历**：审批钩子在回收站模式下不再遍历全树，文案不再提「N 天内可恢复」。
- **阈值**：回收站模式下 `confirmFileCount`/`confirmBytes` 不触发；安全区模式仍触发。
- **回落**：回收站不可用 → 回落安全区，文件仍在，索引 `bytes: 0`。
- **弹窗**：模拟 `NoRecycleFiles` 为真 → 出现确认；用户拒绝 → 文件未动。
- **文案 bug**：`fileCount: 0` + `truncated` 不产生负数文案。
- 全量测试、typecheck、build、隐私审计、死代码扫描、对抗探针全部通过。
