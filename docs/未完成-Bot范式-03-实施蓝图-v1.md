# 融合实施蓝图：把「专家」升级成「团队」

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-05 |
| 目标仓库 | Reactor-Work（`zcode`）@ `a96e1d3` |
| 前置 | [未完成-Bot范式-01-可行性评估-v1.md](未完成-Bot范式-01-可行性评估-v1.md)、[未完成-Bot范式-02-产品形态-v1.md](未完成-Bot范式-02-产品形态-v1.md) |
| 本文回答 | **具体怎么改代码**：改哪一层、加什么表、挂在哪个服务上、按什么顺序发 PR |
| 前提 | 在 Reactor 自己的运行时里做，**V1 不引入 OMB 运行时**（OMB 只作为可选 provider，见 §4.4） |

---

## 〇、三条不变量（先钉死，防止改造跑偏）

1. **不新建 App、不嵌外部页面。** 会话主视图、消息组件、diff/终端/浏览器面板全部复用。
2. **不动专家定义与市场。** `ServerAgentDefinition`（`packages/shared/src/server-agents-types.ts`）、「专家·技能」市场、召唤流程一行不改；`expertName` 是天然的 join key。
3. **不新增第二套会话模型。** 同事的线程就是普通 task/session，只是多一个 `agentInstanceId` 归属。

> 一句话：**给会话加一个"发起方"，给专家加一个"实例"，给服务加一个"团队频道"**。其余全是复用。

---

## 一、目标架构（最小改动版）

```
                      ┌──────────────────── 现状（不改）────────────────────┐
  专家市场/企业下发 ──▶ ServerAgentDefinition（persona/model/skills/policy）──┐
                      └──────────────────────────────────────────────────────┘│
                                                                              │ expertName
  ┌──────────────────── 新增：实例层（本次改造的核心）────────────────────┐    │
  │ AgentInstance{ expertName, workspacePath/Identity, status,            │◀───┘
  │               memoryScopeKey, scheduleRefs }                          │
  │  表：agent_instances（tasks DB，同一个 sqlite）                        │
  └───────────────┬───────────────────────────────┬──────────────────────┘
                  │ 后台派发                       │ 状态/事件
                  ▼                               ▼
   createTask({ ..., agentInstanceId,        IAgentTeamService（新 RPC 频道）
     deferPersistenceUntilFirstPrompt })      ├─ onInstanceChanged（在场）
        ↑ 复用 automation 的"无界面派发"路径    └─ onInboxChanged（收件箱）
                  │                               │
                  ▼                               ▼
        普通 session + turn（复用现有 agent 运行时、diff、审批）
                                                  │
                                     ┌────────────┴─────────────┐
                                     │ UI：同事条 / 收件箱 / 线程 │
                                     └──────────────────────────┘
```

关键复用点（这三处决定了工程量）：

- **后台开工不用新写执行器**：`IZCodeTaskService.createTask` 已经支持"无界面派发"——`deferPersistenceUntilFirstPrompt`（注释原文："无界面派发会先创建空 session，再立即发送首条 V4 输入"），automation / off-peak 这类非用户触发的线程走的正是这条带 `automationId` / `offPeakTaskId` 的路径（具体是否复用 `deferred` 需在 P2 实测确认）。
- **服务接入是机械操作**：`ServiceCollection.register(...)` + `createServiceDescriptor(ServiceChannels.X)`，`packages/services/src/broadcast/broadcast.ts` 就是最短范本。
- **状态与审批事件已经有了**：turn 开始/结束、`elicitation_request` 都在 `zcodeTaskServiceAdapter` 里产生，团队服务只需在旁边**旁路订阅**，不改主链路。

---

## 二、五个改造点（按层）

### 2.1 契约层：`packages/shared`

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/channels.ts:80` | `ServiceChannels` 增加 `AgentTeam: "agent-team"` |
| `packages/shared/src/agent-team-types.ts`（新） | `AgentInstance` / `InboxItem` / `TeamEvent` 类型（客户端与服务端共用的唯一 shape） |
| `packages/shared/src/zcode-task-types-core.ts` | `ZCodeTaskMeta` 增加 `agentInstanceId?: string`（与 `cronAutomationId` 同一层语义，供列表/分组/徽标用） |

```ts
// 示意（非最终代码）
export interface AgentInstance {
  id: string;
  /** 专家 slug —— 与 SessionMeta.agentName 同源 */
  expertName: string;
  /** 绑定的工作区：没有绑定就不允许后台开工（否则产出无法审查） */
  workspacePath: string;
  workspaceIdentity?: string;
  status: "idle" | "working" | "needs_approval" | "failed";
  /** 人级记忆的命名空间，默认 = id */
  memoryScopeKey: string;
  /** 关联的 automation（值守） */
  scheduleRefs: readonly string[];
  createdAt: string;
  lastActiveAt: string;
}

export type InboxItemKind = "approval" | "result" | "failure";
export interface InboxItem {
  id: string;
  kind: InboxItemKind;
  agentInstanceId: string;
  taskId: string;
  /** 仅 approval：回传给 respondElicitation 的 id */
  requestId?: string;
  summary: string;
  createdAt: string;
  readAt?: string;
  resolvedAt?: string;
  /** 多工作区场景下决定"点进去在哪个上下文打开" */
  workspaceIdentity?: string;
}
```

### 2.2 数据层：`agent_instances` + `inbox_items`

- 位置：tasks DB 同一库（`packages/services/src/session/tasksDatabase/`），**不新建数据库**。
- 写法：沿用 `migrations.ts` 的两段式——列追加用 `["tasks", "agent_instance_id", "TEXT"]` 这种条目；建表按 `schema-v1.ts` 的 `CREATE TABLE` 步骤再补一条迁移（带幂等 `IF NOT EXISTS`）。
- 索引：`inbox_items(unread)`（`WHERE resolved_at IS NULL`）、`agent_instances(workspace_identity)`。

### 2.3 服务层：`IAgentTeamService`

```
packages/services/src/agent-team/
├── agentTeam.ts          # interface + createServiceDescriptor(ServiceChannels.AgentTeam)
└── agentTeamService.ts   # 实现
```

接口最小集（首版只做这些，别贪）：

```ts
export interface IAgentTeamService {
  listInstances(): Promise<readonly AgentInstance[]>;
  createInstance(input: { expertName: string; workspacePath: string; workspaceIdentity?: string }): Promise<AgentInstance>;
  removeInstance(id: string): Promise<void>;
  bindWorkspace(id: string, workspacePath: string, workspaceIdentity?: string): Promise<void>;

  listInbox(input?: { unreadOnly?: boolean }): Promise<readonly InboxItem[]>;
  resolveInbox(id: string): Promise<void>;

  /** 前台派活：给实例创建一个并行线程（parentThreadId 指向当前任务） */
  delegate(input: { instanceId: string; parentTaskId?: string; prompt: string }): Promise<{ taskId: string }>;

  onInstanceChanged: Event<AgentInstance>;
  onInboxChanged: Event<InboxItem>;
}
```

注册：`packages/services/src/node.ts:2575` 的链上加一行 `.register(IAgentTeamService, agentTeamService)`；`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` 同样的链（远程工作区）也要跟。

### 2.4 运行时层：让"同事"能开工

| 事项 | 做法 |
| --- | --- |
| 后台开工 | `createTask({ workspacePath, workspaceIdentity, modelSelection, agentInstanceId, deferPersistenceUntilFirstPrompt: true })`，随后 `sendPrompt` 发首条输入。**走的是与 automation 同类的"无界面派发"路径**，不新增执行器 |
| 专家身份 | 建会话时把实例的 `expertName` 落成 `SessionMeta.agentName`（已有字段，`server/packages/shared/src/session.ts:66` 的语义是"建会话时绑定的专家名"） |
| 状态机 | 订阅 turn 事件：开始 → `working`；`elicitation_request` → `needs_approval`；turn 结束/失败 → `idle` / `failed`；同时写 `inbox_items` |
| 并发保护 | 同一 `workspacePath` 的前台/后台写冲突：复用 `enqueueTaskCommand` 的队列 + 实例级串行锁（一个同事同一时刻只跑一个 turn） |
| 审批回传 | 收件箱里的 approval 直接调现有 `respondElicitation({ taskId, requestId, ... })`，不新造审批通道 |

### 2.5 UI 层：三个小组件，不新增主视图

| 组件 | 位置 | 说明 |
| --- | --- | --- |
| `AgentTeamStrip` | `@zcode/ui` app-shell 顶部/侧栏上方 | 头像 + 状态点 + 待批角标；点击切到该实例的线程 |
| `AgentInboxPanel` | 全局抽屉/角标 | 列表 + 一键跳转 + 审批内联操作 |
| `AgentInstancePage` | 复用 message/diff 组件 | 线程视图 = 现有会话视图 + 顶部身份条 |

- 数据入口：`useAgentTeam()`（照 `packages/ui/src/hooks/useServices.tsx` 的既有模式消费 `IAgentTeamService`）。
- 主视图枚举 `WorkspaceMainView`（`packages/ui/src/app-shell/types.ts:125`）**不建议**为此加 `"team"`——同事不是"页面"，是"在场"。真要加，也只是把「我的专家」列表升一级，而不是新页面。
- 「我的专家」→「我的团队」：在现有专家列表上多一列"在岗状态"，不新建列表。

---

## 三、四个 PR 的顺序与验收

| PR | 内容 | 工期 | 验收（可演示） | 风险 |
| --- | --- | --- | --- | --- |
| **P1** | 契约 + 两张表 + 服务骨架 + 只读团队列表 | 3–5 天 | 能把已安装专家"入职"成实例，侧栏看到列表与状态（还不会干活） | 迁移写坏 → 先在临时 data dir 跑 |
| **P2** | 后台开工 + 状态机 + 线程视图 | 1–2 周 | 点"让审查员跑一遍"→ 真的起 turn → 状态变工作中 → 完成后线程出现且 **diff 可审** | 与前台抢工作区；模型配额打爆 |
| **P3** | 审批收件箱（跨会话事件） | ~1 周 | 你在别的任务里也能看到角标 → 点进去批准 → 后台继续 | 多工作区跳转上下文错乱 |
| **P4** | @委托 / 值守 / 两层记忆 | 1–2 周 | `@审查员 顺手把这个也看了` → 结果带 diff 回到当前任务；给同事设"每天 9 点"→ 早上收件箱有结果；第二次能引用上次结论 | composer 语义改动；记忆污染 |

**P2 是分水岭**：P2 不过，P3/P4 都没有意义（没有后台线程就没有收件箱）。所以资源要压在 P2。

---

## 四、四个必须先拍板的设计决策（附建议）

### 4.1 会话归属：加字段 vs 新建类型

- **建议：`tasks.meta` 加 `agentInstanceId`**（可空）。老会话不填 = 一切照旧，列表/分组/统计全部复用。
- 不建"同事会话"新类型：那会分裂出两套列表、两套搜索、两套导出。

### 4.2 记忆归属：项目 / 人 / 双层

- 现状：项目记忆在 `cli/memories/projects/<workspaceId>/MEMORY.md`（`packages/services/src/memory/memoryService.ts`），**所有 agent 共享**。
- **建议双层**：项目记忆不动；新增 `cli/memories/agents/<agentName>/MEMORY.md`，注入 prompt 时"项目记忆 + 该同事的人级记忆"合并。
- 首版**只读展示、不自动写入**（自动写入容易把错误结论固化，等 P4 再评估）。

### 4.3 审批：新表 vs 复用事件

- **建议：新表 `inbox_items` + 现有 `respondElicitation` 回传**。理由：事件不能持久化，而"你不在场的审批"必须能跨重启存活。

### 4.4 要不要引入 OMB

- **V1 不引入。** 双运行时 = 双凭据 + 双权限 + 两套会话，前面文档已经论证过。
- 但把 `IAgentTeamService` 设计成**两层 provider**：`builtin`（Reactor 运行时，P2 落地）与 `external`（OMB 的 MCP/Bot API，路线 A）。这样"外部同事"以后可以只作为 `delegate()` 的另一种实现接进来，UI 完全不用改。
- 这条是整套方案最值钱的设计：**团队服务是抽象，OMB 只是其中一种 provider。**

---

## 五、兼容、风险、指标

**兼容**
- 老会话 / 老专家 / 老市场：零感知（新字段可空、新服务只增不改）。
- 单文件 400 行上限（`architecture-policy.yaml`）：`zcodeTaskService.ts` 已 741 行（历史超限），**新逻辑一律放新文件**，不要再往里堆。

**风险**
- 后台线程与前台抢同一 workspace → 实例级串行 + 工作区锁；参考 `enqueueTaskCommand` 队列语义。
- 模型配额/费用 → 每实例并发上限、单日 turn 上限（可借鉴 off-peak 的背压思路）。
- 长任务/断线恢复 → 复用 automation 的 run 记账（`automation_runs`），别自己造一套。
- Windows：路径大小写与长路径（`projectKey` 已有归一化），实例绑定要存归一化后的 key。

**指标（判断改造是否成立）**
- 后台线程产出"带 diff 可审查"比例 > 80%
- 审批从产生到响应中位时延（分钟级）
- 用户从任务线程发起 delegate 的次数（上升）
- 无孤儿 node 进程 / 无跨工作区串扰事故

---

## 六、第一个 PR（P1）的具体文件清单

```
新增
  packages/shared/src/agent-team-types.ts
  packages/services/src/agent-team/agentTeam.ts
  packages/services/src/agent-team/agentTeamService.ts
  packages/ui/src/hooks/useAgentTeam.tsx
  packages/ui/src/agent-team/AgentTeamStrip.tsx        （P1 可只读）
  packages/services/test/agentTeam.test.ts

修改
  packages/shared/src/channels.ts                       （+ ServiceChannels.AgentTeam）
  packages/shared/src/zcode-task-types-core.ts          （+ agentInstanceId）
  packages/services/src/session/tasksDatabase/migrations.ts
  packages/services/src/session/tasksDatabase/schema-v1.ts（建表范本，按需新增步骤）
  packages/services/src/node.ts:2575                    （+ register）
  packages/desktop/src/host/remoteWorkspaceServiceCollection.ts（远程工作区同步注册）
  packages/services/src/index.ts                        （+ export）
```

**P1 的验收命令**：`pnpm typecheck` + 新服务单测 + 在临时 `ZCODE_DATA_BASE_DIR` 下跑一次迁移（幂等：跑两次不炸）。

---

## 七、未验证事项

- `createTask` 的 `deferPersistenceUntilFirstPrompt` 在 P2 的"无人值守"场景下是否需要额外心跳/看门狗（本蓝图按 automation 的既有行为推断，未实测长跑）。
- 跨工作区审批跳转需要 `workspaceIdentity` 与 UI 的 workspace 切换协议配合（`WorkspaceShellLayoutProps` 一带有 `workspaceIdentity` 字段，但切换动作的收口点未逐行确认）。
- 人级记忆的文件格式与注入点（是否复用 CLI 的 `MEMORY.md` 约定）需与 agent 运行时负责人确认。
