# 服务端接线 P3 — Agent 下发（开工计划）

> **状态**：开工计划（实现前的契约与边界，动手时不偏离本文件）　**日期**：2026-09-22
> **上游**：[服务端接线-方案-v1.md](服务端接线-方案-v1.md) §4.4（**决策正本**，2026-09-22 修订版）/ §5 P3 / §6 U4（已解决）
> **服务端契约**：`server/packages/server/src/agents/routes.ts` + `server/packages/shared/src/agents.ts`（已实现且有冒烟 `server/packages/server/scripts/agents-smoke.mjs`，**本阶段零改动**）
> **前置**：P2 技能下发（`skills[]` 直通后本机才有可注入的技能）；P1 企业登录与 `reactor:providerId`（模型映射依赖）
> **原则**：不照搬 Reactor-Desktop 的 `agents.json` 全量缓存 + `new_session` 注入；复用主仓 subagent markdown 运行时，只新增 server 目录与来源，与 P2 同步器纪律同构。

---

## 0. 一句话目标

企业登录后：**服务端「已安装且启用」的专家物化为 server scope 的 subagent markdown**，在设置页「企业专家」分组与 @/Task 选择器可用，persona / 模型 / 技能白名单按 §4.4 映射生效；卸载与登出可回收，用户自建 agent 字节不变。

---

## 1. 已拍板决策（不再讨论）

| #   | 决策                                                                                                   | 理由 / 出处                                                                       |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| D1  | v1「数字人」= Task / @mention 可调用的子代理（B 语义）；「以此专家开会话」薄封装**后置**               | §4.4 产品语义；不为 A 语义再开一条会话预设状态机                                  |
| D2  | 一 agent 一 markdown，落 `{数据根}/server-agents/`；不搬 `agents.json` 单文件缓存当运行时真相          | 可 diff、可增量、可整体回收（R5）                                                 |
| D3  | 写操作成功后 **re-GET 全量再 reconcile**，不本地推算 `installed`/`hot`/`favorited` 等聚合字段          | 旧项目同步纪律（agents-sync 的教训）                                              |
| D4  | `skills[]` **直通** frontmatter `skills`（subagent 运行时已支持）                                      | §4.4 修订；`subagentMarkdown.ts:72/117`；未安装技能由 P2 缺口承接，见 §7 U-P3-4   |
| D5  | **不落本地第二套启用位**：启停 = 服务端 install 关系；端侧只控制「是否物化」                           | 避免与 `agents-state.json` 双写；该文件的 `disabledAgentIds` 只属于用户自建 agent |
| D6  | `title`/`emoji`/`tags`/`official` 等市场字段**不进 markdown**，用同步器内存投影做徽标                  | §4.4 映射表；缺失时降级只显 name，不阻塞同步                                      |
| D7  | server 文件**只读**：无编辑/删除入口；卸载只走服务端 API（`DELETE .../install`）                       | R5（可区分、不可误删）；仿 plugin 的只读语义                                      |
| D8  | 同步器为独立服务、挂 `IReactorServerService` 登录/登出生命周期（与 P2 `IServerSkillSyncService` 同构） | 状态所有者单一；令牌只在 Host                                                     |

---

## 2. 目标与非目标

### 目标（P3 验收）

1. 登录 / 启动已登录 / 手动刷新 → 按 `installed && installEnabled` 增量物化到 `server-agents/`。
2. 列表中 `scope=server` 可区分（「企业专家」分组 + 徽标），只读；与用户同名可共存展示。
3. 设置页支持 **安装 / 启停 / 卸载 / 手动同步**（最小列表，不做完整市场页）。
4. 离线 / 服务端不可达时**绝不误删**本地文件。
5. 登出清空 `server-agents/`，再登录可恢复；用户自建 agent 全程字节不变。
6. GUI 与 CLI 同一根源不分叉，@/Task 可调用，persona / model / skills 映射生效。

### 非目标（明确不做）

| 项                                                                     | 原因                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------- |
| 完整专家市场页（taxonomy 筛选 / 收藏 / 热门排序 UI）                   | 服务端 API 已有，UI 加法后置（同 P2 catalog 后置）    |
| 「以此专家开会话」薄封装（A 语义出口：应用 model + persona 附注）      | §4.4 已预留语义；先验收 B，薄封装单独开片             |
| 会话 persona 注入（`new_session` / `appendSystemPromptOverride` 链路） | 明确不抄旧项目 sidecar                                |
| `POST /me/agents/:name/use` 使用量上报                                 | 属 P4 用量口径；可后置为 fire-and-forget              |
| 周期轮询 / 推送                                                        | 登录、mutation、手动触发即可（与 P2 一致）            |
| 改 `server/`                                                           | API 已实现且冒烟；本阶段零改动                        |
| `workspaceKey` 维度                                                    | agent 安装关系是账号级（routes.ts 无 workspace 参数） |

---

## 3. 状态所有者（一处状态一个写入者）

| 状态                                       | 唯一写者                                      | 落盘位置                                           | 备注                                                                            |
| ------------------------------------------ | --------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| 安装 / 启停 / 收藏 / use 关系              | 服务端（经 `/me/agents/*` API）               | 服务端 `agent_installs` 等                         | 唯一真相；本地不镜像、不推算聚合字段                                            |
| 服务端技能之外的 agent 文件树              | 新增 `IServerAgentSyncService`                | `{数据根}/server-agents/<name>.md`                 | 只动本目录；`{数据根}` = `{dataBaseDir}/{USER_DATA_DIR_NAME}`（见数据目录契约） |
| 同步元数据投影（title/emoji/official…）    | 同步器                                        | 内存短缓存                                         | 不进 markdown；重启后未同步前可缺失，UI 降级只显 name                           |
| 企业登录令牌 / 地址 / `reactor:providerId` | 既有 `IReactorServerService`                  | 凭据库 + provider overlay                          | **不改所有权**；同步器只读取                                                    |
| 用户 / 工作区 agent 与 `agents-state.json` | 既有 `subagentsService`（GUI）、CLI bootstrap | `agents/`、`.zcode/agents`、`v2/agents-state.json` | 只读不碰；`disabledAgentIds` 只对 user scope 生效                               |
| 设置页 UI 局部状态                         | `SubagentsSection` / store                    | —                                                  | 只发命令给同步器与 `subagentsService`，不直写文件                               |

**禁止**：UI 直写 `server-agents`；同步器写 `agents/` 或 `.zcode/agents/`；为 server agent 新增第二份 enabled 状态文件或内存真相。

---

## 4. 架构与映射

### 4.1 接线

```
Renderer(设置) / CLI                Host (packages/services)                    server/ (identity :8791)
────────────────────                ────────────────────────                    ──────────────────────
SubagentsSection ──── 命令 ────────► IServerAgentSyncService
                                      │ 取 accessToken（IReactorServerService）
                                      │ GET /me/agents  ────────────────────────► 目录 + 我的安装关系
                                      │ POST|DELETE|PATCH .../install  ─────────► 安装/卸载/启停
                                      │ reconcile：增/改/删只动 server-agents/
                                      ▼
                            {数据根}/server-agents/*.md
                                      ▲                         ▲
                subagentsService.discoverFileAgents     CLI bootstrap roots
                （scope=server、只读、企业分组）        （source=server）
                                      ▼                         ▼
                          设置「企业专家」分组          Task / @mention 运行时 profile
```

- **One owner**：磁盘文件只有同步器写；安装关系只有服务端写。
- **One path**：发现复用 `discoverFileAgents` / CLI `bootstrap` roots，不另建加载器。
- **跨模块边**：services → shared 契约类型；UI → `ISubagentsService` + 新 `IServerAgentSyncService`；CLI bootstrap → shared。

### 4.2 字段映射（决策正本 §4.4；本表 = 精确落点与代码接缝）

服务端 payload 形状以 `toAgentPayload`（`server/packages/server/src/agents/repo.ts:814`）为准：
`id/name/title/description/emoji/persona/provider/modelId/skills/tags/category/official/author/publishedAt/enabled/hot/uses/installed/installEnabled/favorited/sessionType/policyMode/thinkingLevel/starters`。
客户端**在 `packages/shared` 新增 server-agents 契约类型 + normalize**（不在 services 里手写 shape；normalize 丢弃非法 `name`、容旧响应字段缺失）。

| 服务端字段                                                                     | 客户端落点                                                           | 处理与接缝                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` / `description`                                                         | frontmatter 同名                                                     | 服务端已限制小写字母/数字/连字符（`routes.ts:147`），文件名安全；GUI 的用户 CRUD 名称校验**不作用于发现**                                                                                                                                                                             |
| `persona`                                                                      | 正文 = `systemPrompt`                                                | 直通；服务端已限 ≤8000 字                                                                                                                                                                                                                                                             |
| `modelId` + `provider`                                                         | frontmatter `model`                                                  | `formatSubagentMarkdownModel({providerId: reactor:providerId, modelId})` → `providerId/modelId`（`packages/shared/src/subagent-markdown-selection.ts:35-41`）；**服务端 `provider` 是网关逻辑名，禁止字面写入**；`reactor:providerId` 缺席 → **不写 `model`**（跟随主会话）并记 debug |
| `thinkingLevel`                                                                | `modelSelection.options.reasoningLevel` → frontmatter `thoughtLevel` | 仅在 `modelSelection` 存在时被序列化（`subagentMarkdown.ts:111-114`）；无 model 时丢弃并记 debug（§7 U-P3-7）                                                                                                                                                                         |
| `policyMode`                                                                   | frontmatter `permissionMode`（仅 `auto` \| `plan`）                  | **降级映射**：`readonly`/`strict` → `plan`，`balanced`/`trust` → `auto`；不可逆。注意 subagent 词表只有两档（`subagents-types.ts:29`），与 P4 会话四档词表是两回事                                                                                                                    |
| `skills[]`                                                                     | frontmatter `skills`                                                 | **直通**（parse `subagentMarkdown.ts:72` / serialize `:117`）；未安装技能运行时自然不注入（依赖 P2，§7 U-P3-4）                                                                                                                                                                       |
| `installed && installEnabled`                                                  | 是否物化 + 发现过滤                                                  | 目标集唯一判据；停用 = 删本地文件（不进 `disabledAgentIds`，D5）                                                                                                                                                                                                                      |
| `title`/`emoji`/`tags`/`category`/`official`/`author`/`favorited`/`hot`/`uses` | 不进 frontmatter                                                     | 同步器内存投影供设置页徽标（`official` 兼作「来源=企业」标记）；重启未同步前降级只显 name                                                                                                                                                                                             |
| `sessionType` / `policyMode` 预设 / `starters`                                 | 不进 markdown                                                        | A 语义字段，「以此专家开会话」薄封装后置（§2 非目标）                                                                                                                                                                                                                                 |
| `enabled` / `publishedAt`（定义级）                                            | 是否出现在 `GET /me/agents`                                          | 服务端 SQL 已过滤；客户端拿到即可见，不再二次判断可见性                                                                                                                                                                                                                               |

### 4.3 同步语义（摘要；与 §4.4 逐条一致）

1. **触发**：登录成功 / 启动已登录 / 手动刷新 / 安装·启停 mutation 成功后（re-GET 再 reconcile）；登出 = 清空。
2. **目标集** = `GET /me/agents`（全量、无分页）中 `installed && installEnabled` 的条目。
3. **reconcile**：内容不等则写（整文件字节比对），不在目标集则删；增/改/删**只动 `server-agents/`**。
4. **失败语义**：未登录 / HTTP 失败 / 服务端不可达 → **不删除任何本地文件**，保留上次结果（与 P2 R9 同）。
5. **不本地推算**：`hot`/`favorited`/安装数等聚合字段永远以服务端响应为准（D3）。
6. **登出**：整个 `server-agents/` 目录清空（与 P1「登出清模型清单、保留 provider 条目」同构）；再登录由触发器 1 恢复。

### 4.4 发现层与 precedence

**GUI（`packages/services/src/subagents/`）**

- `AgentScope`（`packages/shared/src/subagents-types.ts:4`）与 `AgentSource`（`:6`）各增 `"server"`。
- `discoverFileAgents`（`subagentsService.ts:197-249`）roots 追加 `{scope: "server", rootPath: {数据根}/server-agents}`（user、workspace 之后）。
- runtime 数组顺序（`:613-621`）为 `built-in → user → workspace → server → plugin`；`applyRuntimePrecedence`（`:292-298`）按 name **后写覆盖**，因此实际解析优先级为 `plugin > server > workspace > user > built-in`——server 遮蔽同名 user/workspace，被 plugin 遮蔽。同名行为是 §7 U-P3-1 的验收点。
- **`settingsUserOnly` 分支（`:614-616`）必须同时加入 server**：该分支目前只有 built-in + user，不加则设置页「用户」tab 看不到企业专家；决定为 server 在两个分支都出现（企业专家不随 tab 消失）。
- **parse 耦合护栏**：`parseSubagentMarkdown` 的 `source = scope === "built-in" ? … : "user"`（`subagentMarkdown.ts:65`）、`readOnly` 只认 built-in（`:100`）——scope=server 会被误标成可写的 user。处置：discovery 阶段显式覆盖 `source: "server"`、`readOnly: true`（仿 plugin 的做法，`subagentsService.ts:343`），或扩解析函数签名；验收见 §6-10。
- `attachEnabledState`（`:284-290`）对非 user scope 恒 `enabled: true` → server 启停由**物化与否**承载，与 D5「不落第二启用位」一致。
- plugin 裸名别名的 `reservedNames`（`:606-610`）需**并入 server 名称**，否则 plugin agent 可能抢注与企业专家同名的裸名别名。
- 设置页分组 `groupAgentsByScope`（`SubagentsSection.tsx:375`）增 `server → 「企业专家」`；不加会落入兜底分支被显示进「内置」组（`subagentMarkdown.ts:97-99` 注释记录过同类事故）。

**CLI（`apps/zcode-cli`）**

- `bootstrap/src/subagents.ts:54-57` roots 追加第三根 `{path: join(storageRoot, "server-agents"), source: "server"}`。
- `AgentProfileSource`（`core/src/subagent/profile.ts:18`，当前 `built-in | project | user`）增 `"server"`：`isDisabledUserProfile`（bootstrap `:304-318`）只过滤 `user`，天然不命中；`profile.ts:185` 只对 `project` 剥离 `permissionMode` → server 保留 `auto`/`plan`（正确语义）。
- CLI 无 GUI 的按名去重：同名时 CLI 会全部加载，Task 解析结果可能与 GUI precedence 不一致 → 归入 §7 U-P3-5，验收同名场景。

---

## 5. 实施步骤（每步可验收）

| #   | 步骤                                                                                                                                                                   | 产出                                             | 验收                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| 1   | 本计划落档                                                                                                                                                             | 本文件 + `docs/README.md` 索引 + 方案 §5/§6 修订 | 文档评审                                                     |
| 2   | shared 契约：`AgentScope`/`AgentSource` 增 `"server"`；新增 `packages/shared/src/server-agents-types.ts`（下发面类型 + normalize）                                     | shared                                           | `pnpm typecheck`；normalize 丢非法 name、容旧响应缺字段      |
| 3   | client HTTP 面：`reactorServerClient` 增 `listAgents` / `installAgent` / `uninstallAgent` / `setAgentInstallEnabled`（Bearer access，错误走 `ReactorServerHttpError`） | services                                         | 桩服务端断言（仿 P1 `.tmp/verify-p1-service.ts` 方式）       |
| 4   | 同步器：`packages/services/src/server-agents/` 实现 `IServerAgentSyncService`（reconcile / 登出清空 / 元数据投影），挂登录·登出钩子                                    | services + 频道注册                              | 服务层断言：目标集过滤、增改删只动本目录、离线不删、登出清空 |
| 5   | 发现层：GUI roots + 分组 + 只读覆盖 + `settingsUserOnly` 分支 + `reservedNames`；CLI roots + `AgentProfileSource`                                                      | services / shared / zcode-cli                    | 「企业专家」出现；CLI 与 GUI 数量一致；无编辑删除入口        |
| 6   | 护栏：`deleteAgent` / `updateAgent` 拒绝 server 路径（scope 校验）；UI 对 server 隐藏删除、改由「卸载」走 API                                                          | services / ui                                    | 误删不可能（代码路径断言 + §6-10）                           |
| 7   | 设置 UI：「企业专家」分组 + 徽标（内存投影）+ 安装 / 启停 / 卸载 / 手动同步；未登录不渲染                                                                              | ui                                               | 真机走查（沿 P1 独立数据目录 + CDP 方式）                    |
| 8   | 登录挂钩：登录成功后台同步（**失败不阻断登录**）；启动已登录补一次；登出清空                                                                                           | services                                         | 真机：登录→列表出现；登出→清空；重登→恢复                    |
| 9   | 回归：`pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` / CLI typecheck + §6 行为清单                                                               | —                                                | 见 §9                                                        |

---

## 6. 验收场景

1. 登录 → 自动同步 → 设置出现「企业专家」分组与「企业」徽标；未登录则完全没有。
2. 安装并启用一个专家 → `server-agents/<name>.md` 落盘，frontmatter 的 `name`/`description`/`model`/`skills` 与正文 persona 与 §4.4 映射一致。
3. 用它发起 Task / @mention → 子代理以该 persona 运行；模型请求带 P1 运行期鉴权（Host 日志「企业服务端模型请求鉴权已注入」）；白名单技能在 P2 已装时被注入。
4. 启停（关）→ 本地文件删除、列表与 @/Task 立即消失；再启用 → 恢复物化。
5. 卸载 → `DELETE .../install` 成功 + 本地文件删除；再次手动同步**不会**回灌（服务端关系已删）。
6. 管理端下架 / 收回授权 → `GET /me/agents` 不再包含 → reconcile 删除文件（agent 无「留文件不注入」态，见 §7 U-P3-8）。
7. 断网 / 服务端 5xx → 同步报错但本地文件完整保留。
8. 登出 → `server-agents/` 清空；用户 `agents/` 与 `.zcode/agents/` 字节不变；再登录 → 恢复到与服务端一致。
9. 用户与服务端同名专家并存 → 设置页两组各显示并标来源；@裸名解析结果符合 §4.4 precedence 并记录在案。
10. 用户对 server agent 点「删除」→ 无入口；直接调用 `deleteAgent`/`updateAgent` 传 server 路径 → 被 scope 校验拒绝。
11. CLI 与 GUI 列出的 server agent 数量一致（同一数据根双根加载不分叉）。

---

## 7. 风险与未决

| #      | 项                                                                                                                                                                                     | 影响 / 处置                                                                                                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-P3-1 | **同名 precedence**：`applyRuntimePrecedence` 后写覆盖（`subagentsService.ts:292-298`），server 插入位置决定同名胜负；设置页展示与 runtime 解析可能不同步                              | 高。按 §4.4 定 `server` 在数组中位于 workspace 之后、plugin 之前 → 裸名解析 server 胜 user/workspace；验收 §6-9 固化「设置页两组都显示、@裸名解析按 precedence」。若产品要求 user 永不被遮蔽，再改插位并回归                                                                |
| U-P3-2 | **企业 providerId 时序**：frontmatter `model` 里的 providerId 来自 P1 登录期写入的 `reactor:providerId`；provider 被用户删掉（§6 U7）或同步早于登录完成时，model 指向不存在的 provider | 中。同步必须排在登录成功、`reconcileProviderModels` 之后；`reactor:providerId` 缺席 → **不写 `model`**（跟随主会话）；provider 被删时靠下一次同步自愈，模型请求仍只打企业网关不会外泄。**格式本身已解决**（原 U4）：`formatSubagentMarkdownModel` 原生 `providerId/modelId` |
| U-P3-3 | **登出清空与恢复**：清空目录期间运行中的 Task 已加载 profile；清空/恢复若中断留下半套文件                                                                                              | 中。清空只动 `server-agents/`；运行中会话不重载既有 profile（行为记录在案，不作为崩溃点）；reconcile 以「目标集全量 vs 现存文件」增量收敛，中断后重跑自愈（幂等）。验收 §6-8                                                                                                |
| U-P3-4 | **P2 前置依赖**：`skills[]` 直通但本机无对应技能落盘 → 白名单空转                                                                                                                      | 中。顺序 P2 → P3；若 P2 未完成先行 P3，设置页对企业专家的 skills 显示「依赖技能下发」提示，运行时按缺技能自然降级                                                                                                                                                           |
| U-P3-5 | **CLI `AgentProfileSource` 枚举**：只扩 GUI 不扩 CLI，或 CLI 同名全部加载不去重 → GUI/Task 解析分叉                                                                                    | 中。步骤 5 同步扩枚举 + 根；验收 §6-11；同名场景对照 GUI precedence 给出结论（必要时 CLI 侧按根序保留后者）                                                                                                                                                                 |
| U-P3-6 | **parse 层 scope/source 耦合**：不改则 server 文件被标成 `source=user`、`readOnly=false`，进入用户 CRUD/删除路径                                                                       | 高（**护栏项**）。必须走 §4.4 发现层覆盖（仿 plugin `subagentsService.ts:343`）；验收 §6-10 是发布门槛，不可用「UI 上碰巧没入口」替代                                                                                                                                       |
| U-P3-7 | **thinkingLevel 序列化依赖 `modelSelection`**（`subagentMarkdown.ts:111-114`）：无 model 时思考档位写不进去                                                                            | 低。v1 丢弃并记 debug，方案 §4.4 记录在案；不为此手写第二条 frontmatter 写路径                                                                                                                                                                                              |
| U-P3-8 | **软下架语义与 P2 相反**：技能软下架留文件不注入；agent 只要不在 `GET /me/agents` 就会被 reconcile 删文件                                                                              | 低（有意边界）。agent 的发现即可见，没有「留文件不注入」的中间态；下架 = 回收，符合 R5。写进实现注释，不当 bug 修                                                                                                                                                           |

---

## 8. 明确不抄 / 明确复用

**不抄 Reactor-Desktop**

| 项                                                                      | 原因                                      |
| ----------------------------------------------------------------------- | ----------------------------------------- |
| `agents.json` 单文件全量缓存当运行时真相                                | 与主仓 subagent markdown 运行时重复造轮子 |
| `new_session` + sidecar `appendSystemPromptOverride` / `skillsOverride` | 会话数字人链路；v1 语义是 B（D1）         |
| Electron main 扛 fs / IPC                                               | 主仓走 services + Host，平台无关          |
| 本地推算 `installed`/`hot` 聚合字段                                     | D3；服务端关系是唯一真相                  |
| 把 title/emoji/tags 塞进 markdown body 或 frontmatter                   | 无对应 frontmatter 字段；污染 diff        |

**复用（主仓既有能力）**

| 项                                              | 位置                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| subagent markdown 解析/序列化                   | `packages/services/src/subagents/subagentMarkdown.ts`                     |
| `providerId/modelId` 编解码                     | `packages/shared/src/subagent-markdown-selection.ts`                      |
| 发现、分组、enabled、precedence                 | `packages/services/src/subagents/subagentsService.ts`                     |
| 登录令牌 / 地址 / `reactor:providerId`          | `IReactorServerService`（`reactorServer.ts` / `reactorServerService.ts`） |
| HTTP 客户端 / 错误体                            | `reactorServerClient.ts` + `ApiClient` + `ReactorServerHttpError`         |
| 用户数据根                                      | `USER_DATA_DIR_NAME`（数据目录契约）                                      |
| 同步纪律（写后 re-GET、离线不删、sha/字节比对） | P2 `IServerSkillSyncService` 的契约与实现方式                             |
| 服务端冒烟                                      | `server/packages/server/scripts/agents-smoke.mjs`（只引用，零改动）       |

---

## 9. 验证命令

```bash
# 主仓（契约 / 同步器 / 发现层 / UI）
pnpm typecheck
pnpm lint
pnpm architecture:check --changed

# 若触及 CLI（bootstrap roots / profile source）
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint

# 服务端（本阶段零改动；仅确认冒烟基线仍绿）
cd server && node packages/server/scripts/agents-smoke.mjs   # 路径与参数以 server/README 为准
```

真机验收沿用 P1：独立 `ZCODE_DATA_BASE_DIR` + 真实服务端 + CDP 脚本，截图/日志留档。

---

## 10. 与既有文档的关系

| 文档                                                                 | 关系                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [服务端接线-方案-v1.md](服务端接线-方案-v1.md)                       | 产品规则与 §4.4 决策正本；本文件是 P3 的**唯一实现计划**，冲突以本文件为准并回写 |
| [server-skill-delivery-plan.md](server-skill-delivery-plan.md)       | P2 前置；同步器纪律、步骤表与验收结构同构                                        |
| [server-skill-sync.md](server-skill-sync.md)                         | 技能同步契约；「失败不删本地」「只动自己目录」的语义直接沿用                     |
| [data-directory-contract.md](data-directory-contract.md)             | `server-agents` 路径必须走 `USER_DATA_DIR_NAME`，用户级、工作区级永不含该目录    |
| [model-governance-and-dev-mode.md](model-governance-and-dev-mode.md) | policyMode 映射与模型可见性的产品口径；本文件不改它                              |
| [../server/README.md](../server/README.md)                           | 服务端 `/me/agents` API 与冒烟命令                                               |
