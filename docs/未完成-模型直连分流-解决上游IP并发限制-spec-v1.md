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

## 6.3 直连用量回填账本（2026-10-22 补齐）

**问题**：直连请求不过网关，而 `/desktop/usage/summary` 与部门额度评估**都以 `usage_ledger` 为唯一数据源**（网关转发时写入）。不补的话，被分流的模型用量整体漏计——报表偏低、额度算不到。

**做法**：端侧在 `model_call` 事件的 `usage` 里带 `directBaseUrl`（仅直连时填），服务端在 `/desktop/audit/batch` 接收后补写账本行。

| 约束 | 原因 |
|---|---|
| 只认带 `directBaseUrl` 的 `model_call` | 经网关转发的调用不带该字段，网关已记账，再补=重复计费 |
| 被 `validateEvent` 拒掉的事件不记账 | 不能凭非法上报产生费用 |
| `request_id` 用端侧 `eventId` | 离线重传命中 `ON CONFLICT DO NOTHING`，天然幂等 |

**踩到的坑**：`validateEvent` 对 `usage` 的每个字段做数字校验，白名单原本只放行 `currency/model/provider`；不加 `directBaseUrl` 会让**整条事件**被判非法拒收。

**实测证据**：

| 场景 | 结果 |
|---|---|
| 直连事件上报 | 账本 64 → 65，`provider` 存直连地址、`cost_source=client` |
| 网关事件上报（无标记） | 账本**不变**，无重复计费 |
| 同一条重复上报 | `duplicates=1`，账本仍 65（幂等） |
| `/desktop/usage/summary?groupBy=model` | 命中 `qwen3.8-27b`：calls 1 / 1500 tokens / cost 0.0123 |
| 清理 | 测试行已删，账本恢复基线 64 |

**取舍**：账本权威性由「网关事实」降为「网关 + 端侧上报」。端侧漏报/崩溃时该次直连用量会缺失，可用 `audit_event` 里的同一条 `model_call` 事后对账。

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

---

## 2026-10-29：三处缺陷的系统性修复

### 背景

直连分流把「一个企业 provider」变成了「一个网关 provider + N 个直连 provider」。
原有代码里多处是**按 providerId 硬判断**写的（只认登录时写入凭据的那一个），
加出第二个 provider 之后这些判断全部失真。前一天只修了直接报错的两处，
本次做完整扫描，把同一类问题一次清干净。

### 扫描方法

`grep` 全仓以下模式，逐个人工判定：
`readManagedProviderId` / `cachedProviderId` / `providerId ===` /
`isEnterpriseProvider` / `isReactorServerManagedApiKey`。

### 三处缺陷

| # | 位置 | 症状 | 修复 |
|---|---|---|---|
| 1 | `reactorServerService.ts` `claimDirectProviderName` | 多个直连地址共用同一 provider 名称，第二个创建时触发唯一性校验抛错，**登录界面报失败**（凭据实际已落盘）。 | 分层取名：短名 → 加 host → 加序号 → 完整地址；冲突判定与 `ProviderConfigService` 同口径（`toLocaleLowerCase`）；同一地址的已有 provider 不计入占用，保证复用不改名。 |
| 2 | `reactorServerService.ts` `resolveGatewayAuth` | 只认网关 provider 的 id，选直连模型时返回 `null` → 上层抛「企业服务端未授权：请在设置中登录企业账号」，**用户已登录却被要求重新登录**，请求根本发不出去。 | 改为哨兵 apiKey 扫描（与 `isEnterpriseProvider` / `resolveDirectBaseUrl` 同口径），并按是否直连分流：直连返回哨兵占位值，网关返回现场签发的网关令牌。**返回哨兵而不是 null** 是关键。 |
| 3 | `reactorServerService.ts` `clearEnterpriseProviderModels` | 登出只清网关 provider 的模型，直连 provider 的模型残留。用户仍能选到直连模型，端侧照配置直接请求上游——**真正绕过登录态**，比报未授权更糟。 | 改为扫描全部托管 provider 逐个清空模型。只清模型不删 provider，下次登录原地复用。 |

### 确认无问题的位置

| 位置 | 结论 |
|---|---|
| `reactorServerP4Wiring.isEnterpriseProvider` | 已注入 `deps.isManagedProvider`（`reactorServerService.ts:122`），走哨兵扫描 ✅ |
| `pruneStaleDirectProviders` | 本就按哨兵扫描全部托管 provider ✅ |
| `readAllManagedModelIds` | 同上 ✅ |
| `resolveDirectBaseUrl` | 同上 ✅ |
| CLI `runner.ts:173` | 用 `isReactorServerManagedApiKey` 判断是否走运行时鉴权，直连 provider 的哨兵值能被正确识别 ✅ |
| UI 层 | 无按 providerId 的硬判断 ✅ |

### 弹性处理

单个直连地址准备失败时只跳过该地址并记 `warn`，不再让整次 `syncModels`（进而整次登录）失败：
直连是绕开上游 IP 限流的优化，不是核心链路，其模型仍可经网关使用。

### 验证

- `tsc -b packages/services` 通过
- `pnpm lint` 0 error
- `pnpm architecture:check --changed` violations 0
- 取名唯一性：5 类冲突场景（不同路径段 / 同段不同 host / 旧名被占 / 同地址复用 / 10 个同段地址）全部唯一

**未做端到端验证**：开发机在外网，连不上内网上游，无法真实跑「选直连模型 → 发消息 → 上游返回」。
需在打包装机后于内网实测一次。
