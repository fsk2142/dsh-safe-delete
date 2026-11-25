# 配置页诊断

配置页不显示、显示但保存无效时，按下面的顺序查。客户端不再修改页面标题，
也不再向 `globalThis` 发布诊断数组；激活失败只写浏览器控制台。

## 1. 确认插件已加载

控制台应出现：

```text
[dsh-safe-delete] registered plugins.bundle.config
```

没有这行时，检查客户端 bundle 是否被加载，以及顶层 `inject = ['slots', 'locale']`
所需服务是否可用。

## 2. 检查激活错误

控制台可能出现的错误：

| 信息 | 含义 |
|---|---|
| `locale.register is unavailable` | 宿主 locale 服务不可用，槽位标签可能为空 |
| `ctx.inject is unavailable` | 当前 Cordis 版本不提供子插件注入，设置表单无法注册 |
| `settings remote capture failed` | `remote` / `remote.settings` 未成对取得 |
| `configForms service is missing get()/whileServed()` | 宿主配置表单服务契约不完整，表单不会出现 |
| `<step> failed` | 对应激活步骤抛错；其余步骤仍会继续 |

## 3. 检查表单读取状态

表单顶部会直接显示读取错误或提示：

- `读取配置失败`：`remote.settings.describe()` 返回失败信封；
- `没有读到本插件的配置`：命名空间不存在或值为空，显示默认值；
- `正在读取配置`：remote 尚未就绪或请求未返回。

`describe()` 的真实契约是：

```json
{ "ok": true, "value": { "writable": true, "namespaces": [{ "ns": "dsh-safe-delete", "value": {}, "revision": 1 }] } }
```

命名空间身份字段是 `ns`，不是 `name` 或 `id`。

## 4. 检查保存

- 保存使用 `mutate(ns, ops, revision)`；
- `ops` 是 `{ op: 'set', path: [key], value }` 数组；
- 连续保存必须使用最新 revision，否则宿主返回 `settings/conflict`；
- 保存成功后组件会重新 describe，但不会覆盖用户在请求期间的新输入。

## 5. 自动化验证

```bash
npx vitest run tests/client-registration.test.ts tests/client-interaction.test.ts
node scripts/verify-client-render.mjs
```

测试中的 fake remote 必须与真实信封同形；用裸值或默认值代替 describe 返回，
会把“读到配置”和“回落到默认值”混成同一种情况。
