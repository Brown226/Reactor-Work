# 模型能力自动检测（拉取模型时自动配置能力标记）

状态：已实现并验证
日期：2026-10-22（落地验证 2026-10-29）
影响面：`server/packages/server/src/gateway/*`、`server/packages/admin/src/pages/ModelsAndProviders.tsx`

## 1. 问题

`/v1/models` 下发的 `supports_*` 由 `ai_models.features` 决定。`features` 为空 → 网关下发 `supportsTools:false`
→ 桌面端在 `apps/zcode-cli/packages/adapters/src/model/model.ts:157` 本地拦截：
`Model does not support tool calls`，编程模式第一轮即失败，请求根本不到上游。

`features` 为什么会空：`admin-routes.ts` 的 discover 只有两级判定

| 级 | 条件 | 现状 |
| --- | --- | --- |
| ① | 上游 `/models` 声明了任意 `supports_*` | 聚合型上游（magpie）**不声明** |
| ② | 内置快照 `findModelPreset` 精确/归一化匹配 | 快照 19 条，模型名是 `auto/dfmodel`、`group/never-stuck` 这类**平台自定义别名**，匹配不上 |

实测（本机库）：`magpie-local` 名下 10 个模型 `features` 全为 `[]`；`stepfun` 的 `step-3.5-flash`
标了 `["tools","reasoning"]` 就正常。→ 结论：不是模型不支持，是元数据缺失。

## 2. 目标

在**拉取模型**这一步就把能力配好，不要求管理员逐个手工勾选。

非目标：
- 不改变「上游显式声明优先」的既有语义
- 不把「未知模型」猜成 `tools=true`（见 §4 保守原则）

## 3. 方案：在既有两级之后补两级

```
① 上游声明 supports_*        → 源 upstream（不变）
② 内置快照精确匹配            → 源 preset  （不变）
③ 名字推断（离线，零请求）    → 源 inferred（新增）
④ 真实探测（显式触发）        → 源 probe   （新增）
```

### 3.1 ③ 名字推断 `inferFeatures(modelId)`

位置：`packages/server/src/gateway/model-capabilities.ts`

- 先归一化：去 vendor 前缀（最后一个 `/`）、转小写
- **非对话模型**（`embed` / `rerank` / `bge-` / `vector` / `clip`）→ 直接返回空，不参与
- 家族表匹配（`claude` / `gpt-` / `o1|o3|o4` / `gemini` / `qwen` / `deepseek` / `glm` / `kimi` /
  `minimax` / `llama` / `mistral` / `doubao|seed` / `hunyuan` / `ernie` / `mimo` / `step-` / `longcat`）
- 修饰词补充：`vl|vision|omni|multimodal|4v` → +`vision`；`audio|realtime|voice` → +`audio`；
  `video` → +`video`；`reasoning|thinking|r1|think` → +`reasoning`
- 返回 `{ features, confidence, basis }`，`basis` 是命中的家族/关键词（UI 展示，便于复核）

### 3.2 ④ 真实探测 `probeToolsSupport`

发一个**极小**的 chat 请求，带一个 `noop` 函数定义：

```json
{ "model": "<id>", "messages": [{ "role": "user", "content": "hi" }], "max_tokens": 1,
  "tools": [{ "type": "function", "function": { "name": "noop", "description": "noop", "parameters": { "type": "object", "properties": {} } } }] }
```

判定：

| 上游响应 | 结论 |
| --- | --- |
| HTTP 200 | `tools = true`（带 tools 能跑通，这是功能性验证） |
| 4xx 且 body 含 `tool` / `function` | `tools = false` |
| 其他（超时、5xx、无关 4xx） | `null`（**不改**，不猜） |

探测只判定 `tools` 一项——它是当前故障点，且是唯一能靠单次请求确认的能力（vision 需要图片输入，
成本与形状都不同）。其余能力由 ③ 推断或手工勾选。

### 3.3 接口

`POST /admin/providers/:id/probe-features`

```json
{ "models": ["auto/dfmodel"], "apply": true }
```

- `models` 省略 → 该供应商下所有 **enabled 且 model_type=chat** 的模型
- 串行执行（避免打爆上游并发，qwen 类上游有 4 并发限制），单模型 15s 超时
- `apply: true` → 写回 `ai_models.features`：`tools=true` 追加，`tools=false` 移除，其他能力不动
- 返回逐条结果，含 `httpStatus` 与脱敏后的 `detail`

### 3.4 discover 接入

`admin-routes.ts` 的 features 判定改为三级兜底，并新增两个响应字段：

- `featureSource`: `upstream | preset | inferred | none`
- `featureBasis`: 推断依据（如 `家族:deepseek`）

前端导入逻辑已按 `FEATURES` 白名单过滤 `m.features`，**无需改动即可落库**。

## 4. 保守原则（必须保留）

- 完全未知的名字（`dfmodel` / `qfmodel` / `never-stuck`）→ ③ 返回空 + `confidence=none`，
  不猜 `tools=true`。误标会把「本地明确报错」变成「上游 400」，更难排查。
- 探测只在显式触发时跑，不在 discover 里内联（10 个模型串行要 20–30s，且消耗并发额度）。
- 探测结果写库前不覆盖已有能力：只增删 `tools`，其他键保持。

## 5. 验收

| 场景 | 期望 |
| --- | --- |
| `workbuddy/deepseek-v4.1-flash` 拉取 | 推断出 `tools,reasoning`，源 `inferred`，basis 含 `deepseek` |
| `auto/dfmodel` 拉取 | 仍为空，源 `none`（等待探测） |
| 对 `auto/dfmodel` 探测（上游支持 tools） | `tools=true`，写库后 `/v1/models` 下发 `supports_tools:true` |
| 对不支持 tools 的模型探测 | `tools=false`，不写 `tools` |
| 探测超时 | `null`，不写库，返回可读错误 |
| 上游声明了 `supports_tools:false` | 仍走 ①，不被 ③ 覆盖 |

## 6. 遗留

- vision/audio/video 无法靠单次文本请求探测，只做名字推断
- 探测会产生极少量真实 token 消耗（`max_tokens: 1`）

## 7. 实际落地（2026-10-29）

### 7.1 与设计的差异

| 项 | 设计 | 实际 |
| --- | --- | --- |
| 自动落库 | 只写候选清单，由导入带走 | **补了第三级**：已入库且能力为空、来源为 `inferred` 的模型，discover 时直接写库（`autoApplied` 回报条数）。否则「拉取时自动配置」等于没做——用户还得再勾选已入库模型点导入 |
| `stored` 来源 | 无 | 已入库的模型以库值展示（手工勾选/探测结果不能被建议值覆盖） |
| 协议判断 | 只允许 `openai-chat` | **`auto` 也允许**（magpie 的 api 就是 `auto`）。`auto` 语义是入站形态直通，探测主动构造请求，按 OpenAI Chat 发即可 |
| 401 归类 | 统一走「无法判定」 | 单独给文案「上游鉴权失败（密钥无效或已过期）」。401 报文常含 "function calling" 字样，按关键词判会得出「不支持工具」的错误结论 |

### 7.2 验证证据（真实服务 + 真实上游）

| 验证 | 结果 |
| --- | --- |
| 离线推断 10 条断言 | 全部 PASS（含未知别名必须为空、向量模型不得标注） |
| 探测判定 5 条分支（本地假上游） | 200→true / 400-tools→false / 400-无关→null / 401-含function→null / 超时→null，全部 PASS |
| 真实探测 `auto/dfmodel` | HTTP 200 → `tools=true` → 写库 `["tools"]` |
| 网关下发 | `supports_tools: true`（改前为 `false`） |
| 批量探测 4 个未知别名 | `group/never-stuck`、`qoder-cn/dfmodel` → true 并写库；`qoder/dfmodel`、`qoder/qfmodel` → 401 判 null，**未写库** |
| 自动补全 | 第一次 discover `autoApplied=5`，第二次 `=0`（幂等） |
| 最终库状态 | magpie 10 个模型中 8 个有 `tools`，2 个因上游 401 保持空 |
| 端口隔离 | 8791 `/console` 404、8792 `/console` 200、登录 200（未被本次改动破坏） |

### 7.3 需要人工处理

`qoder/dfmodel`、`qoder/qfmodel` 两个模型的上游账号（Qoder）已过期，探测返回 401。
这不是能力问题，需要在上游侧重新登录，之后再点一次「自动检测能力」即可。

### 7.4 客户端影响

`supports_tools` 是既有下发字段，1.0.5 客户端已经会读，**本次改动不需要出新的客户端包**；
用户在客户端点一次「同步模型」或重新登录即可生效。
