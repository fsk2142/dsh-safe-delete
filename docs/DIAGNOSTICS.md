# 配置页诊断

配置页不显示、显示但保存无效时，按下面的顺序查。

## 读取诊断记录

| 位置 | 读法 |
|---|---|
| 浏览器控制台 | 输入 `globalThis.__dshSafeDeleteDiag` |
| 页面标题 | 形如 `… · dsh-safe-delete ✓11 ✗1`，`✗` 的个数即失败步骤数 |

记录形状：`{ at, step, ok, detail? }`

## 症状对照

| 症状 | 查哪一步 | 处理 |
|---|---|---|
| 配置页完全不出现 | 1、4 | 见下方步骤 1 与 4 |
| 标题显示空白 | 2 | 检查 `locale` 是否在顶层 `inject` |
| 配置页出现但表单为空 | 3、8 | 检查 `remote` / `remote.settings` 成对声明 |
| 显示默认值，保存后变回原样 | 9、10 | 看原始形状（第 11 步） |
| 保存提示冲突 | 12 | 检查 revision 是否随请求发送 |

## 步骤

### 1 `apply() entered — inject=[...]`

**✗ 时**：客户端 `apply` 未执行。检查顶层 `inject` 声明的服务是否都能解析。

### 2 `register locale dictionaries`

**✗ 时**：`ctx.locale` 不可用。确认 `locale` 在顶层 `inject` 里。

### 3 `capture the settings remote for the form`

**✗ 时**：`ctx.inject(['remote','remote.settings'])` 取不到服务。两者必须都声明。

### 4 `register the config page on the plugin page`

**✗ 时**：未注册 `configForms` 服务，或槽位名/key 写错。槽位名写错不报错，只是不显示。

### 5 / 6 `publish diagnostics`

把诊断挂到 `globalThis` 与 `document.title`。

### 7 `capture settings remote — ok`

`apply` 已取到 remote。

### 8 `configForms service`

**✗ 时**：宿主未提供配置表单服务，表单不会出现。

### 9 `describe() envelope — unwrapped`

**✗ 时**：`describe()` 返回 `{ ok: false, error }`，按 error 内容处理。

返回形状：

```json
{ "ok": true, "value": { "writable": true, "namespaces": [...] } }
```

数据在 `value.namespaces`。

### 10 `host namespaces — ...`

输出形如 `dsh-safe-delete(7 keys), agent-default-model(3 keys), ...`

| 现象 | 处理 |
|---|---|
| 列表里没有 `dsh-safe-delete` | 检查包名与 `NAMESPACE` 是否一致，确认插件已装进该 profile |
| 有，括号是 `(0 keys)` | 尚未保存过配置，显示默认值属正常 |
| 有，`(N keys)` | 已读到配置 |

### 11 `describe() raw — ...`

原始 JSON，截断 400 字符。字段名不符或被投影剥离时，看这里。

### 12 `picked namespace value — N keys, revision=M`

保存时必须把 revision 一起发给宿主，否则连续两次保存会被判为冲突。

## 参考

`tests/client-interaction.test.ts` 的假 remote 需与宿主真实契约同形，fixture 不能用默认值 —— 否则「读到了」与「回落到默认值」在界面上无法区分。
