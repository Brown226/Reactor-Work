# 客户端模型分组按供应商简化（spec v1）

> 2026-10-29。解决模型下拉出现「Reactor 企业服务端」空壳分组、以及同一模型名在多个分组重复出现导致的选型困惑。

## 1. 问题

按 `direct_base_url` 分流后，客户端会生成两类 provider：

- 网关 provider：`Reactor 企业服务端`（baseUrl = 网关 8790）
- 直连 provider：每个不同上游地址一个（baseUrl = 该地址）

由此产生两种让用户无法选择的表现：

1. **空壳分组**：所有供应商都配了直连时，网关 provider 仍被无条件创建，模型数为 0，但供应商列表里仍存在，看起来像"另一个服务端"。
2. **同名模型重复**：不同供应商可能存在同名模型（如聚合平台与官方都是 `deepseek-v4-flash`）。直连组与网关组各有一份同名条目，用户不知道该选哪个。

另外，直连 provider 的名称由地址派生（`· qwen_medium`），对管理员直观，对普通员工不直观。

## 2. 规则

### 2.1 一个供应商一个分组

- 直连分组仍按 `baseUrl` 归并（provider 是 baseUrl 级语义），但**显示名优先取该供应商在管理台的名字**（`ai_providers.name`），取不到才回退地址派生。
- 同一 baseUrl 被多个供应商共用时，合并为一个分组，名字取该组第一个模型的供应商名。

### 2.2 网关分组只在真有网关模型时出现

- 有非直连模型 → 网关 provider `visible`，承载这些模型。
- 没有非直连模型（全部直连）→ 网关 provider 置 `hidden`，在模型选择里不再出现。
- 网关 provider **不删除**：它是登录凭据里的 `providerId` 锚点，授权层与网关令牌换发都依赖它。只改可见性。

### 2.3 同名模型直连优先

- 若某 `model id` 已进入任一该直连分组，则从网关分组中剔除，避免同一模型名出现两次。
- 剔除只影响下拉展示与可选性，不影响服务端模型配置。

### 2.4 隐藏不是删除，可逆

- 服务端恢复非直连模型后，网关 provider 会自动回到 `visible`（每次 sync 重算）。
- 直连地址被撤掉后，对应直连 provider 的模型被清空（既有 `pruneStaleDirectProviders` 行为不变）。

## 3. 接口

### 3.1 服务端 `/v1/models` 新增字段

```json
{ "id": "qwen3.8-27b", "provider_name": "Qwen（本部）", "direct_base_url": "http://..." }
```

- `provider_name` 取自 `ai_providers.name`，可为 null（老网关不下发）。
- 纯增量字段，老客户端忽略即可，行为逐字不变。

### 3.2 客户端命名

```
providerName 存在 → 「Reactor 企业服务端 · 直连 · Qwen（本部）」
否则            → 「Reactor 企业服务端 · 直连 · qwen_medium」（原地址派生规则）
```

名称唯一性仍由 `claimDirectProviderName` 兜底（撞名追加 host / 序号），不改动。

## 4. 验收场景

| # | 场景 | 期望 |
|---|---|---|
| 1 | 全部供应商走网关 | 只有「Reactor 企业服务端」一个分组 |
| 2 | qwen 直连、deepseek 走网关 | 两个分组：「· 直连 · Qwen（本部）」+「Reactor 企业服务端」（仅 deepseek） |
| 3 | qwen、deepseek 都直连，无其它网关模型 | 两个分组，**没有**「Reactor 企业服务端」空壳 |
| 4 | qwen 直连后撤掉直连地址 | 网关分组恢复 `visible`，qwen 模型回落网关组 |
| 5 | 直连组与网关组存在同名模型 | 下拉里只出现直连那一份 |
| 6 | 老网关（不下发 provider_name） | 回退地址派生名，行为与本次改动前一致 |
| 7 | 两个供应商共用同一 baseUrl | 合并为一个分组，名字取第一个供应商名 |

## 5. 边界

- ~~`hidden` 只影响**模型选择列表**（`model-selection-config` / `resolver` 均跳过 hidden）。凭据、授权、用量上报不受影响。~~
  **2026-10-30 更正**：这条写错了。`getView()` 本身也会剔除 hidden —— `facades.ts` 的
  `createProviderSettingsView` 里 `visibleProviders = resolvedProviders.filter(visibility !== "hidden")`，
  且返回的 `providers` 就是 `visibleProviders`。所以 hidden 会让条目从**全部业务视图**中消失，
  不只是模型选择列表。这条错误认知直接导致了下面 §6 的事故。
- 同名剔除按 model id 精确匹配，不做大小写折叠（与服务端模型 id 语义一致）。
- 直连地址若在员工机器上不可达，该组模型不可用；这是直连方案的固有权衡，不在本次范围。

## 6. 事故与修复：二次登录反复报「Provider 名称已存在」（2026-10-30）

### 现象

1.0.7 安装后：首次登录成功，**第二次登录必然失败**，登录卡片显示
`Provider 名称已存在: Reactor 企业服务端`。

### 真实数据（本机 `~/.reactor/v2/provider_config.json`，scope=tiankd）

```
new-provider      「Reactor 企业服务端」        base=127.0.0.1:8790/v1  visibility=hidden  3 个模型
new-provider-2    「… · 直连 · 本地」           base=127.0.0.1:3425/v1  visibility 未设    —
new-provider-3..14「Reactor 企业服务端 2 … 13」 base 缺失              模型为空            —  ← 12 个空壳
```

### 因果链

1. §3 的规则 3 引入：全部供应商都直连时，把网关 provider 置 `visibility: "hidden"`。
2. `getView()` 剔除 hidden（见 §5 更正）→ 下一次登录 `mine` 里**看不到**这个网关 provider。
3. 按地址找不到 → 走 `createPersonalProvider`；主名已被那个 hidden 条目占用，
   `nextPersonalProviderLabel` 自动改名成「Reactor 企业服务端 2」。
4. 紧接着 `savePersonalProviderOverlay(..., { providerName: "Reactor 企业服务端" })`
   要把名字写回主名 → 撞上 hidden 的占用者 → 抛错。
5. 抛错发生在配置写入之前，**空壳已经落盘**。于是每登录失败一次就多一个空壳：
   实测从「2」累积到「13」，共 12 个。
6. 恶性循环：空壳占着名字，主名却始终被 hidden 条目占着，下一次照样新建 + 抛错。

### 修复

| 改动 | 作用 |
|---|---|
| ① 可见条目命中时：改名失败**降级为不改名**再写一次 | 目标名可能被 hidden 条目占着，`claimUniqueProviderName` 看不见它；宁可名字丑，不可登录失败 |
| ② 引入**凭据锚点**：`cachedProviderId` / `REACTOR_SERVER_CREDENTIAL_KEYS.providerId` 直接按 id 写入，**不改名** | 凭据是唯一不受 hidden 过滤影响的权威定位；从根上避开"看不见的占用者" |
| ③ 新建分支不传 metadata | `createPersonalProvider` 已自动去重，写完不再二次改名 |
| ④ 新增 `cleanupOrphanGatewayProviders` | 登录成功后删除「网关族名字 + 无 baseUrl + 无模型 + 非本次条目」的空壳，自动清掉已产生的 12 个 |
| ⑤ `claimDirectProviderName` 的 selfIds 判据与 `ensureManagedProvider` 对齐（personalConfig 优先） | 避免把自己的 provider 误判成"占用者"，导致直连组每次 sync 都换名字 |

### 验收场景

| # | 场景 | 期望 |
|---|---|---|
| 8 | 网关 provider 处于 hidden，重新登录 | 复用原条目，不再新建空壳，登录成功 |
| 9 | 本地存在 12 个历史空壳 | 登录后自动删除，供应商列表里不再出现「… 2 …13」 |
| 10 | 本地存在一个可见的历史重名条目 | 改名失败时降级为保留原名，登录仍然成功 |
| 11 | 连续登录两次 | 第二次不产生任何新 provider 条目 |

### 已知残留

- 若凭据里的 providerId 已被用户删除，② 会失败并回落 ③ 新建；此时主名若被 hidden 条目占用，
  新条目会叫「… 2」。名字不理想，但登录成功，且②在下次登录起就能稳定命中。
- 本次修复**未做运行时验证**：开发机外网无法连内网上游，端到端需安装新包后在内网实测。
