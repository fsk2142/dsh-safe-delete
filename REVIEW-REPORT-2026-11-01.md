# 2026-11-01 审查整改报告

对应审查包：`outputs/2026-11-01_DSH安全删除插件审查/`
产出：`dsh-safe-delete` v1.8.4 → **v1.11.0**，提交 `90e1856`

---

## 基线

| 项 | 整改前 | 整改后 |
|---|---|---|
| 测试 | 691 项 / 81 文件 | **818 项 / 98 文件** |
| 新增测试 | — | 127 项 |
| 版本 | v1.8.4 | v1.11.0 |

整改前的基线是**全部通过**的（691 绿）。也就是说这 23 项缺陷没有任何一项
被既有测试覆盖 —— 这正是本节最值得记的一点。

---

## 完成问题编号

**23 / 23 全部修复。**

P1：SD-01、SD-02、SD-03、SD-04、SD-05、SD-06、SD-07、SD-08、SD-09、
SD-10、SD-11、SD-12、SD-13

P2/P3：SD-14、SD-15、SD-16、SD-17、SD-18、SD-19、SD-20、SD-21、SD-22、SD-23

文档：R-01、R-02

### 额外发现并修复的 5 个缺陷

这些不在审查清单里，是在实现/验证过程中撞出来的：

| 编号 | 位置 | 问题 |
|---|---|---|
| **X-1** | `tools.ts` `safe_zone_check` | `ok` 字段**恒为 true** —— 输出写着 `[FAIL]` 时结构化字段仍报成功 |
| **X-2** | `classify.ts` `isUnder` | **盘根被判为 `free`** —— `C:\` 之后拼分隔符得到 `C:\\`，于是什么都不匹配。删整个卷不被认为包含安装目录/家目录 |
| **X-3** | `store.ts` `stripComments`（第一版修复） | `rm -rf ./*` 的 `/*` 被当块注释起始，目标变成 `.` |
| **X-4** | `store.ts` `stripComments`（第一版修复） | `C:\Program Files\nodejs\node.exe -e` 因路径含空格，包装器检测失效 |
| **X-5** | `bin/dsh-safe-delete.mjs` | `extractPluginBlock` 只认 `- id:` 形态，映射键写法读不到 `stateDir` |

X-3 / X-4 是我自己引入的回归，**由既有 691 条测试抓到**。

---

## 每项：根因与最小修改

### SD-01 读目录失败被当成空

- **根因**：`listDirSafe` 把异常与"空目录"合并成同一返回值；批量删除只看
  `isEmpty` 就 `rmSync`，于是**读失败 ⇒ 当作没有内容 ⇒ 删掉唯一副本**。
- **修改**：新增 `readDirState` 返回三态
  （`{kind:'empty'}` / `{kind:'nonempty',names}` / `{kind:'error',reason}`）。
  批量删除要求 `stagedState.kind === 'empty'` **且** 每个条目都是
  `moved-back` / `left-in-place`。另加 manifest 严格校验
  （schemaVersion、status 枚举、batchId 与目录名一致、条目 id 合法、字节数有限）。
- 文件：`src/batch-manifest.ts`；测试 `tests/manifest-read-error.test.ts`（7 项）

### SD-02 短写

- **根因**：`writeSync` 只调一次，不检查实际写了多少。磁盘满时静默截断。
- **修改**：循环写直到写完；`n <= 0` 抛错并写明已写/总字节。
- 文件：`src/store.ts`；测试 `tests/copy-fallback-safety.test.ts`

### SD-03 目录恢复覆盖竞争者

- **根因**：`mkdir` 占位 → `rmdir` → `rename` 之间有窗口；跨卷回退用
  `cpSync`，它**会覆盖**同名文件。Windows 上 rename 到非空目录会失败（数据
  幸存），POSIX 上会覆盖 —— 不能依赖平台行为。
- **修改**：占位目录保留，内容逐项以 no-overwrite 原语搬入
  （目录 `mkdirSync`、文件 `linkSync`，不支持硬链接时 `open(wx)`），
  冲突就换候选，全部成功后才删源。
- 文件：`src/store.ts` `mergeDirectoryNoOverwrite`；
  测试 `tests/directory-restore-sd03.test.ts`（6 项）

### SD-04 失败后按路径清零

- **根因**：写失败后 `writeFileSync(candidate, '')` + `ftruncateSync(fd, 0)`
  想"清理残骸"。
- **修改**：什么都不做，只 `closeSync` 再抛。
- **关键实测**：`ftruncateSync(fd,0)` **并不安全** —— 竞争者用 `writeFileSync`
  打开的是**同一个 inode**，截断会销毁他们的数据。只有 `unlink` + 重建的
  竞争者是安全的。这是我第一版修错、被隔离实验推翻的地方。

### SD-05 模式删除漏审批 + 合计阈值不判定

两个独立缺陷：

- **合计阈值**：`decideGate` 只比较**单项**。三项各 1 字节、阈值 2 时全部
  放行，而合计已超。→ 加批级 `allBytes` / `allFiles` 判定；审批文本列出
  **整批**（合计触发时单项列表是空的，否则用户批准的是看不见的集合）。
- **free root 跳过审批**：钩子对 `free` 的 root 直接 `next()`，理由是"工具内部
  会判定"。但生产的 `requestApproval` **恒返回 `allowed-once`**（它假定管线
  已问过），于是钩子一放行就**没人问**。实测 `root=工作区` 命中
  `node_modules/`，工具内部识别为 protected，那次"审批"是无声通过的。
  → `free` root 也 ask；`never` 策略保留放行。
- 文件：`src/tools.ts`、`src/index.ts`；测试 `tests/approval-aggregate-sd05.test.ts`（6 项）

### SD-06 大小写绕过自保护

- **根因**：三处用区分大小写的 `startsWith`（`store.ts` 两处、`delete-core.ts`
  一处）。Windows 上 `C:\X\STATE` 与 `C:\X\state` 是同一目录。
- **修改**：`classify.ts` 早就有正确的 `normalize()`，导出后三处复用。
- **注意**：`classify.ts` 本来就是对的，另外两处不是 —— **修一处不等于修一类**。
- 文件：`src/classify.ts`、`src/store.ts`、`src/delete-core.ts`；
  测试 `tests/path-case-sd06.test.ts`（6 项）

### SD-07 陈旧锁抢走新锁

- **根因**：`renameSync(lockPath, tombstone)` 不校验 inode，搬的是"当前那个
  路径上的东西"。A 建新锁后 B 的 rename 会把它搬走。
- **修改**：改名后读 tombstone 里的 token 比对；不符就放弃，且**不放回**
  （放回是又一次 rename，会再开窗口）。
- **残留说明**：`renameSync` 仍不校验 inode，极端竞争仍可能捕获活锁。彻底
  关闭需要 OS 级锁句柄（`fcntl` / `LockFileEx`），本插件零运行时依赖，
  做不到。**改变的是现在能检测并拒绝继续**。
- 文件：`src/cleanup.ts`；测试 `tests/cleanup-lock-sd07.test.ts`（6 项）

### SD-08 worker 绑定前退出锁不释放

- **根因**：只监听 `error`。spawn 成功只表示 Node 进程启动，入口缺失时正常
  退出、不触发 `error`。锁里存的是**父进程 pid**（worker 还没 bind），
  父进程活着 ⇒ 陈旧接管永不成立 ⇒ 清理永久停摆。
- **修改**：监听 `exit`；非零退出写 failed + 释放锁；`code 0` 直接返回
  （worker 自己已经写好状态）；用 `requestId + running` 双重守卫避免踩新请求。
- 文件：`src/cleanup.ts`；测试 `tests/worker-exit-sd08.test.ts`（4 项）

### SD-09 MB 显示成 GB

- **根因**：数字框用 `toBytesInput(current).amount`（自然单位，500MB→"500"），
  单位下拉却是 `values[key.unit] === 'MB' ? 'MB' : 'GB'`（缺省 GB）。界面出现
  `[ 500 ] [GB ▾]`，改成 501 保存得 501 GB —— **放大 1024 倍**。
- **修改**：下拉缺省用 `naturalBytesUnit(current)`（与显示侧同一判定），
  `coerce` 同步。
- **测试教训**：我第一版写的是纯函数复刻，变异检验显示**改回缺陷代码仍全绿**
  —— 它验证的是我抄的那份逻辑。改成 jsdom + react-dom 真实渲染后，修复前
  报出 `expected 'GB' to be 'MB'`。
- 文件：`src/client/index.tsx`；测试 `tests/bytes-unit-sd09.test.ts`（3 项）

### SD-10 只读前缀豁免删除

- **根因**：切段后只检查段首是否为删除动词。`find -delete` 与 `.Delete()` 的
  动词在**参数/方法调用**里。实测：
  `echo ready; find /tmp/x -delete` → false，而单独
  `find /tmp/x -delete` → true。
- **修改**：新增参数级删除标记表（`-delete`、`--delete*`、`--remove-source-files`）
  与方法调用形态（`.delete(` / `.unlink(` / `.rmdir(` …）。
- 文件：`src/command.ts`；测试 `tests/command-prefix-sd10.test.ts`（15 项）

### SD-11 / SD-17 注释剥离不看引号

同一根因，两个方向的错：

- **漏判（SD-11）**：`node -e "console.log(' # marker'); ...unlinkSync(...)"`
  —— 字符串里的 `#` 让后面整段被裁掉。
- **误判（SD-17）**：`# file.Delete()` / `const note = "file.Delete()"` 被当真删除。

- **修改**：`stripComments` 改为字符扫描，维护引号与转义；`DELETE_PATTERNS`
  在去注释后的文本上匹配；引号内内容通过"命令头是否为执行包装器"
  （`node` / `sh` / `powershell` / `python` …）决定算不算真删除。
- **副作用**：块注释要求存在配对的 `*/` —— 否则 `rm -rf ./*` 的通配会被吃掉
  （X-3）。包装器检查看前 4 个 token —— 否则带空格的 `C:\Program Files\...`
  检测不到（X-4）。
- 文件：`src/command.ts`；测试 `tests/command-lexing-sd11.test.ts`（15 项）

### SD-12 `--preview` 改写路径

- **根因**：`rest.replace(/--preview/g, '')` 是全局字符串替换
  → `foo--previewbar` 变成 `foobar`，**删掉用户没指定的对象**。
- **修改**：引号感知分词后只丢弃恰好等于 `--preview` 的 token。
- 文件：`src/commands.ts`；测试 `tests/slash-preview-sd12.test.ts`（7 项）

### SD-13 CLI 忽略自定义 stateDir

- **根因**：CLI 写死 `<DSH_HOME>/.dsh-safe-delete`，配置里的 `stateDir` 从不读取。
  DSH 起不来时 CLI 是唯一救援通道，指向错目录等于救援失效。
- **修改**：三级优先级 —— `--state-dir` > 配置 `stateDir` > 默认。
  另修 `extractPluginBlock` 支持映射键写法（X-5）。
- 文件：`bin/dsh-safe-delete.mjs`；测试 `tests/cli-statedir-sd13.test.ts`（6 项）

### SD-14 发布流程三断点

1. `run()` 对 `stdio:'inherit'` 的 `null` 结果调 `.trim()` → TypeError。
   build 之后崩溃，而版本号已改（半途）。
2. `execFileSync('pnpm')` Windows 上 ENOENT（`.cmd` 包装，不解析 PATHEXT）。
3. `git log 1.8.4..v1.10.1` 起始 ref 无效（tag 是 `v1.8.4`），且这行在 push
   **之后** —— 崩在这里时远端有 tag、Release 没有。

- **修改**：`run()` 判类型；`runPnpm` 走 `shell: true`；范围起点用
  rev-parse 核实过的 `prevTag`，无 tag 时退回第一个提交；并在测试里钉住
  "所有本地检查在 push 之前"。
- 文件：`scripts/release.mjs`；测试 `tests/release-flow-sd14.test.ts`（7 项）

### SD-15 保存期间编辑丢失

- **根因**：保存成功后 `setValues(回读值)` 整体替换。保存走异步往返，
  用户在这期间的输入被静默覆盖。
- **修改**：合并回填 —— 有 `.draft` 的字段保留草稿，单位随草稿一起保留。
- 文件：`src/client/index.tsx`；测试 `tests/edit-during-save-sd15.test.ts`（4 项，
  含挂起 mutate 的真实渲染）

### SD-16 斜杠 clean 丢弃后台状态

- **根因**：adapter 返回了 `note` 说明，但 `CommandDeps.clean` 类型里没有字段
  承载 → 被丢弃 → 渲染层只看空的 `removed`，三种完全不同的状态都回
  "没有需要清理的条目"。
- **修改**：加 `scheduled: {started, reason?}` 并分支；旧形态仍兼容。
- 文件：`src/commands.ts`、`src/index.ts`；测试 `tests/slash-clean-sd16.test.ts`（6 项）

### SD-18 同补丁重复 id 通过体检

- **根因**：`ids.set(id, ...)` 让同文件重复被覆盖；重复检查只比**不同 Map**
  （跨 profile）。
- **修改**：读取时即检查重复，报出两处位置。
- 文件：`src/tools.ts`；测试 `tests/duplicate-rowid-sd18.test.ts`（5 项）

### SD-19 verify-client-render 跳过关键检查

- **根因**：`moduleShim.exports` 是空对象，真正导出在 UMD factory 返回值里
  → `typeof Form === 'function'` 恒假 → 静默跳过；`expectedLabels` 还列着已
  删除的容量字段；字段检查退化成"源码里有没有这个字符串"。
- **修改**：留住 factory 导出；拿不到组件**明确失败**。
- **诚实边界**：我试过在这里做真字段渲染检查，实测不可行 —— 首帧是 loading
  壳，字段要等 `describe()` 异步回填，需要真实 `useEffect`，这个 fake React
  没有。所以脚本改为检查"组件可调用"，并在输出里**写明**字段渲染由
  `tests/client-interaction.test.ts` / `tests/bytes-unit-sd09.test.ts` 验证。
- 文件：`scripts/verify-client-render.mjs`

### SD-20 check-docs 不比较数值

- **根因**：只检查"文档列出没有"和"代码找到没有"，从不比较两者。文档写 99、
  代码是 1 时打印 `文档=99 代码=1` 仍算 `ok`。
- **修改**：两边都求值成数字再比（只允许数字与 `* + - / ( )`，不做通用 eval）；
  非数值退回文本比较。
- 文件：`scripts/check-docs.mjs`

### SD-21 ID 碰撞覆盖

- **根因**：`mkdirSync(entryRoot, {recursive:true})` 在目录已存在时不报错，
  随后 rename 到同名 basename → 覆盖。
- **修改**：非递归独占创建，EEXIST 抛 `ENTRY_ID_COLLISION`，
  `moveToSafeZone` 重新生成 id 重试（最多 5 次）。
- 文件：`src/store.ts`；测试 `tests/id-collision-sd21.test.ts`（4 项，冻结
  `Math.random` 强制碰撞）

### SD-22 UI 接受 <1MB

- **根因**：`min: 0`（0 = 关闭），于是 0.5MB 也能存；而契约是"0 或至少 1MB"。
- **修改**：`coerce` 加一条"非 0 且小于 1MB → 不合法"。不能把 `min` 设成 1MB
  —— 那会把 0 也拒掉。
- 文件：`src/client/index.tsx`；测试 `tests/bytes-minimum-sd22.test.ts`（4 项）

### SD-23 安装目录祖先被判 free

- **根因**：只判 `isUnder(target, installDir)`（在内部），反向没管。
  `installDir = <ws>/application/bin`，目标 `<ws>/application` 判 free ——
  移动它会把 `bin/` 连同 DSH 一起移走。
- **修改**：两个方向都判，`dshHome` 同理；只对**已知固定根**做反向判断，
  否则"删整个工作区"也会被判危险。
- **顺带**：写这条测试时撞出 X-2（盘根被判 free）。
- 文件：`src/classify.ts`；测试 `tests/ancestor-protection-sd23.test.ts`（9 项）

### R-01 / R-02 产品边界文档

- README 新增两节：系统回收站的实际边界（跨卷占空间、不支持的 FS、组策略、
  配额），以及保护范围到哪为止（其他插件内部 `fs.rm`、资源管理器、编辑器、
  `git clean -fdx` 均不覆盖）。
- 明确写：承诺是"**DSH 让我删的东西都可以反悔**"，不是"整个系统的删除保险"。

---

## 旧实现复现结果 → 新实现结果

每项都先复现再修。以下是有量化结果的：

| 项 | 复现（旧） | 修复后 |
|---|---|---|
| SD-05 合计阈值 | 3×1 字节 + 阈值 2 → 审批 0 次 | 审批 1 次 |
| SD-05 free root | `root=工作区` 命中 `node_modules` → 审批 0 次 | 1 次 |
| SD-06 | `C:\WORK\...\ITEMS` 判"不在 items 内" | 判在内 |
| SD-09 | 500MB 显示 `[500] [GB]`；存 501 → 501 GB | 显示 `[500] [MB]`；存 501 → 501 MB |
| SD-10 | `echo ready; find /tmp/x -delete` → false | true |
| SD-11 | 字符串含 `#` 后接 `unlinkSync` → false | true |
| SD-12 | `foo--previewbar` → `foobar` | 原样 |
| SD-13 | 配置 `stateDir` 被忽略，指向默认目录 | 指向配置目录 |
| SD-14 | `git log 1.10.0..HEAD` → unknown revision | `v1.10.0..HEAD` 有效 |
| SD-17 | `# file.Delete()` → true | false |
| SD-18 | 同补丁两行同 id → PASS | FAIL + 两处行号 |
| SD-20 | 文档 99 / 代码 1 → "一致" | FAIL |
| SD-21 | 冻结随机源 → 第一份被覆盖 | 换 id，两份都在 |
| SD-23 | `<ws>/application` → free | protected |
| X-2 | `C:\` → free | protected |

---

## 相关测试

新增 18 个测试文件、127 项：

```
tests/manifest-read-error.test.ts          SD-01   7
tests/copy-fallback-safety.test.ts         SD-02/04 6
tests/directory-restore-sd03.test.ts       SD-03   6
tests/approval-aggregate-sd05.test.ts      SD-05   6
tests/path-case-sd06.test.ts               SD-06   6
tests/cleanup-lock-sd07.test.ts            SD-07   6
tests/worker-exit-sd08.test.ts             SD-08   4
tests/bytes-unit-sd09.test.ts              SD-09   3
tests/command-prefix-sd10.test.ts          SD-10  15
tests/command-lexing-sd11.test.ts          SD-11/17 15
tests/slash-preview-sd12.test.ts           SD-12   7
tests/cli-statedir-sd13.test.ts            SD-13   6
tests/release-flow-sd14.test.ts            SD-14   7
tests/edit-during-save-sd15.test.ts        SD-15   4
tests/slash-clean-sd16.test.ts             SD-16   6
tests/duplicate-rowid-sd18.test.ts         SD-18   5
tests/id-collision-sd21.test.ts            SD-21   4
tests/bytes-minimum-sd22.test.ts           SD-22   4
tests/ancestor-protection-sd23.test.ts     SD-23   9
```

### 关于"源码字符串断言"这条要求

任务书明确要求：源码断言可以约束结构，但**不能替代**并发/接线/就绪态测试。

逐项落实：

| 项 | 真实行为测试 | 源码断言（仅补充） |
|---|---|---|
| SD-05 | 合计阈值审批次数、拒绝后零移动、模式命中 protected | 钩子无 `free → next()` |
| SD-07 | 陈旧锁接管、活锁不被抢、无残留 | rename 后核验 token |
| SD-08 | 真实 spawn 往返必须以终态结束 | 监听 `exit` 且释放锁 |
| SD-09 | **jsdom 真实渲染**，改数字点保存看 mutate 载荷 | — |
| SD-15 | **jsdom 真实渲染 + 挂起 mutate** | 回填是合并而非替换 |
| SD-19 | 让组件抛错，脚本必须变红 | — |
| SD-20 | 篡改 README 默认值，脚本必须变红 | — |
| SD-22 | **jsdom 真实渲染**，0.5MB 拒绝 / 1MB 接受 / 0 接受 | — |

**两处确实只能靠源码断言，并已在测试注释里写明原因**：

- **SD-07 的 token 核验**（`tests/cleanup-lock-sd07.test.ts`）：这是跨进程
  交错，单进程里 `tryAcquireLock` 是顺序调用的，交错不会发生。我实证过：
  去掉比对后行为测试**仍然全绿**，只有结构断言失败。
- **SD-08 的 exit 监听**：触发需要"worker 文件缺失"，那在构建产物层面才存在。
  同样验证过：删掉整个监听器不被抓到（我的结构断言太弱），但删掉**释放锁**
  那一行会失败 —— 后者才是缺陷本质。

### 变异检验

每项修复都做了变异检验（把代码改回缺陷形态，确认测试变红）：

| 项 | 变异 | 抓到 |
|---|---|---|
| SD-03 | 退回 `cpSync` | 1 |
| SD-05 | `needsAggregateApproval = false` | 3 |
| SD-06 | `normalize` 不做大小写 | 1 |
| SD-07 | 去掉 token 比对 | 1 |
| SD-08 | exit 不释放锁 | 1 |
| SD-09 | 下拉缺省退回 GB | 1 |
| SD-10 | 去掉参数级标记检查 | 5 |
| SD-11 | 引号状态失效 | 2 |
| SD-12 | 退回全局替换 | 3 |
| SD-13 | 不读配置 | 2 |
| SD-15 | 退回整体替换 | 3 |
| SD-16 | 忽略 scheduled | 3 |
| SD-18 | 关闭同文件重复检测 | 2 |
| SD-19 | 组件一调用就抛 | 脚本变红 |
| SD-20 | README 默认值改 99 | 脚本变红 |
| SD-21 | 退回 recursive | 3 |
| SD-22 | 去掉 1MB 下限 | 1 |
| SD-23 | 去掉祖先判断 | 3 |

**两次变异检验救了我**：SD-09 的第一版测试（纯函数复刻）和 SD-08 的第一版
结构断言（太弱），都是变异检验暴露的。没有它我会交付两个假绿的测试。

---

## 源码与 lib 是否一致

**一致。** `lib/` 每次修改后都重建，且都在同一个提交里。

验证：`pnpm build` 在最终状态下重新跑过，产物无变化（工作区干净）。

---

## 数据格式及平台兼容影响

### 索引 / 条目格式

**没有破坏性变更。**

- 条目 id 形态不变：`YYYYMMDD-HHMMSS-base36`。
- `index.json` / `manifest.json` 结构不变；SD-01 只**收紧了校验**
  （更严格的读取），写入格式未变。
- 旧索引可直接读：新增的 `readDirState` 只影响判定，不改变落盘。
- 旧 `items/<id>/` 布局不变，`safe_zone_restore` 对老条目照常工作。

### 平台行为

| 项 | 影响 |
|---|---|
| SD-06 | Windows 上路径比较改为大小写无关；POSIX 保持区分大小写（正确） |
| SD-03 | 目录恢复从"一次 rename"变成"逐项复制" —— 大目录变慢，这是有意的取舍（不覆盖用户内容优先于恢复速度） |
| SD-14 | 发布脚本在 Windows 上才能跑（之前必然 ENOENT） |
| SD-02 | 短写检测在任何平台都生效 |

### 行为变更（用户可感知）

1. **工作区里的模式删除每次都会问一次**（SD-05）。这是有意取舍 ——
   "先确认"是核心承诺。`never` 策略仍不打扰。
2. **斜杠 `clean` 未启动时返回 error 而非 success**（SD-16）。
3. **UI 拒绝 0.5MB 阈值**（SD-22），与斜杠入口一致。
4. **体检 `ok` 会为 false**（X-1）—— 之前有问题也是 true。

---

## 尚未修复编号与原因

**清单内：无。23 项全部修复。**

**已知残留（写在这里而不是藏着）：**

1. **SD-07 的 OS 级竞态**：`renameSync` 不校验 inode，极端竞争仍可能捕获活锁。
   现在能**检测并拒绝**，但彻底关闭需要 `fcntl` / `LockFileEx` —— 与零运行时
   依赖冲突。这是产品决策，已写进代码注释。
2. **SD-19 的字段渲染检查**：`verify-client-render.mjs` 无法做真实字段渲染
   （fake React 没有 `useEffect`）。改为"组件可调用"检查，并在输出里指路到
   真正的渲染测试。不是遗漏，是能力边界。
3. **SD-23 的软链接/junction**：祖先判断基于字符串归一化，不解析
   junction / 符号链接。审查也没能造出 junction 场景，所以**未验证**而非
   "已确认安全"。

---

## 真实 DSH 隔离 profile 验收情况

**未执行**，原因如下：

任务书明确要求 `不要运行 release / sync:install / 真实安装`。因此：

- ✅ 用**隔离临时目录 + 假回收站**做了全部行为验证（`os.tmpdir()` 下，
  每次清理）。
- ✅ 用**假 DSH_HOME + 假 profile** 验证了 CLI 的 `stateDir` 解析（SD-13），
  这是最接近"真实环境"的验证 —— 真实 spawn 了 CLI 进程。
- ✅ 用**真实构建产物**跑了 `verify-client-render`、`adversarial-probe`、
  `false-positive-probe`。
- ❌ **没有**在真实 DSH 里装上看效果。

**这意味着**：代码层面全部验证过，但"装进真实 DSH 后行为是否符合预期"
需要你在下一轮自己确认。建议重点看：

1. 工作区模式删除是否按预期每次弹一次审批（SD-05 的行为变更）；
2. 设置页的大小阈值单位显示是否与数字一致（SD-09）；
3. `/safe-delete clean` 在后台跑时的文案（SD-16）。

我这轮**没有**运行 `sync:install`，市场里的版本需要你自己更新。

---

## 回退办法

### 单个缺陷回退

每项都是独立提交，按编号回退对应 commit：

```
SD-01/02/04  →  3716c4e  v1.9.0
SD-03        →  bfa9b0a  v1.9.1
SD-05        →  c853d8e  v1.9.2
SD-06        →  7ee925d  v1.9.3
SD-07        →  6912380  v1.9.4
SD-08        →  1e758c9  v1.9.5
SD-09        →  7e188b6  v1.9.6
SD-10        →  2b0a6ba  v1.9.7（push 前）
SD-11/17     →  00c66f9  v1.9.8
SD-12        →  7ec4464  v1.9.9
SD-13        →  17d63e3  v1.10.0
SD-14/21     →  d456d1a  v1.10.1
SD-18/23     →  0bd4178  v1.10.2
SD-22        →  3bb0efd  v1.10.3
SD-16        →  ef9835d  v1.10.4
SD-19/20     →  115106d  v1.10.5
SD-15/文档    →  90e1856  v1.11.0
```

### 整体回退

```
git revert --no-commit 3716c4e..90e1856
```

或直接回到 v1.8.4：

```
git checkout v1.8.4
```

### 数据兼容

回退到 v1.8.4 **安全**：索引与条目格式未变，安全区内容可直接被旧版读取。
（新版写出的索引字段是旧的超集，无新增必填字段。）

---

## 一句话总结

23 项全部修复并验证，818 项测试（原 691）全部通过，5 个额外缺陷在实现过程中
被发现并修复，其中 2 个是我自己引入的回归、由既有测试抓到。
真实 DSH 环境验收按任务书要求未执行。
