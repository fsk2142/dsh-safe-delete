# 验收清单

按顺序手工执行。不符合预期就停下修，不要勾选。实际结果记在「实测」栏。

## 前置

```bash
pnpm typecheck && pnpm vitest run && pnpm build
```

三条命令都退出 0。

---

## 1 插件能被 DSH 加载

```
dsh plugin --profile <测试profile> add link:<本地路径>
```

启动 DSH。

**预期**：工具列表出现 `safe_delete`、`safe_zone_list`、`safe_zone_restore`、`safe_zone_status`、`safe_zone_check`。

**实测**：

---

## 2 裸 shell 递归删除被拦

让模型执行（`<测试目录>` 为工作区下的临时目录）：

```
Remove-Item -Recurse <测试目录>
```

**预期**：返回 `deny`，理由含 `safe_delete` 字样。

**实测**：

---

## 3 目标无法解析时按策略处理

```
Remove-Item -Recurse $tmp
```

| 审批策略 | 预期 |
|---|---|
| `ask` | 弹出审批卡片，说明目标无法静态解析，可拒绝或允许一次 |
| `never` | 直接拒绝，不弹卡 |

**实测**：

---

## 4 普通工作区文件不弹卡

调 `safe_delete`，目标为工作区下的文件。

**预期**：
- `preview:true` 返回 `PREVIEW (nothing moved)`，文件仍在
- 不带 preview 时不弹卡，直接移动，返回含 `id: <条目id>` 与到期时间

**实测**：

---

## 5 危险路径弹卡并授权

调 `safe_delete`，目标为用户主目录下的测试文件，如 `~/.dsh-safe-delete-probe.txt`。

**预期**：
- 弹出审批卡片，写明目标、大小、可恢复天数
- 点「拒绝」→ 工具返回失败，文件仍在
- 再调一次点「允许一次」→ 文件移入安全区

**实测**：

---

## 6 取回

用第 4 或第 5 步的 `id` 调 `safe_zone_restore`。

**预期**：返回 `restored to: <原路径>`，内容与删除前一致。

**实测**：

---

## 7 保留期到期后移入回收站

1. 配置 `retentionDays` 为 `1`，重启 DSH
2. 删一个文件，`safe_zone_list` 确认存在
3. 等到期后再调 `safe_zone_status`

**预期**：
- 输出含 `retention: 1d (time-only, no capacity cap)`
- 到期条目在下一次 `safe_zone_*` 工具调用时移走
- 移到系统回收站，不是永久删除

**实测**：

---

## 7b 立即清理

删一个未到期文件，点配置页「立即清理安全区」，或执行 `/safe-delete clean`。

**预期**：未到期条目也被移入回收站。

**实测**：

---

## 8 重启后状态仍在

重启 DSH。

**预期**：`safe_zone_list` 仍能看到重启前条目，到期时间不变。

**实测**：

---

## 9 CLI 可在不启动 DSH 时取回

```
node bin/dsh-safe-delete.mjs list
node bin/dsh-safe-delete.mjs undo <id>
```

**预期**：`list` 列出条目；`undo` 还原文件，输出 `restored to: ...`。

**实测**：

---

## 10 只读体检不写文件

```
node bin/dsh-safe-delete.mjs check
```

**预期**：输出 `safe_zone_check: PASS`（或 FAIL 项），不产生新文件。用 `git status` 确认。

**实测**：

---

## 不在范围

- 组合快照 / 回滚
- 跨卷复制式移入（`crossVolumeCopy` 默认关闭）
- 浏览器端 UI（审批卡片由 DSH 自带）
