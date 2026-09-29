# 模型治理与开发者模式（本地模型配置隐藏 + 模型目录即白名单）

> 对齐原项目 Reactor-Desktop 的两条策略：**模型由服务端目录决定**、**本地模型配置必须藏起来**
> （后者之所以要藏，正是因为它绕过前者那套治理）。本文只写 Reactor-Work（ZCode 二开）里怎么落。

## 1. 产品规则

> 实现状态：两条策略均已落地（2026-09-21）。

### 1.1 本地模型配置界面：开发者模式（连点版本号 7 下）

- **默认隐藏**：设置导航里的「模型设置」在未解锁时不出现；「企业服务端」（登录 / 状态 / 刷新模型 / 退出）
  始终可见，它是被认可的模型来源。
- **解锁方式**：任意一处版本号**连续点击 7 下**（相邻两次间隔超过 1.5s 即归零重数）。
- **两个入口，各数各的**：每个入口有自己的计数器，混点不解锁——"在一个地方连续点 7 下"才可自我验证。
  当前落在两处版本号上：**设置 → 外观 的「应用信息」行**（`DevModeVersionLabel`，renderer 内
  `useDevTap` 计数）与**「帮助 → 关于 Reactor」弹窗的版本号**（main 侧
  `aboutDevModeTap.ts` 计数；About 是独立 renderer 进程，拿不到应用 store，故由 main 计数后把
  取反值广播回应用窗口，写入路径仍只有 `setDevModeUnlocked` 一条）。
  （2026-09-29 调整）侧栏底部的版本号入口已删除（footer 只留设置按钮）；原"fork 的关于是原生
  对话框、无法挂手势"的前提已不成立——About 现为自绘弹窗，可以挂手势。
- **途中不给进度**：只有解锁/反锁那一刻给结果提示（隐藏入口的进度条等于把后门画在门上）。
- **反锁要收尾**：当前正停在「模型设置」页时被反锁/换账号 → 自动退回「常规」页，不留空白内容区。
- **只藏界面不删配置**：反锁后本地 provider 配置仍在磁盘上。

### 1.2 模型目录即白名单（企业会话激活时）

- 企业会话激活（已登录企业服务端）时，**聊天里可选的模型 = 该会话从网关目录同步到的企业模型**；
  本地其它 provider 的模型不参与选择。
- **未登录 / 未配置企业服务端**时不做限制：本地 provider 正常可用（个人版/离线场景）。
- **开发者模式解锁 = 旁路**：解锁后本地 provider 重新可用（对应原项目「本地模型直连」的旁路口子）。
  这是一条**绕过治理的旁路**：不经网关的模型调用没有白名单校验、没有审计与用量上报。
- 企业模型的**鉴权仍走网关**（每次请求现场签发令牌），因此审计与用量在网关侧依然成立；
  本策略约束的是"能选到哪些模型"，不是"调用能否被审计"。

## 2. 状态所有者与接口

| 关注点 | 所有者 | 位置 |
| --- | --- | --- |
| 开发者模式开关 | 模块级小 store（localStorage 键 `zcode-dev-mode-unlocked`） | `packages/ui/src/lib/devMode.ts` |
| 连点计数与提示 | 同文件 hook（每个入口一份实例状态） | `packages/ui/src/lib/devMode.ts` |
| 设置分区可见性 | 既有闸门 | `packages/ui/src/lib/settingsNavigation.ts` 的 `isSettingsSectionEnabled`（`modelProvider` 读开发者模式） |
| 企业目录与登录态 | 既有企业链路（不改所有权） | `packages/ui/src/hooks/useReactorServer.ts` + `packages/services/src/reactor-server/*` |
| 模型可见性过滤 | 单一函数 | `packages/ui/src/lib/modelScope.ts`（`resolveEnterpriseModelScope` + `scopeModelSelectionView`） |
| 版本号入口 UI | 设置页入口一个组件 | `packages/ui/src/settings/DevModeVersionLabel.tsx` |
| About 入口的连点计数与广播 | desktop main | `packages/desktop/src/main/aboutDevModeTap.ts`（频道 `AboutVersionTap` / `DevModeUnlockChanged` / `DevModeUnlockReported`） |
| 桌面桥（订阅广播 + 上报本地变化） | RootInner 挂载一次 | `packages/ui/src/lib/devMode.ts` 的 `useDevModeUnlockBridge` |

**单一事实源**：开发者模式只有一个模块级布尔（`lib/devMode.ts`），两个入口读同一个值、各自计数；
设置导航与模型过滤都从它取数，不存在第二处开关。main 只保留一个 `latestKnown` 镜像供 About
连点取反，镜像由 renderer 上报刷新、main 不回播（无回环、无第二写入口）。企业目录仍由既有的
`reactorServerService` 同步与持有，本改造不新增同步路径。

## 3. 可见性与过滤

```
devModeUnlocked ─┐
                 ├─→ 设置导航：modelProvider 是否渲染（未解锁则不渲染）
reactorStatus ───┘
                 └─→ 聊天可选模型：激活企业会话且未解锁 → 仅企业模型；否则本地 provider 全量
```

- 过滤只在**一处**实现（`lib/modelScope.ts` 的 `resolveEnterpriseModelScope` +
  `scopeModelSelectionView`），聊天选择器的分组构造点调用它，避免两条判断。
- 判定输入只有两个：`devModeUnlocked` 与"企业会话是否激活且目录非空"；不读其它状态，避免出现
  第二套"当前是否企业模式"的判断。

## 4. 失败语义

| 情况 | 行为 |
| --- | --- |
| 未登录企业服务端 | 不限制模型（本地 provider 全量），「模型设置」仍按开发者模式隐藏策略处理 |
| 已登录但目录为空（同步中/失败） | 不限制，并在企业服务端面板显示原有状态；不因目录为空把可选模型清空 |
| 目录同步后被裁掉的模型 | 由既有 `reconcileProviderModels` 处理；聊天里选不到即视为不可用 |
| 反锁时正停在「模型设置」 | 退回「常规」页 |

## 5. 验收场景

1. 全新安装（未解锁）：设置导航无「模型设置」；「企业服务端」可见。
2. 在外观页版本号连点 7 下：出现解锁提示，「模型设置」出现在导航里；重启后仍解锁。
3. 在「帮助 → 关于 Reactor」弹窗的版本号连点 7 下同理（版本号下方出现结果提示）；但"外观点 4 下 + About 点 3 下"不解锁。
4. 已解锁时再连点 7 下：反锁并提示；此时若正停在「模型设置」页 → 自动回到「常规」。
5. 连点间隔超过 1.5s 重新计数；连点途中没有任何进度提示。
6. 登录企业服务端且目录同步成功：聊天模型选择器只列企业模型；本地 provider 模型不出现。
7. 同一状态下解锁开发者模式：本地 provider 模型重新出现在选择器里。
8. 退出企业登录：选择器恢复列出本地 provider 模型。

## 6. 不做 / 边界

- **不做服务端强制**：网关只做鉴权与审计；"能选哪些模型"是客户端治理（与原项目一致，
  绕过手段存在但需要显式解锁，且旁路调用不带网关令牌、在网关侧天然留痕/受限）。
- **不搬原项目 `prefs` 的分键细节**：fork 的 store 已有 localStorage 约定，按 fork 约定实现，
  不引入第二套偏好存储。
- **不跨窗口广播开发者模式**（2026-09-29 收窄）：本地入口（设置页版本号）仍是 localStorage + 本地订阅；
  只有 About 连点这一个跨进程动作会经 main 广播 `DevModeUnlockChanged`，应用窗口统一应用新值——
  这是从 About 窗口进入 store 的唯一通道，不是通用同步机制，仍不进 `BROADCAST_FIELDS`。
- **不改企业模型的物化方案**：`reconcileProviderModels` 把目录模型写进「Reactor 企业服务端」provider
  这一做法保留，本改造只在其上补"可见性收敛"。
