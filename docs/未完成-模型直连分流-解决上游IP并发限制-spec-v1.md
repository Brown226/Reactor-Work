# 模型直连分流：解决上游按源 IP 限并发（spec v1）

> 状态：代码已落地，**未做运行时验证**（开发机在外网，内网上游不可达；Docker 未运行）。
> 日期：2026-10-22

## 1. 问题

内网上游按**源 IP** 限制并发（qwen 类模型上限 4，deepseek 不限）。

改造前所有客户端请求都经服务器网关出站，全部用户共享服务器一个出口 IP →
第 5 个并发请求直接 429，且网关只会 failover 到同一上游，最终表现为用户报错。

网关侧代码核实（`gateway/proxy.ts`）：没有任何上游并发控制，没有信号量、没有队列；
429 只被判定为「可切下一个上游」（`shouldFailover`）。所以靠网关排队只能止血，不能提升吞吐。

## 2. 方案：按模型分流，让直连模型的出口 IP 变成用户自己的机器

```
                 ┌──────────────────── 控制面：服务器 8791 ────────────────────┐
                 │  登录 / JWT ・ 模型授权白名单 ・ 用量与审计接收              │
                 └───────────┬──────────────────────────┬────────────────────┘
                             │ 下发模型清单               ▲ 异步上报用量
                             │（含 direct_base_url）      │
        ┌────────────────────▼──────────┐      ┌──────────┴─────────────┐
        │ 用户 A 客户端                  │      │ 用户 B 客户端          │
        │  qwen  → 直连上游（出口 IP-A） │      │ qwen → 直连（IP-B）    │
        │  deepseek → 服务器网关 8790    │      │ deepseek → 网关        │
        └───────────────────────────────┘      └────────────────────────┘
```

**为什么管控不会丢**（这是方案成立的前提，已核实）：

| 环节 | 实现 | 依赖流量经网关？ |
|---|---|---|
| 用量事件源 | 客户端订阅 `task_token_usage_delta` | ❌ |
| 企业归属判定 | `isReactorServerManagedApiKey(apiKey)` 哨兵判定 | ❌ |
| 上报出口 | `POST {serverUrl}/desktop/audit/...`（8791 身份服务） | ❌ |
| 模型授权 | 模型清单由服务端下发 | ❌ |

## 3. 落点

### 服务端（`server/`）

| 文件 | 改动 |
|---|---|
| `gateway/admin-schema.ts` | `ai_providers` 新增 `direct_base_url TEXT`（NULL = 经网关转发） |
| `gateway/registry.ts` | 查询带出 `p.direct_base_url`；`ModelEntry.directBaseUrl` |
| `gateway/proxy.ts` | `/v1/models` 每模型下发 `direct_base_url` |
| `gateway/admin-routes.ts` | provider 的 GET/POST/PATCH 支持 `directBaseUrl`（空串 = 清空） |

### 客户端（主仓）

| 文件 | 改动 |
|---|---|
| `reactorServerClient.ts` | `ReactorServerModelInfo.directBaseUrl` + 解析 `direct_base_url` |
| `reactorServerService.ts` | ①抽出 `ensureManagedProvider(baseUrl, name)`；②`syncModels` 按 `directBaseUrl` 分组写 provider；③`pruneStaleDirectProviders` 回收过期直连；④`readAllManagedModelIds` 供重启兜底；⑤`isManagedProvider` 哨兵扫描 |
| `reactorServerP4Wiring.ts` | deps 新增 `isManagedProvider?`，`isEnterpriseProvider` 优先用它（未注入时回退旧判定） |

## 4. 关键设计决策

**D1｜为什么按 baseUrl 分组，而不是每个模型一个 provider**
provider 是 baseUrl 级语义。同地址的模型共用一个 provider，否则模型下拉会被拆成几十个分组。

**D2｜为什么不把所有模型都改成直连**
只有被限并发的上游需要。其余经网关能保留统一限流与审计口径。

**D3｜为什么 `isEnterpriseProvider` 改成哨兵扫描**
原实现只认凭据里记的**单个** providerId。拆成两个 provider 后，直连那批的用量会全部漏报（静默丢数据，比报错更危险）。改成「personalConfig.apiKey 是哨兵值」后与地址解耦，新增直连 provider 不需要维护地址表。

**D4｜为什么回收时只清模型、不删 provider**
删 provider 会级联丢配置，用户可能还在里面加过东西。清空模型后它在下拉里自然消失，下次原地复用。

**D5｜保留 `readManagedProviderEntry` 与旧判定分支**
只升级一端（老客户端连新服务端，或反之）时行为不突变。

## 5. 已知取舍（必须让使用者知情）

1. **模型下拉会出现两个分组**：「Reactor 企业服务端」（经网关）与「Reactor 企业服务端 · 直连」。这是拆 provider 的必然结果。
2. **安全边界从「网关鉴权」退化为「网络可达」**：直连意味着端侧持有上游地址；若上游不校验密钥，任何能连通该地址的人都能直接调用。**只对不校验密钥的内网上游适用。**
3. **停用生效有窗口期**：用户被停用后，已下发的直连地址在客户端下次 `syncModels` 前仍可用。
4. **共享 NAT 会失效**：若多台终端共享出口 IP，直连等于没做。需确认每台机器有独立 IP。

## 6. 启用方式

在管理台「模型与供应商 → 供应商配置」里，把**需要直连的供应商**的「客户端直连地址」配成客户端可达的上游地址（形如 `http://models.ai.cnpe.cc/qwen_medium/v1`），然后让客户端重新同步模型（重启或重新登录）。

## 6.1 管理台输入框（2026-10-22 补齐）

| 文件 | 改动 |
|---|---|
| `packages/admin/src/services/gateway-admin.ts` | `AdminProvider` 增 `directBaseUrl?`；`create` / `patch` 入参增该字段 |
| `packages/admin/src/pages/ModelsAndProviders.tsx` | 草稿类型 + 回填 + 提交 + 表单输入框（紧跟 Base URL 下一行） |

三态语义与服务端对齐，界面上刻意如此：

| 操作 | 提交值 | 服务端结果 |
|---|---|---|
| 从不填写 / 新建时留空 | `null`（create） | 走网关 |
| 编辑时把输入框删空 | `""`（patch） | 清空 → 回落到经网关转发 |
| 填入地址 | trim 后的字符串 | 该供应商名下模型由端侧直连 |

> **为什么编辑时必须显式传空串**：服务端 `undefined` 表示「不改」，若前端省略字段，「取消直连」将永远存不进去（会一直保留旧地址）。这是 UI 层最容易写错的一处。

## 6.2 验证证据（2026-10-22 实测，非推断）

镜像 `reactor-desktop-server:local` 重建并重启 identity/gateway 后：

| 验证项 | 结果 |
|---|---|
| `ai_providers.direct_base_url` 列 | 已由 `ensureSchema` 补齐（启动后存在） |
| `GET /admin/providers` | 每个供应商返回 `directBaseUrl`（未配置为 `null`） |
| `PATCH` 写入 → 回读 | `http://probe.local/qwen/v1` 成功写入并读回 |
| `PATCH {""}` 清空 | 读回 `null`，三态正确 |
| `GET /v1/models` 基线 | 6 个模型，`direct_base_url` 全为 `null` |
| 配置后（等 10s TTL） | 6 个模型全部携带 `http://models.ai.cnpe.cc/qwen_medium/v1` |
| 清空后（等 10s TTL） | 恢复为全 `null` |
| 管理台静态产物 | `index-Bm60cuI6.js`，内含「客户端直连地址」文案 |
| 数据完整性 | users 仍为 811，端口隔离（8791 `/console` 404、8792 `/console` 200）不变 |

## 7. 未验证项（如实记录）

| 项 | 原因 |
|---|---|
| 端到端分流效果 | 开发机在外网，内网上游不可达 |
| 双 provider 在模型下拉的实际显示 | 需安装运行 |
| `pruneStaleDirectProviders` 的回收路径 | 需运行两次 sync 才能观察 |
| 端到端实际并发分摊 | 开发机在外网，`models.ai.cnpe.cc` 不可达 |

## 8. 后续待办

- [x] 管理台 provider 编辑页增加「客户端直连地址」输入框（含说明与校验）—— 2026-10-22 完成
- [ ] **桌面客户端重新打包**：1.0.5 安装包不含直连逻辑，需重新出包后该机制才在端侧生效
- [ ] 网关侧补全局并发队列（仍未直连的用户兜底，把 429 变成排队）
- [ ] 端到端冒烟脚本：配置直连后验证 provider 分组与用量上报

## 9. 上游拓扑（2026-10-22 大王提供的清单）

| 模型 | 能力 | 上下文 | 路径前缀 |
|---|---|---|---|
| DeepSeek-V4-Flash | 对话、代码 | 400K | `/deepseek/v1` |
| Qwen3.8-27B | 对话、视觉、代码 | 256K | `/qwen_medium/v1` |
| Qwen3-VL-Embedding-8B | 多模态、向量检索 | 32K | `/embed26/v1` |
| Qwen3-VL-Reranker-8B | 多模态、结果重排 | 32K | `/rerank26/v1` |

关键结论：**同一主机、不同路径前缀**，所以应按「一个供应商一条路径」登记成两个 chat 供应商：

- `Qwen` → baseUrl `http://models.ai.cnpe.cc/qwen_medium/v1`，**填直连地址**（该模型限 IP 并发 4）
- `DeepSeek` → baseUrl `http://models.ai.cnpe.cc/deepseek/v1`，**留空**（不限并发，照旧经网关）

> 若把两者放进同一个供应商，`direct_base_url` 会在供应商级生效，DeepSeek 也会被迫直连——与「只让 qwen 分流」的目标相反。
