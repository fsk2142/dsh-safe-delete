# 配置页诊断手册

这份文档解释配置页顶部「启动诊断」面板里每一步的含义，以及在某一项显示 ✗ 时该怎么做。
它是**手写的**——面板里那些行是程序自动记录的，这里说明的是"为什么查这一步"和"怎么处理"。

## 为什么需要它

配置页连续多轮不显示、显示但不生效、输入写不进去——这三种故障在界面上长得不一样，
但**原因往往同源**：客户端插件在宿主里的启动链有若干必须依次成立的环节，任何一环断掉，
界面只会呈现一个"空"，不会告诉你断在哪。

诊断面板把这 12 步逐一记下来，就是为了让"空"变成一个具体的失败点。

## 步骤说明

### 1. `apply() entered — inject=[...]`

宿主真的调用了客户端的 `apply`，并给出顶层 `inject` 声明。

**✗ 时**：说明 `apply` 从未执行。最常见原因是顶层 `inject` 里有服务解析不出来 ——
cordis 会让 fiber 停在 `FIBER_PENDING`，`apply` 永不运行。
本插件顶层只声明 `['slots','locale']`，就是为了缩小这个风险面。

### 2. `register locale dictionaries`

注册本命名空间的中英文案字典。

**✗ 时**：`ctx.locale` 不可用。槽位标签会解析成空字符串，配置页标题可能显示为空白。
检查 `locale` 是否在顶层 `inject` 里。

### 3. `capture the settings remote for the form`

在 `apply` 阶段把 `remote.settings` 取出来存进模块变量，供组件读取。

**关键**：组件渲染期**不能**直接访问 `ctx.remote` —— 那会被 cordis 的服务守卫拦下，
抛出 `cannot get property "remote" without inject`，而 React 错误边界会让整块界面变空白。
所以必须在 `apply` 里取好。

**✗ 时**：`ctx.inject(['remote','remote.settings'])` 拿不到服务。
注意 `ctx.remote.settings` 是**两步属性求值**，`remote` 与 `remote.settings` 都必须声明。

### 4. `register the config page on the plugin page`

把表单注册到 `plugins.bundle.config` 槽位，key 是**包名**。

**✗ 时**：通常是没有注册 `configForms` 服务，或槽位名/key 写错。
槽位名写错**不会报错**，只会永远不显示。

### 5/6. `publish diagnostics`

把诊断数组挂到 `globalThis`（控制台可查）并写进 `document.title`。

**用途**：当槽位没渲染时，插件自己的 UI 根本不存在，标题栏是唯一还能传达信息的地方。

### 7. `capture settings remote — ok`

`apply` 确实拿到了 remote。

### 8. `configForms service`

`configForms.get()` / `whileServed()` 可用。

**✗ 时**：宿主没提供配置表单服务，表单不会出现。

### 9. `describe() envelope — unwrapped`

**这一条曾经是 bug 的藏身处。**

宿主 `describe()` 返回的是信封：

```json
{ "ok": true, "value": { "writable": true, "namespaces": [...] } }
```

真实数据在 `value.namespaces`。如果按 `payload.namespaces` 读，永远拿到 `undefined`，
于是界面**永远显示 schema 默认值**，而保存其实成功了 —— 表现为"改完保存又变回原样"。

**✗ 时**：`describe()` 返回 `{ ok: false, error }`，看 error 内容。

### 10. `host namespaces — ...`

宿主返回的命名空间列表，形如 `dsh-safe-delete(7 keys), agent-default-model(3 keys), ...`

**怎么读**：

| 现象 | 含义 | 处理 |
|---|---|---|
| 列表里**没有** `dsh-safe-delete` | 命名空间名不匹配，或插件未装进该 profile | 检查包名与 `NAMESPACE` |
| 有，但括号是 `(0 keys)` | 命名空间存在但值是空的 | 尚未保存过配置，显示默认值是正常的 |
| 有，且 `(N keys)` | 正常，已读到配置 | — |

### 11. `describe() raw — ...`

原始 JSON（截断 400 字符）。这是**排查时最有用的一条**：当上面的解析结果看起来不对，
直接看原始形状就能判断是字段名不同、还是值被投影剥离了。

### 12. `picked namespace value — N keys, revision=M`

最终选中的那个命名空间有几个键、修订号是多少。

**revision 的用途**：保存时要把 revision 一起发给宿主，否则连续两次保存会撞上自己上一次
产生的修订号，第二次被当作冲突拒绝。

## 常见组合

| 组合 | 结论 |
|---|---|
| 第 1 步就 ✗ | `apply` 没跑，查顶层 `inject` 是否可满足 |
| 1–8 全 ✓，第 10 步 `empty list` | 命名空间对不上或插件未生效 |
| 第 10 步有 N keys，但界面仍是默认值 | 解析层级错了（即第 9 步那个信封问题） |
| 全 ✓，界面正常，但保存后回退 | 不要覆盖界面：宿主回读可能仍是旧快照 |
| 全 ✓，但提示"回读到的仍是旧值" | 写入已提交，宿主视图未刷新，重启后可确认 |

## 与测试的关系

这些步骤里，第 9 步（信封）和第 12 步（revision）都曾经在**测试全绿**的情况下出错。
原因见 `tests/client-interaction.test.ts` 的注释：假 remote 如果返回的形状与真实宿主不同，
测试就会自洽地通过，而真实环境失败。

**推论**：测试替身的形状必须与外部系统的真实契约一致；fixture 也不能用默认值，
否则"读到了"和"回落到默认值"在界面上无法区分。
