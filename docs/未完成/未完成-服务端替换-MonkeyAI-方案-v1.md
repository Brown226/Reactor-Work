# 服务端替换为 MonkeyAI —— 方案 v1

> **状态**：方案已定，未开工（2026-11-27）。源码基线已导入 `Server-V2/`，`backend`/`web`/`docs/design` 与上游逐字节一致。
> **范围**：用 `Server-V2/`（MonkeyAI Go 服务端 + 管理台）替换 `server/`（现 TS 企业服务端：identity `:8791` + gateway `:8790` + admin）。
> **不替换**：`packages/server`（桌面/远端本地 Host、stdio/HTTP RPC）、桌面端本地会话执行、手机远控 relay。
> **已拍板**：① 底座用 MonkeyAI，不用 MonkeyCode 的 taskflow/VM 任务面；② 桌面端直接改 MonkeyAI 原生 API，不做长期兼容层；③ 保留 AD，新增 Go LDAP 模块。
> **依据**：以 `Server-V2/` 当前源码、旧 `server/` 当前源码、`docs/未完成/未完成-服务端接线-方案-v1.md`、`docs/未完成/未完成-服务端接线-P4-用量上报与策略.md` 为准。

---

## 1. 结论先行

1. 你提供的 `MonkeyCode-main` 里有**两套服务端**：
   - `backend/`（MonkeyCode）：偏 AI 开发任务/云主机，依赖仓库外的闭源 `taskflow` 镜像（`backend/docker-compose.yml` 的 `${TASKFLOW_IMAGE}`）和空的 `agent` 子模块（`.gitmodules` 指向 OhMyAgent），还依赖 Redis + ClickHouse；只靠这份源码**无法自托管任务执行**。
   - `monkeyai/backend`（MonkeyAI，已复制到 `Server-V2/`）：自包含 Go 单体，覆盖用户/分组/模型/技能/规则/专家/MCP/知识库/会话/计费/审计/统计/反馈/远程执行中转/管理台，正好对应现有 `server/` 的企业管理面。
2. 因此选 **MonkeyAI**。它不是“功能更少的替代”，而是更完整的底座；但有三处硬缺口必须先补：**成员写入**、**AD/LDAP**、**桌面端契约**。
3. 旧 `server/` 有 25,776 行 TS 服务端代码、269 个管理台文件、48+ 张表；桌面端企业接线约 5,207 行 services + 3,555 行 UI。替换不是“删目录”，而是一次**服务端换底座 + 客户端换契约 + 数据迁移**的联合工程。
4. 推荐总工期：2–3 名工程师约 3–4 个月；单人显著更长。先做 P0 可行性门禁，再排后续。

---

## 2. 两套上游服务端的判定

| 维度 | MonkeyCode `backend/` | MonkeyAI `monkeyai/backend`（采用） |
| --- | --- | --- |
| 领域 | AI 开发任务、云主机、项目/仓库 | 企业 AI 管理：用户/分组/模型/资源/计费/审计/远程执行 |
| 运行依赖 | PostgreSQL + Redis + ClickHouse + **taskflow 闭源镜像** + 空 agent 子模块 | PostgreSQL(+pgvector) + S3；无 Redis/MQ |
| 任务执行 | 服务端 VM + taskflow，任务类型 develop/design/review | 不执行任务；会话事实归客户端，服务端做上报/统计 |
| 企业管理 | 团队/成员/分组，无完整计费/额度/审计 | 分组树、主管、资源授权、积分账户/额度/流水、审计、统计 |
| 可自托管性 | 仅凭源码不可 | 基本可（成员写入需补，见 §4） |
| 与 Reactor 的契合 | 低（我们没有 VM 任务面） | 高（我们已有企业登录/网关/技能/Agent/额度） |

**结论**：`backend/` 只作为参考，不进入 `Server-V2`。`Server-V2` 只含 `monkeyai` 的服务端与管理台。

---

## 3. 现状盘点（被替换的 `server/`）

### 3.1 进程与端口

| 进程 | 入口 | 端口 | 职责 |
| --- | --- | --- | --- |
| identity | `server/packages/server/src/identity-entry.ts` | 8791（管理面 8792） | LDAP/本地登录、JWT、组织/角色/权限、管理台 API、技能/Agent、知识库、MCP、审计/额度、更新、反馈、看板 |
| gateway | `server/packages/server/src/index.ts` | 8790 | 统一模型出口：`/v1/chat/completions`、`/v1/messages`、`/v1/embeddings`、`/v1/rerank`、`/v1/models`，供应商/密钥/模型管理 |
| admin | `server/packages/admin` | 由 identity 挂 `/console` | 24 个页面：运营总览、用户组织、角色权限、模型/供应商/密钥、用量、审计、同步日志、知识库、技能、技能包、Agent、标准、术语、界面模式、MCP、软件更新、反馈、个人中心等 |

### 3.2 数据与鉴权

- PostgreSQL；48+ 张表（users/departments/user_tokens/permissions/ai_providers/ai_models/secrets/skills/agents/kb_*/mcp_server/audit_event/usage_ledger/quota_*/app_release/feedback_*）。
- 鉴权：JWT HS256，audience `access/refresh/gateway`；网关只接受 `aud=gateway`。
- 组织：`departments` 树 + `users.department_id`；角色 `platform_admin/dept_head/user`；三级数据范围 `all/dept/self`。
- 密钥：`secrets.field_values` 以 AES-256-GCM 封存，主密钥 `REACTOR_SECRET_KEY`。

### 3.3 桌面端接线（会被重写的部分）

| 模块 | 位置 | 规模 |
| --- | --- | --- |
| 企业服务 | `packages/services/src/reactor-server/*` | 约 3.9k 行（含 1,340 行的 `reactorServerService.ts`、611 行 client） |
| 技能/Agent 同步 | `packages/services/src/server-skills/*`、`server-agents/*` | 约 1.1k 行 |
| UI | `EnterpriseLoginScreen`、`settings/account/*`、`marketplace/*`、`KnowledgeView` | 约 3.5k 行 |
| CLI 配合 | provider 哨兵值 + runtime header 注入 | 少量但关键 |

桌面端现用的企业接口（节选）：`/auth/login|refresh|logout|gateway-token`、`/me`、`/me/skills*`、`/me/agents*`、`/desktop/policy`、`/desktop/audit/batch`、`/desktop/quota/me`、`/desktop/usage/summary`、`/api/v1/releases/*`、`/api/v1/feedback/ticket`、`/v1/*`。

---

## 4. 目标架构

```text
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ Reactor Desktop / CLI       │        │ 管理台（Server-V2/web）      │
│  OAuth 2.1 + PKCE (loopback)│        │  Cookie Session              │
│  API Key (model:invoke)     │        │  /api/admin/v1/*             │
└──────────────┬──────────────┘        └──────────────┬───────────────┘
               │ HTTPS / WSS                           │ HTTPS
        ┌──────▼───────────────────────────────────────▼──────┐
        │ nginx（TLS、静态管理台、反代 /api、/oauth、/v1）      │
        └──────┬───────────────────────────────┬──────────────┘
               │                               │
     ┌─────────▼─────────┐           ┌─────────▼─────────┐
     │ control 进程       │           │ proxy 进程         │
     │ 身份/分组/资源/    │           │ 模型网关 /v1/*     │
     │ 会话/计费/审计/    │           │ 计费/用量记录      │
     │ 远程执行中转       │           │                    │
     └─────────┬─────────┘           └─────────┬─────────┘
               └───────────────┬───────────────┘
                       ┌───────▼────────┐   ┌──────────────┐
                       │ PostgreSQL 18  │   │ S3 (RustFS/  │
                       │ + pgvector     │   │ MinIO)       │
                       └────────────────┘   └──────────────┘
```

要点：

- 上游 `internal/app/app.go` 中 **control 角色不注册模型网关**，`proxy` 角色才注册（`execution.registerGateway`）。因此必须部署 **control + proxy 两个进程**，不能只起一个。
- 上游管理台是独立 SPA（`Server-V2/web`），由 nginx 托管；不是后端内嵌。
- AD/LDAP 作为 identity 的登录源加入 control 进程；AD 同步作为后台作业。
- Reactor 独有的更新下发、桌面策略、标准/术语、界面模式、同步日志作为 `extension.Module` 或独立小模块挂在 control。

### 4.1 状态所有权

| 状态 | 唯一所有者 | 存储 |
| --- | --- | --- |
| 用户 / 分组 / 角色 / 主管 | MonkeyAI control | PG `users` / `groups` / `group_users` |
| OAuth 授权 / token / API Key | MonkeyAI identity/apikey | PG `oauth_*` / `api_keys` |
| 模型 / 供应商配置 / 凭据 | MonkeyAI control（管理台写入） | PG `models`（加密方案待补，见 §7.3） |
| 技能 / 规则 / 专家 / MCP / KB | MonkeyAI control | PG + S3 |
| 模型调用事实 / 积分 / 额度 | MonkeyAI proxy + billing | PG `model_calls` / `credit_*` / `billing_*` |
| 会话摘要 / 轮次 | 客户端上报，MonkeyAI 只存索引 | PG `sessions` |
| 桌面策略缓存 | 桌面端（只读服务端） | 本地 `desktop-policy.json` |
| 客户端更新产物 | Reactor `updates` 扩展 | PG `app_release` + 本地卷 |
| 本地任务 / 会话正文 / 工作区 | 桌面端 CLI/Host（不变） | 本地 SQLite / 文件 |

**不再有第二条写路径**：旧 `server/` 的 `desktop/audit/batch` 模型用量上报被网关自己的 `model_calls` 取代；桌面端不再承担模型计量事实。

---

## 5. 能力映射与缺口

| 领域 | 旧 `server/` | MonkeyAI | 迁移动作 |
| --- | --- | --- | --- |
| 本地账号登录 | bcrypt（`source=local`） | PBKDF2-SHA256 | 迁移时兼容 bcrypt，登录成功后重哈希；或首次登录强制改密 |
| AD/LDAP | ldapjs bind + 组织同步 | **无** | 新增 Go LDAP 模块（登录 + 定时同步 + 日志） |
| 组织 | departments 树 + 三档角色 | groups 树 + admin/user + 主管 | 部门→分组；dept_head→组主管；platform_admin→admin |
| 权限 | 固定三角色矩阵 + 三级范围 | 资源授权 + 超级管理员/组主管 | 旧权限点需映射到资源授权；管理台菜单按角色收敛 |
| 模型网关 | chat/messages/embeddings/rerank/models | chat/responses/messages + 图片/视频；**无 embeddings/rerank 外网端点** | 保留 chat/messages；embeddings/rerank 若仍有调用方，需补适配或保留旧 gateway 过渡 |
| 供应商/密钥/模型 | ai_providers + secrets(AES-GCM) + ai_models | models（api_key 明文 + advanced_config + credit_multiplier） | 解密旧密钥→写入新模型；**必须先补加密**；pricing 映射到积分倍率 |
| 技能 | skills + skill_files + 安装/启停/收藏/市场 | skills + 包下载 + 资源授权 | 旧技能打包为 MonkeyAI skill 包；安装语义改为“授权即用” |
| Agent/专家 | agents（persona/model/skills/policy） | experts + expert_skills/rules/connectors | 字段映射；`policyMode` 需在客户端策略模块处理 |
| MCP | mcp_server + tool policy + relay 凭据 | connectors + credentials + tools + OAuth + 测试 | 旧登记迁移到 connectors；旧 relay 由客户端直连或新 relay 取代 |
| 知识库 | 自建 KB + WeKnora 远端 | 内置 KB（pgvector + AnyDoc + 权限 + 导入） | 二选一：用 MonkeyAI KB 并重嵌入，或保留 WeKnora；见 §10 |
| 会话/用量 | 客户端上报 model_call + usage_ledger | 网关直接写 model_calls + 积分流水 | 删除客户端模型用量上报；保留会话摘要上报 |
| 审计 | audit_event + 管理操作审计 | audits + 管理端 Middleware | 旧历史归档；新审计从切换日开始 |
| 额度 | quota_rule/quota_alert + 网关硬限流 | billing_quotas/credit_accounts/ledger | 规则映射到分组/用户额度；告警阈值进扩展设置 |
| 桌面策略 | `/desktop/policy`（命令黑名单/出网白名单/模式天花板） | **无直接对应** | 新增 `desktop-policy` 扩展模块（PG + 管理页） |
| 软件更新 | app_release + manifest + 下载页 | **无** | 移植 `updates` 模块为 Go 扩展，保留旧路径 |
| 反馈 | feedback_* + 公开提交面 | feedback 模块（不同 wire） | 客户端改 wire；或加兼容字段 |
| 标准/术语 | standards/terminology | **无** | 作为扩展模块移植（管理台补页） |
| 界面模式策略 | interface_mode_policy | rules/settings 可部分替代 | 扩展模块或并入 rules |
| 远程执行 | 无（旧 server 不管执行） | relay + endpoints + terminal/files | 可作为后续能力，不阻塞首期 |
| 管理台 | 24 页 | 36 页（更完整） | 以 `Server-V2/web` 为基线，补 Reactor 独有页面并换品牌 |
| 品牌/i18n | Reactor 品牌 | MonkeyAI 品牌 + 中英 | 管理台换品牌；对外文案统一 |

---

## 6. 客户端契约（直接改原生 API）

### 6.1 登录与令牌

```text
Desktop                    系统浏览器                     MonkeyAI control
   │ 打开 /oauth/authorize     │                              │
   │ client_id=monkeyai-desktop │                              │
   │ redirect=http://127.0.0.1:PORT/oauth/callback             │
   ├──────────────────────────►│ 登录页（AD/本地）             │
   │                           ├─────────────────────────────►│
   │                           │ 授权确认                     │
   │ ◄─────────────────────────┴──── redirect?code=... ───────┤
   │ POST /oauth/token (code + code_verifier)                  │
   ├──────────────────────────────────────────────────────────►│
   │ ◄──────────── access_token / refresh_token ───────────────┤
   │ POST /api/v1/api-keys {name, scopes:["model:invoke"]}     │
   ├──────────────────────────────────────────────────────────►│
   │ ◄──────────── API Key（只显示一次）───────────────────────┤
```

- 上游已允许 `monkeyai-desktop` 使用 `http://127.0.0.1:<port>/oauth/callback` 回环（`internal/identity/callback.go`），**无需新增 OAuth client**；品牌文案后续再改。
- access token 用于 `/api/v1/*`、`/api/auth/v1/profile`；API Key 只用于 `/v1/*` 模型网关。
- refresh：`POST /oauth/token` `grant_type=refresh_token`；失败即要求重新登录，禁止静默降级直连上游。
- API Key 默认 90 天；客户端在 401 时用 access token 轮换/新建，并把新 key 写入凭据库（不写配置文件）。
- 旧的 `/auth/gateway-token`、JWT audience 机制删除。

### 6.2 接口映射

| 旧接口 | 新接口 | 说明 |
| --- | --- | --- |
| `POST /auth/login`（账号密码） | OAuth authorize + token | 登录页支持 AD/本地；不再由桌面表单直接 POST 密码 |
| `POST /auth/refresh` | `POST /oauth/token`（refresh_token） | 轮换 refresh |
| `POST /auth/logout` | `POST /oauth/revoke` | 同时清本地 API Key/缓存 |
| `GET /me` | `GET /api/auth/v1/profile` | Bearer access |
| `POST /auth/gateway-token` | `POST /api/v1/api-keys` | scope `model:invoke`；本地加密保存 |
| `GET /v1/models` | `GET /api/v1/models` | 过滤 `openai_chat_completions`/`anthropic`；映射 context/max_output |
| `/v1/chat/completions`、`/v1/messages` | 同路径（proxy 进程） | **需放开 UA 门禁**（见 §7.3） |
| `GET /me/skills`、`/me/skills/state` | `GET /api/v1/resources/resolve` + `GET /api/v1/skills` | 按授权集下发给桌面；包走 `/api/v1/skills/{id}/package` |
| `GET /me/agents` | `GET /api/v1/experts` + `/{id}/manifest` | 专家 manifest 含 skills/rules/connectors |
| `GET /desktop/policy` | 新增 `GET /api/v1/desktop/policy` | 扩展模块；结构保持旧 `DesktopPolicy`，客户端少改 |
| `POST /desktop/audit/batch` | 删除 | 模型用量由网关记录；工具/审批审计后续再议 |
| `GET /desktop/quota/me` | `GET /api/v1/billing/account` | 额度/余额/流水 |
| `GET /desktop/usage/summary` | `GET /api/v1/billing/entries` | 或管理端统计接口 |
| `GET /api/v1/releases/electron/manifest` | 新增扩展，保持路径 | 客户端更新逻辑不变 |
| `POST /api/v1/feedback/ticket` | `POST /api/v1/feedback` | 改 wire；或扩展层保留旧 wire |
| `/v1/kb/*` | `/api/v1/kb/*` 或保留 WeKnora | 见 §10 |
| `/admin/*` | `/api/admin/v1/*` | 管理台整体替换 |

### 6.3 客户端改造清单

- 删除 `packages/services/src/reactor-server/*` 的 JWT/网关令牌/audit outbox 逻辑；新增 `packages/services/src/server-v2/*`（OAuth、API Key、models、resources、billing、feedback、updates）。
- `reactorServerService.ts` 拆分：认证、模型目录、技能同步、Agent 同步、策略、额度分别成服务；保留 `ICredentialService` 作为唯一密钥存储。
- CLI 侧 provider 哨兵值保留：企业 provider 仍用哨兵 `managed-by-reactor-server` 识别；每次请求前由 Host 解析最新 API Key（不在配置文件落盘）。
- UI：`EnterpriseLoginScreen` 改为“打开浏览器登录 + 回环回调”；账号面板、额度卡、市场页改用新接口；错误文案区分 401/403/额度不足。
- 删除 `server-skills`/`server-agents` 的“安装/启停/收藏”语义，改为“授权可见即物化”；用户自建技能/Agent 不受影响。
- 保留 `workspaceIdentity`、owner/lease、手机远控 relay；它们与企业管理面无关。

---

## 7. 必须先解决的硬问题

### 7.1 成员写入缺失（P0 阻塞）

- `Server-V2/backend/cmd/server/main.go` 调用 `app.New`；`internal/app/app.go` 在无宿主时注入 `member.EmptyUserWriter{}` / `EmptyGroupWriter{}`。
- `EnsureInitialAdmin` 直接调用 writer，`ErrWriterUnavailable` 被忽略（`internal/app/app.go`），所以 **空库不会创建管理员**。
- 管理台“创建用户/重置密码/邮箱注册/OAuth 自动注册/分组写入”都会返回 `member_writer_unavailable`（`internal/identity/admin.go` 等）。
- 处理：在 `Server-V2/backend/reactor/member` 实现 `member.UserWriter` / `GroupWriter` 的 SQL 版本（可复用 `internal/identity/query.sql` 的 `CreateUser`、`AssignCreatedUserGroups` 等），在 `cmd/server` 注入；保留上游 `server.Run` 的宿主注入能力。
- 验收：空库 `MONKEYAI_INITIAL_ADMIN_*` 创建管理员；管理员创建用户、建组、移动成员、重置密码全部成功。

### 7.2 AD/LDAP 缺失（P1）

- 上游只有本地密码 + OIDC（`internal/identity/upstream.go`），没有 LDAP。
- 现有旧库有 811 用户（807 本地 + AD 来源），不能全部重置。
- 处理：
  1. `internal/identity/ldap`：配置（URL/LDAPS、BaseDN、BindDN/口令、登录属性、用户过滤、超时）；`passwordLogin` 在本地密码失败或用户 `source=ad` 时走 LDAP bind。
  2. 登录名兼容：旧用户用 uid（sAMAccountName），MonkeyAI 用 email；增加 `login` 字段解析 uid/email，或迁移时写 `legacy_uid` 映射。
  3. 定时同步：按 DN 的 OU 还原分组树；缺失的 `source=ad` 用户停用（不删除）；写同步日志。
  4. 安全：优先 LDAPS/StartTLS；不记录口令；bind 失败与密码错误分开文案。
- 验收：AD 用户登录、禁用用户拒绝、部门树同步、同步日志可见。

### 7.3 模型网关与密钥

- **UA 门禁**：`Server-V2/backend/internal/proxy/proxy.go` 只接受 User-Agent 含 `ohmyagent` 的请求；Reactor 会被 401。改为可配置 allowlist（至少 `Reactor`/`ZCode`），或用部署配置放开。
- **密钥落库**：上游 `models.api_key` 明文；旧库是 AES-256-GCM。迁移前必须：
  - 方案 A（推荐）：新增 `model_secrets` 表或 `api_key_ciphertext`，用 `REACTOR_SECRET_KEY`（或新 `SERVER_V2_SECRET_KEY`）AES-256-GCM 加密；读取时解密。MCP 凭据同样处理。
  - 方案 B：接受明文但限制 DB 权限与备份加密；不推荐。
- **协议**：上游 proxy 只有 chat/responses/messages；旧 `embeddings`/`rerank` 若仍被调用，需补适配或保留旧 gateway 过渡（首期可让旧 gateway 只服务这两个端点）。
- **计费单位**：旧 `pricing` JSON 与上游 `credit_multiplier`/积分单价不是同一模型；需要一张换算表并在管理台展示，不能静默取默认值。

### 7.4 客户端重写风险

- 旧企业接线约 8.8k 行；直接改原生 API 意味着登录、模型目录、技能/Agent 同步、额度、策略、反馈、更新全部重测。
- 必须先冻结契约（本文 §6），再按模块替换；每个模块保留旧实现的回滚分支到切换日。
- CLI provider 哨兵值与 runtime header 注入是热路径，改动要有单元/集成测试。

---

## 8. 数据迁移

### 8.1 主键与映射

旧库 `users.id` / `departments.id` 是 `SERIAL`，业务关联用 `uid`；新库是 UUID。**不能直接复制 id**。

- 新增 `reactor_legacy_users(legacy_uid text primary key, user_id uuid unique, legacy_source text, migrated_at timestamptz)`。
- 新增 `reactor_legacy_groups(legacy_dept_id int primary key, group_id uuid unique, legacy_path text)`。
- 用户 UUID 用 `uuidv5(namespace, legacy_uid)` 生成，保证可重复；组同理用 `uuidv5(namespace, legacy_path)`。
- 迁移脚本幂等：重复执行只 upsert，不重复建号。

### 8.2 字段映射

| 旧 | 新 | 处理 |
| --- | --- | --- |
| `users.uid` | `users.id`（UUIDv5）+ 映射表 | 保留旧 uid 查询 |
| `users.name/email` | `users.name/email` | email 为空时生成 `<uid>@legacy.local` 并标记需补全 |
| `users.role platform_admin/dept_head/user` | `admin` / 组主管 / `user` | dept_head 写 `group_users.is_supervisor` |
| `users.department_id` | `group_users.group_id` | 按部门映射；根部门→根分组 |
| `users.status` | `users.status` | disabled→disabled |
| `users.password_hash`（bcrypt） | `users.password_hash` | 先兼容 bcrypt 校验，成功后重哈希 PBKDF2；或强制改密 |
| `users.must_change_password` | 新增列/客户端标记 | 建议加 `must_change_password` 列，保留强制改密 |
| `departments` 树 | `groups` 树 | `path` 唯一；父级先迁 |
| `ai_providers` + `secrets` | `models` | 解密 secret，按每个 model 生成一行；base_url 同 provider |
| `ai_models.model_type chat/embedding/rerank` | `models.protocol` | chat→`openai_chat_completions`/`anthropic`；embedding/rerank 暂不迁 |
| `ai_models.pricing` | `credit_multiplier` + 单价配置 | 需换算表；无法换算的标记人工处理 |
| `skills` + `skill_files` | `skills` + S3 | 打成 MonkeyAI skill 包导入 |
| `agents` | `experts` | persona→prompt；skills/rules/connectors 关联；model/policy 记扩展字段 |
| `kb_datasets/documents/segments` | `kb` | 若采用 MonkeyAI KB，重新解析/嵌入；否则保留 WeKnora |
| `audit_event/usage_ledger` | `audits/model_calls/credit_*` | 历史只归档，不强行等价换算 |
| `quota_rule/quota_alert` | `billing_quotas` + 扩展设置 | 按 scope 映射到组/用户 |
| `app_release` | 扩展 `app_release` | 文件卷一起迁 |
| `feedback_*` | `feedback` | 字段/wire 映射 |
| `standards/terminology/rule_libraries/interface_mode_policy` | 扩展表 | 原样迁移，保留管理页 |

### 8.3 迁移顺序

1. 建映射表 + 扩展表（新迁移）。
2. 组树 → 用户 → 组关系/主管。
3. 模型/供应商（解密+加密）→ 技能/专家 → KB。
4. 额度/策略/更新/反馈/标准/术语。
5. 校验：计数、抽样字段、部门树、用户登录、模型调用、技能包、额度。
6. 切换后旧库只读保留 ≥ 1 个发布周期；回滚直接切回旧服务。

---

## 9. 分阶段实施与验收

### P0 底座可行性（1–2 周）

- `Server-V2/backend` 可在本机构建（Go 1.27；Docker 私有基础镜像替换）。
- 实现 `reactor/member` 写入；空库创建管理员；管理台登录。
- 起 PostgreSQL+pgvector + S3（MinIO/RustFS）；跑通迁移。
- 模型网关放开 UA；用 API Key 完成一次 chat/messages。
- **门禁**：管理员创建用户/组；桌面端（最小 spike）能拿到 OAuth token + API Key 并完成一次模型调用。

### P1 身份/组织/AD（2–3 周）

- LDAP 登录 + 定时同步 + 同步日志；bcrypt 兼容。
- 用户/组迁移脚本 dry-run；抽样 20 个用户/5 层部门。
- 管理台换品牌、菜单收敛、成员管理可用。
- **门禁**：AD 用户与本地用户都能登录；部门树一致；停用用户被拒；迁移可重复执行。

### P2 客户端认证与模型（2–3 周）

- 桌面端 OAuth 回环登录、refresh、logout、API Key 生命周期。
- 模型目录映射、provider overlay、CLI 热路径鉴权。
- 删除旧 JWT/网关令牌代码。
- **门禁**：登录/刷新/登出；chat 与 messages 两种协议；401 自动轮换；无令牌落盘。

### P3 资源与知识库（3–4 周）

- 技能包、专家 manifest、MCP connectors/credentials/tools、资源 resolve。
- 桌面端技能/专家物化；市场页改新接口。
- KB 方案落定并接入（MonkeyAI KB 或 WeKnora）。
- **门禁**：服务端下发技能/专家可用；MCP 工具调用；KB 检索；用户自建资源不被覆盖。

### P4 计量/额度/策略/审计（2 周）

- 网关计费/用量在管理台可见；额度规则迁移；客户端额度卡改新接口。
- `desktop-policy` 扩展模块 + 客户端策略缓存；删除 audit outbox。
- **门禁**：模型调用落账；额度告警/硬限流；命令黑名单/出网白名单生效。

### P5 Reactor 独有模块（2–3 周）

- 软件更新（manifest/产物/下载页）、反馈、标准/术语、界面模式、同步日志。
- 管理台补页；旧路径保持或客户端同步改。
- **门禁**：旧版客户端检查更新；反馈工单闭环；标准/术语读写。

### P6 数据迁移与切换（2 周）

- 全量迁移 + 双跑 + 对账 + 回滚演练。
- **门禁**：计数/抽样一致；核心 E2E 全绿；回滚 30 分钟内完成。

---

## 10. 待确认项

1. **知识库**：采用 MonkeyAI 内置 KB（pgvector + AnyDoc）并重嵌入，还是保留现有 WeKnora 远端？前者管理面统一，后者迁移成本低。
2. **embeddings/rerank**：是否还有调用方？若只有 KB 内部使用，可不迁；若有外部客户端，需补网关适配。
3. **标准/术语/界面模式**：是否继续保留？保留则作为扩展模块移植，工作量 +2 周。
4. **云电脑/engine**：上游 `engine` 是 Linux containerd/gVisor 方案，与 Reactor 当前远程 workspace 不同；首期不做。
5. **书面许可范围**：内部使用/分发/再许可的边界需法务确认；AGPL 源码提供义务按 [LICENSE](../Server-V2/LICENSE) 执行，书面许可另行归档。

---

## 11. 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 开源版成员写入缺失 | 空库无法登录/建用户 | P0 实现 writer；这是硬门禁 |
| AD 登录语义差异 | 807 用户无法登录 | 保留 LDAP + uid→email 映射 + bcrypt 兼容 |
| 模型密钥明文 | 安全基线倒退 | 迁移前补 AES-GCM；未完成不迁生产密钥 |
| UA 门禁 | 所有模型调用 401 | 改为可配置 allowlist |
| 客户端重写回归 | 登录/模型/技能/额度全断 | 契约冻结 + 分模块切换 + 双跑 |
| 计费单位不一致 | 额度算错 | 先做换算表与对账，不默认 1:1 |
| Go 工具链/私有镜像 | 无法构建 | 公共镜像/内网镜像仓库；离线制品 |
| AGPL/书面许可 | 合规风险 | 保留 LICENSE/NOTICE；许可归档；发布前法务确认 |
| 上游未完成项 | 远程执行/云环境不可用 | 首期不依赖；只做已验证的 control/proxy/资源/计费 |

---

## 12. 验收总清单

- [ ] `Server-V2/backend`：`go build ./...`、`go vet ./...`、`go test ./...` 通过。
- [ ] `Server-V2/web`：`pnpm typecheck`、`pnpm build` 通过。
- [ ] 空库初始化：初始管理员、创建用户/组、重置密码、停用/启用。
- [ ] AD 登录、AD 同步、停用同步、同步日志。
- [ ] OAuth 回环登录、refresh、logout；API Key 创建/轮换/撤销。
- [ ] chat/messages 模型调用；额度/流水/账单；401 轮换。
- [ ] 技能/专家/MCP/KB 下发与物化；用户自建资源隔离。
- [ ] 桌面端技能/Agent 市场、额度卡、账号面板、反馈、更新检查。
- [ ] 数据迁移 dry-run + 全量 + 对账；回滚演练。
- [ ] 旧版客户端在新服务端上的兼容边界（更新/反馈至少可用）。

---

## 13. 变更记录

- 2026-11-27：创建方案；源码基线导入 `Server-V2/`；确认底座 MonkeyAI、客户端直改原生 API、保留 AD。
