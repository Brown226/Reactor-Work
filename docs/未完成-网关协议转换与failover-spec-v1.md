# 未完成：网关协议转换与上游 failover（spec v1）

> 落点：`server/`（独立 pnpm workspace，命令在 `server/` 目录执行）。

## 背景

参考 NewMax 的「本地代理做 Anthropic↔OpenAI 协议转换 + 自动 failover」。
Reactor 网关（`server/packages/server/src/gateway/`）有两处缺口：

1. **跨协议无转换**：`provider-api.ts:81 canServe()` 在供应商声明协议与入站形态不一致时
   **直接 400**（`protocol_mismatch`），文案自述「跨协议转换暂未实现」。
2. **无 failover**：`ProviderResolution` 是单个 provider，`proxy.ts` 四处裸 `fetch` 无重试、
   无超时、无候选上游。

## 本轮落地（三项，均无 DB 契约变更）

### 1. 协议转换（新文件 `gateway/protocol-convert.ts`）

纯函数，Anthropic Messages ↔ OpenAI Chat 请求体双向映射：

- 字段：model / system / messages / max_tokens / temperature / top_p / stop / stream / tools。
- 多模态：text / image（base64 ↔ data URL）/ tool_use ↔ tool_calls / tool_result ↔ role:tool。
- `needsConversion(api, inbound)`：只支持 anthropic-messages ↔ openai-chat 两两互转。
- `convertRequestBody(body, inbound, target)`：同形原样返回。

接入 `proxy.ts`：`canServe` 不匹配且 `needsConversion` 为真时，转 body 而非报错；
`upstreamShape` 取供应商声明协议。

### 2. 上游建连超时

`fetchUpstream()`：**手动 `AbortController` + 收到响应头即 `clearTimeout`**，
不用 `AbortSignal.timeout()`（后者会截断长 SSE 流）。默认 60s。

### 3. 同协议上游 failover（零 DB 契约变更）

- `registry.resolveModelCandidates()`：返回同名模型的**全部** provider 绑定（复用既有双键结构，
  同名模型本就可挂多供应商）。
- `ProviderResolution.fallbacks`：首选之外的候选链（显式 providerCode 时为空，尊重点名）。
- `proxy.forwardWithFailover()`：首选失败（网络异常/超时/429/5xx）时按候选逐个尝试；
  **候选须与首选同协议**（复用同一份 body/path/headers，跨协议候选跳过）。

## 状态所有者

| 环节 | 文件 |
| --- | --- |
| 协议转换纯函数 | `gateway/protocol-convert.ts` |
| 候选链解析 | `gateway/registry.ts`（`resolveModelCandidates` / `ProviderResolution.fallbacks`） |
| 转发 + 超时 + failover | `gateway/proxy.ts`（`fetchUpstream` / `forwardWithFailover` / `shouldFailover`） |

## 验收

- `cd server && pnpm --filter @reactor/server build` 通过。
- `cd server && node packages/server/scripts/protocol-convert-smoke.mjs` → **12 项通过**。
- `cd server && pnpm typecheck`（shared + admin + server）通过。

## 明确的边界与遗留

- **回执不做转换**：本版只转出站请求体。跨协议回执（含 SSE 事件形状）由端侧两条链路各自的
  解析器处理，未做网关侧回执转换。
- **failover 只覆盖同协议候选**：跨协议的备用上游（需转 body）未纳入，属后续。
- **`openai-responses` / `google-generative-ai` 仍不支持**：`needsConversion` 明确返回 false，
  维持原有报错。
- **admin 侧「测试连接」未接转换**：`testRequestFor` 对这两种形态仍返回「未实现」。
- **未做 DB 层的「备用上游优先级」字段**：本轮靠「同名模型挂多供应商」表达候选，
  不需要新列；若要管理台显式排序/开关，才需要加列（`ai_providers` 契约变更，须先定 migration）。
