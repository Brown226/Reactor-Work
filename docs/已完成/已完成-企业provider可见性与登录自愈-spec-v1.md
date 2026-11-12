# 企业 provider 可见性与登录自愈（spec v1）

> 2026-10-30。修复三件同一根因的事故：聊天无可用模型、设置页堆 12 个空供应商、退出后点登录无反应。

状态：已实施（验收记录见 §6）

## 1. 问题

`~/.reactor/v2/provider_config.json` 的实测数据（2026-10-30 11:03）：

| 条目 | 名称 | baseUrl | 模型 | visibility |
| --- | --- | --- | --- | --- |
| new-provider | Reactor 企业服务端 | 127.0.0.1:8790 | 3 | **hidden** |
| new-provider-2 | … · 直连 · 本地 | 127.0.0.1:3425 | 0 | visible |
| new-provider-3~14 | … 2 ~ … 13 | 无 | 0 | 空壳 |

日志 `~/.reactor/v2/logs/2026-10-30.log` 10:57:11–10:58:32 连续 12 次：

```
reactor-server.login FAIL {"message":"凭据解密失败：…请重新登录"}
  at ensureManagedProvider → writeEnterpriseProvider → syncModels → Object.login
```

### 1.1 因果链

1. 某次 `syncModels` 的 `gatewayModels` 为空 → `writeEnterpriseProvider` 把网关 provider 置 `hidden`。
2. `createProviderSettingsView` 与 `createModelSelectionView` 都剔除 `hidden` → 聊天无可选模型 → 发送报 `model_config_missing` → 出现「当前没有可用模型」横幅。
3. `ensureManagedProvider` 只查 `getView()` → 看不见 hidden 条目 → 按地址、按名字都匹配不到 → 退回凭据锚点 `credentials.load(providerId)`。
4. 凭据解不开（dev 构建与安装包共用 `~/.reactor/v2`，safeStorage 密钥按 profile 隔离）→ 无 try/catch → `login` 整体失败。
5. 登录表单刻意隐藏 `isCredentialDecryptError` → 界面零反馈，表现为「点登录没反应」。
6. `cleanupOrphanGatewayProviders` 同样查 `getView()` 且只在 `writeEnterpriseProvider` 跑完才执行 → 登录一直失败 → 12 个空壳永久残留。

### 1.2 缺陷定性

- **通用缺陷**：`hidden` 让 provider 从所有内部读取路径消失，但生命周期（凭据锚点、模型对齐、空壳清理）仍依赖它。服务端一旦出现「全部模型配直连」就会进入不可恢复状态。
- **本机特有**：dev 与安装包共用凭据文件导致解密失败。员工机器不混装，但该错误一旦出现即为永久登录失败且完全静默。

## 2. 规则

### 2.1 hidden 只影响展示，不影响管理

- `hidden` 的语义收窄为「不在模型选择/供应商列表里展示给用户」。
- 服务层需要做身份识别、模型对齐、空壳清理时，必须使用**包含 hidden 的完整视图**。
- 所有 provider 读取入口按用途二选一：展示用 `getView()`，管理用 `getView({ includeHidden: true })`。

### 2.2 凭据是缓存，不是事实源

- `providerId` 凭据解不开时视为**缓存失效**：删除坏凭据、按地址/名字/完整视图重新识别，不得让登录失败。
- 解密失败只在日志记录，不阻断任何业务链路。

### 2.3 空壳自动回收

- 判定条件不变：网关族名字 + 无 baseUrl + 无模型 + 非本次生效条目。
- 清理范围扩展到 hidden 条目。
- 登录成功后执行；失败只记日志，不影响登录结果。

### 2.4 错误必须可执行

- 登录失败时界面必须给出用户能行动的原因。
- 凭据失效转为自动自愈后不再需要提示；其余错误照常展示。

### 2.5 内网口径文案

- 「没有可用模型」只陈述事实并指向「配置」，不出现「编程套餐 / 升级」。

## 3. 接口

### 3.1 `IProviderSettingsService`

```ts
getView(input?: { includeHidden?: boolean }): Promise<ProviderSettingsView>;
```

- 默认 `false`，保持既有展示语义。
- `true` 时返回全部 provider，`providerOrder` 同步包含 hidden 条目。

### 3.2 `reactorServerService` 内部

| 函数 | 读取方式 |
| --- | --- |
| `ensureManagedProvider` | `includeHidden: true` |
| `cleanupOrphanGatewayProviders` | `includeHidden: true` |
| `readManagedProviderEntry` / `readPersonalModelIds` | `includeHidden: true` |
| `claimUniqueProviderName` / `claimDirectProviderName` | `includeHidden: true`（名称唯一性要覆盖不可见占用者） |

### 3.3 凭据读取

`readManagedProviderId()` 解密失败时：`credentials.delete(providerId)` → 返回 `null` → 记 `warn`。

## 4. 验收场景

1. **hidden 恢复**：配置里存在 hidden 的网关 provider 且凭据 providerId 已损坏 → 登录成功；网关 provider 恢复 `visible`；模型出现在下拉。
2. **空壳回收**：存在 12 个空壳 → 首次登录成功后全部删除，设置页只剩网关分组 + 直连分组。
3. **凭据失效**：删除/破坏 `credentials.json` 中的 providerId → 登录仍成功，不出现「Provider 名称已存在」。
4. **无模型横幅**：故意清空所有模型 → 发送消息 → 横幅显示内网口径文案，且只有「配置」按钮，无「升级」。
5. **正常回归**：全新机器安装 → 登录 → 模型下拉只出现一个企业分组（或按直连地址分组），数量与服务端一致。
6. **退出再登录**：退出 → 重新输入账号密码 → 有明确成功/失败反馈，不再出现点击无响应。

## 5. 非目标

- 不改变直连分组按 baseUrl 归并的规则。
- 不删除网关 provider 本身（仍是授权锚点）。
- 不清理用户自建 provider（无托管哨兵 apiKey 的一律不动）。

## 6. 验收记录（2026-10-30）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 1 hidden 恢复 | 部分通过 | 本机实测：12:38 登录 `getStatus/refreshPolicy/getUsageOverview` 全 OK，无 login FAIL。网关 provider 仍 hidden（0 非直连模型，属规则 2.1 的设计态，服务端下发非直连模型后下一次 sync 自动回 visible）。凭据损坏路径由单测覆盖（场景 3）。 |
| 2 空壳回收 | 通过 | `provider_config.json` 从 14 条（11:03）降为 2 条（12:38）：网关 + 直连·本地。 |
| 3 凭据失效自愈 | 通过 | `readManagedProviderId` try/catch + 删坏凭据 + 按地址/名字/完整视图重识别；`reactorAuditWiring`/`reactorPolicyWiring` 等 services 测试 105/105。 |
| 4 无模型横幅口径 | 通过 | 代码核对：`ChatErrorBanner` 仅剩「配置」按钮，`onOpenUpgrade` 链路（ConversationComposer/SessionPane）整体删除；文案已改内网口径。 |
| 5 全新机器回归 | 未执行 | 本机不是全新环境；不制造假通过，需发版前用干净 profile 或新机验证。 |
| 6 退出再登录 | 通过（本机） | 退出链路单测覆盖（`登出：清空策略缓存`）；本机日志 12:07→12:28 两次重启登录态恢复，无静默失败。 |

验证范围：`pnpm typecheck`（全量，通过）、`pnpm lint`（0 errors；6 warnings 均为改动文件既有的未使用导入提示）、`pnpm architecture:check --changed`（0 violations）、services 全量测试 105/105、`ui/test/loginEntryGuard` 6/6、改动文件 `oxfmt`。

已知边界（不属本 spec，另行跟进）：

1. **存量 3.16.3 污染**：`hydratePendingPostUpdateReleaseNotes` 在启动时无条件把 `setting.pendingPostUpdateReleaseNotes`（版本高于当前）恢复成"待安装更新"，与本修复的"无更新源即跳过检查"门控独立。本机 `setting.json` 已无该字段，无残留；但装过 3.16.3 更新的员工机器升级 Reactor 后仍可能出现虚假 ready 状态与说明。候选方案：恢复 pending 时校验 `hasConfiguredUpdateSource()`，不通过即丢弃。待决策。
2. **内置 CDN schema FAIL**：host 启动拉 ZCode 官方 builtin provider 模板报 `invalid schema at providerRules.8.config.access.mode`。属上游数据与本地校验的兼容问题（存量链路），与本事故无关，待另立 spec。
3. `reactorPolicyWiring.test.ts` 两处断言 `overview.policyMode` 为 10-13 口径变更后的 stale 断言，本次已对齐现契约（改断言 `policySource`），非本 spec 范围。
