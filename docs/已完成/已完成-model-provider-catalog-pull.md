# 模型目录拉取（一键添加模型）契约

覆盖设置 → 模型配置里「一键拉取模型」：从供应商的 `/models` 目录一次拉取、多选批量添加。
改这条链路前先读本文；它横跨 UI（设置页）、服务层（host 进程）与网络边界。

## 1. 边界与所有者

| 项 | 值 |
| --- | --- |
| 触发入口 | `settings/model-provider-section/ProviderCardSections.tsx` 的「一键拉取模型」按钮（在「添加模型」左侧） |
| 选择 UI | `settings/model-provider-section/ProviderModelCatalogDialog.tsx` |
| 唯一实现 | `packages/services/src/model-provider/providerModelCatalog.ts` 的 `fetchProviderModelCatalog` |
| 对外接口 | `IProviderSettingsService.listProviderModelCatalog(input)` |
| 写入路径 | **不新增**：勾选确认仍逐个调用既有 `onAddModel` → `addPersonalModel` |

拉取是**只读**操作：不写 Personal Overlay、不进 Registry、不改模型顺序。
「添加」永远走已有的单模型添加路径，因此不会出现第二套写入语义或版本竞争处理。

## 2. 为什么在 host 进程拉取

渲染层直接 `fetch` 会被 CORS 拦：打包后渲染层是 `file://`（origin 为 opaque），
开发态是 `http://localhost:5174`，而供应商是否放行浏览器来源并不统一。
所以请求放在 host/Node 侧执行（`net`/Node 的 `fetch` 不受 CORS 约束），
UI 只通过 `useServices().providerSettingsService` 这条既有 RPC 拿结果：

```text
ProviderCardSections ──RPC──▶ host: providerSettings.service ──▶ fetchProviderModelCatalog ──▶ 供应商 /models
        │                                                                  │
        └── 打开 ProviderModelCatalogDialog ◀── { models: [{modelId,…}] } ──┘
                     │
                     └── 勾选确认 ──逐个──▶ onAddModel → addPersonalModel（既有写入路径）
```

远程 workspace 走同一条 RPC：请求由**持有该供应商配置的那台机器**发出。

## 3. 请求契约

- **参数**：`baseUrl`（与聊天请求同一份表单值）、`apiKey`（表单中正在编辑的值，回落已保存的 access）、`apiType`。
- **候选 URL**（只在 404 时降级到下一条，鉴权失败直接冒泡）：
  - `openai-chat-completions` / `openai-responses`：`<base>/models` → `<base>/v1/models`
  - `anthropic-messages`：`<base>/v1/models` → `<base>/models`
  - 仓库里 openai 形态的 Base URL 惯例带 `/v1`，anthropic 形态是站点根（聊天路径拼 `/v1/messages`），
    两种手填习惯都要能命中。
- **鉴权头**：`anthropic-messages` 用 `x-api-key` + `anthropic-version: 2023-06-01`；其余用 `Authorization: Bearer`。
  密钥为空时两个头都不带（部分网关允许匿名读目录）。
- **超时**：15s（`AbortController`），避免上游挂起把设置页永久卡在 loading。
- **响应解析**：顶层数组、`data[]`、`models[]` 三种形态；取 `id` / `name` / `display_name`；
  按 `modelId` 去重并排序后返回，保证弹窗顺序稳定。

## 4. 选择与写入规则

- 默认勾选 = 目录中**尚未添加**的全部模型；已存在的行禁用勾选并标「已存在」。
- 勾选状态是"用户 override 派生值"：目录刷新、批量添加完成都会重算可选集合，
  已成功的项自动退出勾选，**失败的项保持勾选**，可直接重试。
- 确认后**逐个 `await` 添加**：每次添加都会触发一次配置保存与视图刷新，并发提交会互相覆盖个人配置版本。
- 中途失败：已成功的保留，弹窗停留在错误态（`pullModels.addFailed`），不再自动关闭。

## 5. 失败语义

| 情况 | 表现 |
| --- | --- |
| 未填 Base URL | 服务层直接抛「未配置 Base URL，无法拉取模型目录」 |
| 401 / 403 | 透出 `HTTP <code>` + 响应片段，不换候选地址（换地址同样失败） |
| 404（第一条候选） | 自动换第二条候选；两条都 404 才报错 |
| 超时 / 网络错误 | 抛中止原因，弹窗显示在错误槽 |
| 目录为空 | 「该供应商返回的模型目录为空」 |
| 目录全部已添加 | 「目录里的模型都已添加，无需重复添加」，确认按钮禁用 |

拉取与批量添加共用一把 busy 锁（`catalogBusyRef`），重复点击不会并发拉取或重复提交同一批 ID。

## 6. 验收场景

1. 对自建网关（Base URL 形如 `http://127.0.0.1:8790/v1`）点「一键拉取模型」，弹窗列出目录且顺序稳定。
2. 全选未添加项 → 添加 → 模型列表出现对应行，且与逐个「添加模型」写入的是同一份 Personal 配置。
3. 再次打开弹窗：刚添加的行标「已存在」并被排除在勾选之外，计数从「已选 N 个」变小。
4. 拿一个错误密钥触发 401：弹窗显示可读错误，不弹第二个候选地址的 404 干扰信息。
5. 断网或上游超时 15s：按钮回到可点状态，弹窗给出错误而不是永久 loading。
6. 连续快速点击「一键拉取模型」只发出一次拉取（busy 锁生效）。

## 7. 关联测试 ID

`TID_MODEL_PROVIDER_PULL_MODELS_BUTTON`、`TID_MODEL_PROVIDER_CATALOG_DIALOG`、
`TID_MODEL_PROVIDER_CATALOG_CONFIRM_BUTTON`（`packages/shared/src/test-ids.ts`）。
