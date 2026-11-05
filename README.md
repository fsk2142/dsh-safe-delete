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
| `match` | glob，相对 root：`**` 跨层、`*` 同层、`?` 单字符、`{a,b}` 多选。省略则匹配全部文件 |
| `olderThan` | `30m` / `6h` / `7d`，按修改时间筛选。裸数字按天 |
| `exclude` | 相对 root 的 glob，命中即跳过。**exclude 优先于 match** |

匹配为空时报错（不是静默成功），并在错误里给出扫描过的条目数。

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

`deleteDestination=recycle-bin` 时**没有第 1 层**：文件直接进回收站，`safe_zone_list` 里看不到它，`safe_zone_restore` 也取不回它 —— 那条路只有系统回收站。拦截裸 shell 删除时给出的提示会按当前配置改写，不会在回收站模式下错误承诺 `safe_zone_restore`。

### 第 2 层的边界（R-01）

「移入系统回收站」不是无条件的第 2 次机会。以下是实测确认的边界：

| 情况 | 实际结果 |
|---|---|
| 同卷移动到回收站 | 进回收站，可从资源管理器还原 |
| 跨卷（源在 D、安全区在 C） | 安全区在 C 盘**真实占一份空间**；清理时只还回 C 盘，D 盘那份早已让出 |
| 安全区所在卷的文件系统不支持回收站 | 直接永久删除，**没有第 2 层** |
| 回收站被组策略关闭 | 同上 |
| 超过回收站配额 | 按系统策略处理（通常是永久删除最旧的） |

**能保证的是**：第 1 层（安全区）始终可用，`safe_zone_restore` 一定能把内容取回，
直到保留期结束。

**不能保证的是**：第 2 层一定存在。依赖它做"最终保险"是不可靠的 ——
保留期内的安全区才是可靠的那一层。

## 路径分级

| 分级 | 范围 | 行为 |
|---|---|---|
| `free` | 工作区、系统临时目录、其他盘 | 直接进安全区 |
| `confirm` | 家目录、`$DSH_HOME` 下非清单内容、profile 目录 | 弹审批卡 |
| `protected` | profile 清单/补丁/lockfile、`node_modules`、安装目录**及其祖先**、安全区自身 | 弹审批卡 |

### 2.0 的破坏性变更：清理锁不再自动接管

**这是 2.0 唯一的破坏性行为变更，升级后请注意。**

以前，清理进行中若进程崩溃，锁会留在磁盘上；下次清理会因为"持有者已死"而
自动接管那把锁。1.11 之前一直是这么做的。

现在**不再自动接管**。原因是接管协议无法保证互斥——两轮审查各找出一个反例，
最后用真实时序证明：

```
B: 读到陈旧锁，判定可接管
A: 接管成功，建了活锁，开始工作
B: rename(lockPath, tombstoneB)   ← 搬走的是 A 的活锁
B: token 不符 → 退出，但锁路径已经空了
C: write(wx) 成功 → C 也进入工作体
→ A 从未被停止；A 和 C 同时改索引
```

事后比对 token 只能让 B 退出，不能让 A 恢复所有权。真正的修复需要 OS 级锁句柄
（`fcntl` / `LockFileEx`），与本插件的零运行时依赖冲突。

**实际影响**：如果清理进程崩溃，后续清理会**明确失败**并告诉你锁文件的路径。
手动删除那个文件即可恢复：

```
# 默认位置
%USERPROFILE%\.dsh\.dsh-safe-delete\cleanup.lock
```

失败信息里会写出完整路径，直接照做即可。代价是可能需要人工介入一次；收益是
索引不会被两个进程同时写坏。

### 保护范围到哪为止（R-02）

本插件只保护**经过 DSH 工具调用**的删除 —— 也就是 `safe_delete` 工具、
`/safe-delete` 斜杠命令、以及 `bash` 类工具里能被静态识别的删除命令。

| 场景 | 是否受保护 |
|---|---|
| `safe_delete` 工具 | 是 |
| `/safe-delete` 斜杠命令 | 是 |
| 宿主的 `bash` 工具里 `rm` / `del` / `find -delete` 等 | 是（静态识别） |
| 其他插件内部的 `fs.rm` / `fs.unlink` | **否** |
| 你在资源管理器里直接删除 | **否** |
| 编辑器 / IDE 的删除 | **否** |
| `git clean -fdx` | **否** |
| 经混淆的脚本（`powershell -EncodedCommand`） | 拦下并要求人工确认，但**无法解析内容** |

后几类不走本插件的工具管线，因此看不到也拦不住。这是架构边界，不是疏漏 ——
要覆盖它们需要在文件系统层面做拦截（类似文件系统过滤驱动），超出插件能力。

**实际含义**：不要把本插件当成"整个系统的删除保险"。它的承诺是
"**DSH 让我删的东西，都可以反悔**"。

## 配置

界面：侧边栏 **插件** → `dsh-safe-delete` → **配置**。除下面三项数字外，还有一组**删除去向**按钮（点一下立即生效，不用按保存）。

| 界面项 | 取值范围 |
|---|---|
| 删除去向 | 两个按钮：`放入安全区` / `直接进回收站` |
| 安全区保留天数 | 整数，1–365 天 |
| 单次删除条目数确认 | `0` 关闭，或正整数 |
| 单次删除大小确认 | `0` 关闭，或至少 1 MB |

### 删除去向：两种模式的利害

| | 放入安全区（默认） | 直接进回收站 |
|---|---|---|
| 目录全树统计 | 做 | **不做** |
| 审批卡片显示 | 共 N 个文件 / X MB | 顶层 N 个条目 |
| 条目数 / 大小确认 | **生效** | **不生效** |
| 大量删除速度 | 与文件数成正比 | 与文件数无关 |
| 恢复方式 | 插件内 `safe_zone_restore` 按条目恢复 | 系统回收站，**保留原路径** |

**为什么回收站模式更快**：删除前要遍历整棵树统计大小与条目数，那是唯一与文件数成正比的成本，而且发生在审批卡片出现之前。回收站模式跳过它，代价是上面表格里那两项确认不再触发。

**回收站模式的已知边界**：

- **配额判定分三态：超限 / 未超 / 无法确认**。Windows 回收站有每卷容量上限（默认约为卷容量的 5%，实测本机约 50 GB）。条目**超过上限时会被系统永久删除**，插件无法阻止。

  | 判定 | 依据 | 处置 |
  |---|---|---|
  | 超限 | 大小（或下界）已超过上限 | 删除前弹窗 |
  | 未超 | **完整**大小确认低于上限 | 静默进回收站 |
  | **无法确认** | 读不到注册表 / 目录只量了顶层 | **按风险处理：弹窗；`never` 下拒绝** |

  - 目录只量顶层是刻意的（递归统计正是这个模式要省掉的开销），所以目录的大小只是一个**下界**。下界已超 → 确定超限；下界没超 → **无法确认**，仍然弹窗。此前这种情况被判成「无风险」，嵌套深处 20 GB 的目录会静默进回收站。
  - 同理，读不到注册表上限、或系统策略读不出来时，报告的是「无法确认」而不是「安全」。
  - 也就是说：**这道预检能挡住可判定的情况，判不了就问人**。真要保证可恢复，请用安全区模式。
- 会让删除**绕过回收站**的开关有**两个**，都查（2026-11-05 第四轮自检补上了第二个）：

  | 开关 | 范围 | 位置 |
  |---|---|---|
  | `NoRecycleFiles` | 全局 | `Policies\Explorer` |
  | `NukeOnDelete` | **每卷** | `BitBucket\Volume\{GUID}` |

  只看全局那一条会漏掉「全局正常、只有某个卷被设成清空」的配置 —— 而那正是想彻底删干净的人会设的。任一卷 `NukeOnDelete=1` 就判为「删除即永久」，走同一套审批。判定三态：全部卷读到且为 0 → 确认安全；列不出卷 / 某卷读不到 → **无法确认**，同样弹窗。

- 检测到上述任一策略（删除即永久）时，会**在审批卡片里弹出说明**（钩子层）；你不同意就**放弃这次删除**，一个文件都不动。审批策略为 `never` 时明确拒绝，而不是静默执行。
- **「移进回收站」是原路径消失的观测结果**，不是「已确认可从回收站还原」——插件不读回收站的 `$I/$R` 条目。系统策略、配额、文件系统都会影响可恢复性（见上文第 2 层的边界）。

配置文件：

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

模式删除（`root` + `match` / `olderThan`）在回收站模式下**无法**提前确认每个匹配项的大小及可恢复性（钩子不枚举目标），因此：

- `never` 策略下**一律拒绝** —— 工具执行体里那次 `detectQuotaRisk` 的「审批」在生产接线里是恒允许的桩（前提是管线已经问过），而 `never` 下管线根本不出卡。拒绝对话里会给出三条出路：临时改 `ask`、改用显式 `paths`（大小可以 stat 出来，风险可预判）、或切回 `safe-zone`。
- `ask` 策略下弹卡片，卡片说明实际回收站去向与可能永久删除的风险。

安全区模式维持原有规则。

> 同一条「不可恢复的删除必须有真实授权」的原则也适用于解析失败：命令**无法被安全解析**时（超长、嵌套过深导致解析器抛错），`ask` 下返回审批、`never` 下明确拒绝 —— 解析失败不等于放行。

### 「证明只读」的边界（2026-11-05 收紧）

拦截器只放行**能正向证明只读**的命令。以下曾经在放行清单里，现在**要审批**，因为它们的实际操作由项目自定义：

| 命令 | 为什么不再算只读 |
|---|---|
| `pnpm build` / `npm build` / `yarn build` | 执行 `package.json` 的 `scripts.build`；脚本可以是 `node scripts/cleanup-build.js` |
| `pnpm start` / `test` / `typecheck` / `lint` | 同上，都是项目自定义脚本的入口 |
| `pnpm version`（不带横线） | 改 `package.json` 并打 tag |
| `git pull` | 上游删除已跟踪文件时，工作区里那份会**一并消失** |

仍然放行的只读查询：`git status` / `log` / `diff` / `show` / `ls-files`、`npm list`、`pnpm ls` / `why` / `outdated`、`pnpm --version` 等。

代价是每次跑构建多一次确认 —— 这是明示的取舍：**「照惯例猜它不删东西」不能写进「已证明只读」的清单**，而审批疲劳的解法是让放行清单只装真正可证明的项，不是让它装更多。

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
| `privacy-audit.mjs` | 隐私与凭据扫描（**工作区 + 暂存区**） |
| `privacy-history-audit.mjs` | 隐私扫描的**历史**部分：`git log --all` 的 diff 与提交信息 |
| `privacy-history-baseline.json` | 历史扫描的**已接受命中**基线（精确到 SHA + 文件 + 规则；凭据不可入） |
| `check-docs.mjs` | 文档与实现一致性 |
| `mutation-check-core.mjs` | 变异检验 |
| `where-is-safe-zone.mjs` | 安全区位置与所在卷 |
| `render-icon.mjs` | 渲染图标预览 |

`pnpm gate` 会把逐项结果连同 `git rev-parse HEAD`、时间、平台与「工作区是否有未提交改动」写进 `gate-report.json`（不提交，见 `.gitignore`）。这句话的意思是：**报告说的是哪个 SHA，由脚本自己记录**，不靠提交说明里的自述。

### 两套隐私扫描的分工

| 脚本 | 回答的问题 | 覆盖 | 不覆盖 |
|---|---|---|---|
| `privacy-audit.mjs` | 这次提交会不会**带进**新的泄露 | 工作区 + 暂存区文本 | 历史、二进制 |
| `privacy-history-audit.mjs` | **过去**有没有提交过敏感内容 | `git log --all` 的 diff 新增行、提交信息 | reflog / 不可达对象、tag 附注、Release 附件、CI 日志、二进制内容 |

两者都不替代 `gitleaks` / `trufflehog`：正式发布前应另跑专用工具。历史命中无法靠"再提交一次"消除 —— 先判断它是否仍是**有效凭据**（有效则轮换），再决定是否有必要改写历史。

历史扫描有两处**刻意收窄**的豁免，都写在 `privacy-history-audit.mjs` 里：

| 豁免 | 范围 | 为什么收窄 |
|---|---|---|
| 规则载体文件 | `scripts/privacy-audit.mjs` / `privacy-history-audit.mjs` / `verify-remote.mjs` 里的**上下文规则**（本机路径、对话痕迹、会话标识） | 那些行就是规则定义本身，不是数据 |
| 测试夹具路径 | `tests/` 与 `*.test.ts` 里的**上下文规则** | 那些命中是刻意构造的假数据 |

**凭据 / Token 规则在这两类文件里照扫**（第三轮复审 R03）：不存在"这是测试夹具"这种解释 —— 要么是假 token，要么是真泄露，必须有人看一眼。

已确认无害的历史命中写进 `scripts/privacy-history-baseline.json`，精确到 `SHA + 文件 + 规则`，只影响那一条。**凭据类命中永远不能进基线**：基线里出现凭据条目时脚本直接退出 2，而不是放行。

> **规则标签不含触发词**（2026-11-05 自检）：`对话痕迹` 这条规则原来的标签写了它的一个检测词，于是**任何要写出规则名的文件**（基线、报告、文档）都会被它自己判成泄露。修法是把触发词从标识里拿掉 —— 给每个这样的文件加豁免只是把症状按文件数重复一遍。

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
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) —— 与其他插件的共存检查
- [`docs/CLEANUP-ARCHITECTURE.md`](docs/CLEANUP-ARCHITECTURE.md) —— 清理架构（后台子进程 + 批量回收）
- [`docs/INCIDENT-2026-10-30.md`](docs/INCIDENT-2026-10-30.md) —— 2026-10-30 卡顿事故记录
