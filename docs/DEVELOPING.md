# 开发与验证（DEVELOPING）

面向改这个插件的人。**使用说明在 [`README.md`](../README.md)**，
交接要点在 [`HANDOVER.md`](../HANDOVER.md)。

## 日常命令

```bash
pnpm install
pnpm typecheck
pnpm vitest run
pnpm build                        # 产物到 lib/，需一起提交
node scripts/clean-test-tmp.mjs   # 清测试遗留临时目录
pnpm gate                         # 12 项全跑
```

`pnpm gate` 会把逐项结果连同 `git rev-parse HEAD`、时间、平台与「工作区是否有
未提交改动」写进 `gate-report.json`（不提交，见 `.gitignore`）。这句话的意思是：
**报告说的是哪个 SHA，由脚本自己记录**，不靠提交说明里的自述。

## 验证脚本

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

## 两套隐私扫描的分工

| 脚本 | 回答的问题 | 覆盖 | 不覆盖 |
|---|---|---|---|
| `privacy-audit.mjs` | 这次提交会不会**带进**新的泄露 | 工作区 + 暂存区文本 | 历史、二进制 |
| `privacy-history-audit.mjs` | **过去**有没有提交过敏感内容 | `git log --all` 的 diff 新增行、提交信息 | reflog / 不可达对象、tag 附注、Release 附件、CI 日志、二进制内容 |

两者都不替代 `gitleaks` / `trufflehog`：正式发布前应另跑专用工具。历史命中无法靠
"再提交一次"消除 —— 先判断它是否仍是**有效凭据**（有效则轮换），再决定是否有必要
改写历史。

历史扫描有两处**刻意收窄**的豁免，都写在 `privacy-history-audit.mjs` 里：

| 豁免 | 范围 | 为什么收窄 |
|---|---|---|
| 规则载体文件 | `scripts/privacy-audit.mjs` / `privacy-history-audit.mjs` / `verify-remote.mjs` 里的**上下文规则**（本机路径、对话痕迹、会话标识） | 那些行就是规则定义本身，不是数据 |
| 测试夹具路径 | `tests/` 与 `*.test.ts` 里的**上下文规则** | 那些命中是刻意构造的假数据 |

**凭据 / Token 规则在这两类文件里照扫**（第三轮复审 R03）：不存在"这是测试夹具"
这种解释 —— 要么是假 token，要么是真泄露，必须有人看一眼。

已确认无害的历史命中写进 `scripts/privacy-history-baseline.json`，精确到
`SHA + 文件 + 规则`，只影响那一条。**凭据类命中永远不能进基线**：基线里出现凭据
条目时脚本直接退出 2，而不是放行。

> **规则标签不含触发词**（2026-11-05 自检）：`对话痕迹` 这条规则原来的标签写了它
> 的一个检测词，于是**任何要写出规则名的文件**（基线、报告、文档）都会被它自己
> 判成泄露。修法是把触发词从标识里拿掉 —— 给每个这样的文件加豁免只是把症状按
> 文件数重复一遍。

## 升级 DSH 后

1. 确认 `engines.dsh` 是否需要改
2. 确认插件 import 的包都在新版本 `app.asar` 里
3. 确认关键 API 未变
4. `pnpm vitest run` 全绿

## 插件页显示的文档

DSH 的插件页会把**包的 `README.md` 整篇**渲染成正文（在 `package.json` 的
description 之下、配置行之上）。所以 README 必须只写**使用说明** ——
设计取舍放这里，实现交接放 [`HANDOVER.md`](../HANDOVER.md)。
