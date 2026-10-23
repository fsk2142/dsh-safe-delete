# 验收清单

按顺序手工执行。**每条都写明预期看到什么**；实际结果记在「实测」栏。
任何一条不符合预期就停下来修，不要勾选。

## 前置

```bash
pnpm typecheck && pnpm vitest run && pnpm build
```

三条命令都必须退出 0。

---

## 1. 插件能被 DSH 加载

把插件以 `link:` 方式装进一个测试 profile：

```
dsh plugin --profile <测试profile> add link:<本地路径>
```

启动 DSH。

**预期**：DSH 正常启动；工具列表里出现 `safe_delete`、`safe_zone_list`、
`safe_zone_restore`、`safe_zone_status`、`safe_zone_check`。

**实测**：

---

## 2. 裸 shell 递归删除被拦

让模型执行（`<测试目录>` 换成任意工作区下的临时目录）：

```
Remove-Item -Recurse <测试目录>
```

**预期**：调用被拒绝（`deny`），理由里出现 `safe_delete` 字样，并明确说"不要换别的办法绕过"。

**实测**：

---

## 3. 目标无法解析时弹审批卡而不是直接拒绝

让模型执行：

```
Remove-Item -Recurse $tmp
```

**预期（审批策略为 `ask` 时）**：聊天框上方出现审批卡片，内容说明"目标无法静态解析"，
可以点「拒绝」/「允许一次」（或 Esc / 回车）。

**预期（审批策略为 `never` 时）**：直接拒绝，**不弹卡**。

> 这是与 dsh-safety 最关键的行为差异：dsh-safety 会把 `$tmp` 拼成一个路径再判成
> "在你家目录里"，结果是莫名其妙的拒绝并且没有任何出路。

**实测**：

---

## 4. 普通工作区文件不弹卡

调 `safe_delete`（`preview:true` 先看，再去掉 preview 执行），目标是工作区下的一个文件。

**预期**：
- `preview:true` 时返回 `PREVIEW (nothing moved)`，文件还在，显示大小与分类。
- 不带 preview 时**不弹卡**，直接移动，返回文本里含 `id: <条目id>` 和到期时间。

**实测**：

---

## 5. 危险路径弹卡，且在界面内完成授权

调 `safe_delete`，目标是用户主目录下的一个测试文件（例如 `~/.dsh-safe-delete-probe.txt`）。

**预期**：
- 弹出审批卡片，写明要删什么、多大、进安全区后可恢复多少天。
- 点「拒绝」→ 工具返回失败、**文件仍在**。
- 再调一次并点「允许一次」→ 文件被移入安全区。

**实测**：

---

## 6. 取回

用第 4 步或第 5 步得到的 `id` 调 `safe_zone_restore`。

**预期**：返回 `restored to: <原路径>`，文件回到原位、内容与删除前一致。

**实测**：

---

## 7. 保留期到期后移入回收站

安全区**不再有容量上限**（容量层已移除），所以这一步验证的是时间维度。

1. 把配置里的 `retentionDays` 临时调成 `1`，重启 DSH；
2. 删一个文件，`safe_zone_list` 确认它在；
3. 等过 1 天（或临时把 `retentionDays` 改回更小值再触发一次工具调用），
   然后调 `safe_zone_status`。

**预期**：
- `safe_zone_status` 的输出里应能看到 `retention: 1d (time-only, no capacity cap)`；
- 到期条目在下一次 `safe_zone_*` 工具调用时被移走（**没有后台定时器**，
  所以"到期"不等于"准点"，这一点状态输出里也写明了）；
- 被移走的条目进的是**系统回收站**，不是永久删除 —— 去回收站里应该能找到。

**实测**：

---

## 7b. 立即清理（不看保留期）

新删一个文件（还没到期），然后点配置页的「立即清理安全区」，或执行
`/safe-delete clean`。

**预期**：未到期的条目也被移入回收站 —— 这是手动释放空间的出口，
用途是「一天内删太多，安全区撑大了」。

**实测**：

---

## 8. 状态落盘，重启后仍在

重启 DSH。

**预期**：`safe_zone_list` 仍能看到重启前的条目，到期时间不变。

**实测**：

---

## 9. 独立 CLI 能在不启动 DSH 的情况下取回

在终端里（`DSH_HOME` 指向同一个 profile 的 home）：

```
node bin/dsh-safe-delete.mjs list
node bin/dsh-safe-delete.mjs undo <id>
```

**预期**：`list` 列出条目；`undo` 把文件还原，输出 `restored to: ...`。

> 这条是兜底能力：即使 DSH 打不开、插件没加载，被删的东西也能拿回来。

**实测**：

---

## 10. 只读体检不写任何文件

```
node bin/dsh-safe-delete.mjs check
```

**预期**：输出 `safe_zone_check: PASS`（或列出 FAIL 项），**不产生任何新文件、不建快照**。
可用 `git status` 或对比 `$DSH_HOME` 的文件时间戳确认。

**实测**：

---

## 已知未覆盖

以下能力**不在**本次范围，验收时不需要看：

- 组合快照 / 回滚（桌面版有原生 `sanitizeProfile` 兜底）
- 跨卷复制式移入（`crossVolumeCopy` 默认关闭）
- 浏览器端 UI（审批卡片由 DSH 自带，本插件不写）
