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

**审批策略**：审批卡片只在会话策略为 `ask` 时出现。在 `never` 下（例如
`danger-full-access` 权限预设），宿主会在派发前驳回 `ask`，卡片根本不会显示。

此时本插件**降级为放行**：文件照常移入安全区、照常可以取回，但**危险路径
（家目录、profile 清单、`node_modules`、安装目录）失去那一次当面确认**，
只剩「可恢复」这一层保护。

这是有意的取舍：`never` 通常意味着用户就是要连续干活，此时把删除全部禁掉
只会让人关掉整个插件。代价必须说清楚 —— **如果你需要在删除危险路径时被当面
问一次，请把权限预设换成使用 `ask` 的那种。**

拦车闸（裸 shell 删除）与写入保护不受审批策略影响，始终生效 —— **但有一处例外
必须说明**：`never` 策略下，如果一条删除命令的**目标无法静态解析**（用了变量、
管道、通配符），拦车闸会**放行执行**而不是拒绝。因为在 `never` 下返回 `ask`
只会被静默驳回，用户看到的是「工具被拒绝」却无从确认，任务卡住且看不出原因。
目标可静态解析的删除命令仍照常拦截。

这意味着 `never` 策略下有一类删除**既不弹卡、也不进安全区**。如果你需要每一
次删除都可恢复，请使用 `ask` 策略的权限预设。

### 宿主版本兼容性

```json
"engines": { "dsh": ">=0.2.0-rc.2" },
"peerDependencies": {
  "@deepseek-ai/dsh-api-remotes": ">=0.2.0-rc.2",
  "@deepseek-ai/dsh-client-locale": ">=0.2.0-rc.2",
  "@deepseek-ai/dsh-client-ui-settings": ">=0.2.0-rc.2",
  "@deepseek-ai/schemastery": "^3.18.2"
}
```

| 项 | 值 |
|---|---|
| 准入门槛 | `dsh: >=0.2.0-rc.2`（无上界） |
| 实测通过 | `0.2.1-rc.2`、`0.2.1-rc.3` |
| Node 要求 | `>=22.19.0` |

**所有 `@deepseek-ai/dsh*` 包写同一个 range**，不累加、不枚举。第三方库
（`schemastery`、`react`）保持各自独立约束，不跟 DSH 版本走。

> **已知副作用**：声明这三个 dsh peer 后，pnpm 会把它们连同传递依赖
> （`dsh-brand`、`dsh-session`、`dsh-llm` 等，共 13 个）解析进 `pnpm-lock.yaml`，
> 并在 `node_modules/.pnpm` 下落盘。这**只影响本地开发依赖**，不影响插件发布产物
> （`files` 只含 `lib/`、`bin/` 等），也不影响运行时 —— 宿主忽略 dsh peer。
>
> 如果不想让本地装这些包，可以给它们加 `peerDependenciesMeta` 的 `optional: true`；
> 本仓库选择保持声明完整，不加 optional。

三条容易踩的事实（都已在宿主源码核实）：

1. **宿主判定带 `includePrerelease: true`**：
   `semver.satisfies(v, range, { includePrerelease: true })`。
   不带这个选项时，`>=0.2.0-rc.2` **匹配不到** `0.2.1-rc.3`，结论完全相反。
   自己核对时务必带上。
2. **`engines.dsh` 存在时 `peerDependencies` 被完全忽略**。源码原话：
   *"An own `engines.dsh` range decides alone and peerDependencies are ignored"*。
   所以 peer 的范围只影响 pnpm 警告，不影响加载 —— 但也别写 `*`，那会让
   "声明支持哪些版本"失去表达力。
3. **累加式是冗余的**。`includePrerelease` 下
   `>=0.1.7-rc.2 || >=0.2.0-rc.1 || >=0.2.1-rc.2` 等价于 `>=0.1.7-rc.2`，
   后面的段全被覆盖，却伪装成精确范围。

### 升级 DSH 后按这个顺序查

不要一上来改版本号，先确认到底要不要改：

| 顺序 | 查什么 | 不改的条件 |
|---|---|---|
| 1 | `engines.dsh` 是否需要动 | 新版本仍 `>=0.2.0-rc.2` → 不用改 |
| 2 | 运行时依赖是否都在 | 读新 `app.asar` 确认插件 import 的包存在 |
| 3 | 关键 API 是否变 | `LlmAdapter` / `registerAdapter` / `TypertRemoteService` / `registerSearchProvider` |
| 4 | 数据形状是否变 | 例如 `web_search` 返回的 `truncated` 是否仍必填 |
| 5 | `pnpm test` 全绿 | 绿了才算兼容 |

本插件的自动化检查：

```bash
node scripts/verify-dsh-range.mjs        # 范围判定 + peer 写法 + semver 交叉核对
pnpm vitest run                          # 421 项测试
npx tsx scripts/verify-interception.ts   # 拦截链集成
```

`verify-dsh-range.mjs` 会检查：所有 `@deepseek-ai/dsh*` peer 是否与 `engines.dsh`
同范围、是否混入了宿主不读的字段（如 `dsh.engines`）、以及自研版本比较与真实
`semver` 的判定是否一致（找不到 semver 库时会**明确标 SKIP**，不假装验证过）。

## 用

模型侧工具：

| 工具 | 作用 |
|---|---|
| `safe_delete` | 唯一的删除通道。`preview:true` 先看，再去掉执行 |
| `safe_zone_list` | 安全区里有什么 |
| `safe_zone_restore` | 按 id 取回（原路径被占用时落到 `.restored-<时间戳>`） |
| `safe_zone_status` | 条目数、占用、保留期、确认阈值，以及清理去向 |
| `safe_zone_journal` | 审计流水：被拦的删除、被拦的写入、删除、取回、清理，最新在前 |
| `safe_zone_check` | 只读体检：profile 清单能否解析、行 id 是否跨层重复 |

### 一次删多个

删多个文件时用 `paths` 数组传，**不要**一个文件调用一次：

```
safe_delete({ paths: ["a.log", "b.log", "c.log"], preview: true })
safe_delete({ paths: ["a.log", "b.log", "c.log"] })
```

差别是实打实的：删 10 个文件时，逐个调用 = 10 次工具调用 + 10 次确认；
一次 `paths` = 1 次调用 + **1 次确认**（确认文案里写清共几项、合计多大、
为什么需要你确认）。

批量的意义是省往返次数与确认次数，**不是绕过检查**：每一条仍独立走完整流程
（保护区判定、安全区自检、独立审计记录），单条失败不影响其他条，结果里会
分别列出成功与失败。

`path`（单个）与 `paths`（多个）**二选一**，同时传会被拒绝 —— 混用时行为
取决于顺序，是模糊语义，不如直接报错。

## 在 DSH 里用命令

不用经过模型，直接敲命令：

```
/safe-delete <路径>              把文件或目录移入安全区（保留期内可取回）
/safe-delete <路径> --preview    只看会发生什么，不真的移动
/safe-delete list                列出安全区里的条目
/safe-delete restore <id>        把某个条目取回原位
/safe-delete clean               把过期/超容量的条目移入系统回收站
/safe-delete clean --dry-run     只报告会移走什么，不动手
/safe-delete config              查看所有配置项：当前值、作用、影响、范围
/safe-delete config <项> <值>     修改一项（例如 config confirmBytes 512MB）
/safe-delete status              安全区概况
```

命令与插件页的设置表单**写的是同一份配置**，所以在任一处理完成、重启 DSH 后，
另一处看到的都是新值。

## 命令行工具（**不依赖 DSH 运行**）

```bash
dsh-safe-delete delete <路径> [--preview]
dsh-safe-delete list
dsh-safe-delete undo <id>
dsh-safe-delete prune --dry-run
dsh-safe-delete status
dsh-safe-delete check
dsh-safe-delete journal
```

> 终端里没有审批通道，所以 `delete` 遇到需要人工确认的路径会**拒绝**并提示改用
> DSH 里的 `/safe-delete`。这不是缺陷 —— 它保证「需要你点头的删除」永远先问到你。

## 文件去哪了：三层结构

删除不是一步到位的，中间隔了两道可反悔的关卡：

| 层 | 什么时候发生 | 怎么取回 |
|---|---|---|
| **1. 安全区** | 删除的那一刻 | 保留期（默认 **1 天**）内用 `safe_zone_restore id=<id>` |
| **2. 系统回收站** | 保留期结束 | 清空回收站之前，在资源管理器里「还原」都能拿回来 |
| **3. 永久消失** | **你手动清空回收站** | 拿不回来了 |

**第 2 层不是自动的。** 安全区到期后，条目会被**移入系统回收站**，而不是直接抹掉
—— 因为安全区的清理是无人值守的，不该替你做「最终删除」这个决定。真正不可逆的
那一步，永远由你手动触发。

移入回收站失败的条目会**留在安全区**并在 `safe_zone_status` 里报告，**绝不会**
因为回收站不可用就静默永久删除。

### 只按时间清理，没有容量上限

安全区**不管理容量**：一个字节上限、百分比阈值、清理间隔都没有。理由：

- 安全区只是「刚删就后悔」的短暂缓冲，不是第二个回收站；
- 有容量层时，删进去的东西可能因为"超上限"被**立刻**推走，而提示仍写着可恢复
  N 天 —— 承诺与实际不符；
- 三层参数互相影响，用户无法预判一次删除的后果。

代价是**安全区会变大**。想立刻腾空间就用表单底部的「立即清理安全区」按钮（或
`/safe-delete clean`）：**它不看保留期，把现有条目全部移入回收站**。这是你手动
释放空间的出口。

### 「1 天」是"最早"，不是"恰好"

没有后台定时器（那会让插件在 DSH 空闲时也保有生命周期）。清理在**每次调用
`safe_zone_*` 工具时顺路发生**：

| 情况 | 结果 |
|---|---|
| 保留期到了，你继续用 DSH | 下次工具调用就清走 |
| 保留期到了，但几天没开 DSH | 文件一直留着，直到你下次用 |
| 想立刻清 | 用「立即清理安全区」按钮 |

`safe_zone_status` 会把这一点写在输出里，不让"1 天"被误解成准点。

## 分级

| 分级 | 范围 | 行为 |
|---|---|---|
| `free` | 工作区、系统临时目录、其他盘 | 直接进安全区，不打扰 |
| `confirm` | 家目录、`$DSH_HOME` 下非清单内容、profile 目录 | 弹审批卡 |
| `protected` | profile 清单/补丁/lockfile、`node_modules`、安装目录、安全区自身 | 弹审批卡 |

## 配置

### 在界面里改（推荐）

装好插件后，打开侧边栏的 **插件** → `dsh-safe-delete` → **配置**，只有两项：

- 单次删除条目数确认
- 单次删除大小确认

容量相关的三个参数（上限 / 提前清理阈值 / 检查间隔）**已从产品和表单中移除** ——
安全区只按保留期（固定 1 天）清理，语义才可预测。

保存后**需要重启 DSH 生效**：配置值本身立即更新，但插件的拦截逻辑在启动时装配，
界面会明确提示这一点，不假装即时。

表单下方还有一个 **立即清理安全区** 按钮：它把安全区现有条目全部移入系统回收站，
**不受** 保留期限制。因为不可撤销范围较大，按一下只会进入确认态，需要再点
「确定清理」才执行。按下后插件会重载一次（几十毫秒），期间工具短暂不可用。

> 界面能改的只有上面两项。换安全区目录、关掉拦截、改保留期这类改动风险更高，
> 仍然走配置文件。

### 配置文件

| 键 | 默认 | 含义 |
|---|---|---|
| `stateDir` | `<DSH_HOME>/.dsh-safe-delete` | 安全区目录。改了等于「现有安全区不再可见」 |
| `retentionDays` | `1` | 保留天数。到期后条目移入**系统回收站**（不是永久删除） |
| `autoPrune` | `true` | 关掉后安全区只增不减，只能手动清理 |
| `confirmFileCount` | `5000` | 单次删除超过这么多条目就额外确认一次；`0` 关闭 |
| `confirmBytes` | `2147483648`（2 GB） | 单次删除超过这么大就额外确认一次；`0` 关闭 |
| `blockShellDeletes` | `true` | 拦车闸开关 |
| `blockProtectedWrites` | `true` | 拦截对启动关键路径的写入 |
| `crossVolumeCopy` | `false` | 安全区与目标不同卷时是否允许复制式移入 |
| `cleanRequestedAt` | `0` | **「立即清理」按钮的触发戳**，不是给用户改的。客户端写入当前时间戳 → 配置变更触发 HMR 重载插件 → `apply` 重跑时发现新时间戳就把安全区条目移入回收站。配合 `last-clean-request.json` 记录已消费的时间戳，避免"改个配置也顺带清理" |

> **已移除**：`maxBytes`、`pruneAtPercent`、`autoPruneIntervalMs`。安全区不再管理
> 容量，只按保留期清理。仍在旧配置里写这三项不会报错，但不再有任何效果。

标了界面可编辑的那几项在 `src/config.ts` 里声明为 `.volatile()` —— 宿主只认这样的字段。
`schemastery` 因此是 peer 依赖（由宿主提供，构建时保持 external）。

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
- **不隐藏任何东西**：拦了什么、为什么拦、配置是什么，都能从 `/safe-delete config`
  或 `/safe-delete journal` 直接看到。

## 开发

```bash
pnpm install
pnpm typecheck     # 类型检查
pnpm vitest run    # 全部测试
pnpm build         # 产物到 lib/（必须一起提交）
node scripts/clean-test-tmp.mjs   # 清掉测试遗留的临时目录
```

`lib/` 是发布产物且**必须进版本库**：`main` 与 `cordis.patch.yml` 都指向它。
改完 `src/` 记得重新 `pnpm build` 并提交 `lib/`。

### 验证脚本

这些脚本不在测试套件里，是发布前的独立检查：

| 脚本 | 作用 |
|---|---|
| `verify-interception.ts` | 用真实命令跑完整拦截链，确认没有静默失效 |
| `verify-settings-contract.mjs` | 按宿主真实契约验证设置页的读写形状 |
| `verify-client.mjs` | 模拟宿主 loader 跑一遍客户端 `apply()` |
| `verify-activation.mjs` | **按宿主规则判定 `inject` 是否可满足** —— 缺一个服务，`apply` 就永不执行，界面上什么都不出现 |
| `verify-client-contract.mjs` | **静默失败模式审计**：`exports["./client"]`、顶层 inject 是否最小化、`remote` 是否与 `remote.settings` 成对请求、渲染路径是否碰 `ctx` |
| `verify-client-render.mjs` | 渲染表单，确认字段与默认值都在 |
| `adversarial-probe.ts` | 找「该拦却没拦」；同时列出已知边界 |
| `false-positive-probe.ts` | 找「不该拦却拦了」 |
| `privacy-audit.mjs` | 发布前扫个人信息与凭据 |
| `check-docs.mjs` | 文档与实现是否一致 |
| `where-is-safe-zone.mjs` | 打印安全区默认位置与所在卷 |
| `render-icon.mjs` | 渲染 `icon.svg` 的预览图 |

## 已知限制

- **静态分析看不到动态构造的命令**：`$c = "Re" + "move-Item"; & $c -Recurse X`
  这类写法无法在解析阶段识别。要防它需要运行时拦截，不是文本分析能解决的。
- **需要审批的删除在终端里做不到**：CLI 没有审批通道，`delete` 遇到这类路径会
  拒绝并提示改用 DSH 内的 `/safe-delete`。
- **配置改动需重启生效**：值本身立即写入，但拦截线是在启动时装配的。
- **`schemastery` 由宿主提供**：它是 peer 依赖，`link:` 裸装时能否解析取决于
  宿主环境；用 `dsh plugin add` 安装则由宿主的依赖解析兜住。

验收清单见 [`docs/VERIFY.md`](docs/VERIFY.md)。

配置页出问题时，看 [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md) —— 它逐条解释了启动链的
每一步在做什么、失败意味着什么，以及不同失败组合该怎么排查。

怀疑某个插件让 DSH 起不来时，看 [`docs/STARTUP-SAFETY.md`](docs/STARTUP-SAFETY.md) ——
它说明了插件失败的三层半径（顶层 import / `apply` / 钩子），本插件在每一层的实测
表现，以及"哪一行代码会让整个应用起不来"的通用自查方法。
