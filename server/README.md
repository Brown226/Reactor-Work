# Reactor 服务端（server/）

> **一句话**：Reactor（数智堆脑）的受控服务端——身份底座（LDAP/本地双源登录、JWT、组织与权限）+ 模型网关（唯一模型出口、供应商/密钥/模型管理）+ 管理台 API，由 Docker Compose 部署。
>
> 本目录是**独立 pnpm workspace**，从 `E:\工作\Reactor-Desktop` 搬迁而来：三个包共 374 个文件**逐字节原样**搬入，
> 仅 `docker/compose.yml`（三处部署缺陷）与 `datasets/repo.ts`（一处查询缺陷）有改动，均见 §7、§8。

---

## 1. 搬迁说明（2026-09-21）

**来源**：`E:\工作\Reactor-Desktop`，共三个包——

| 包 | 文件数 | 是什么 |
|---|---|---|
| `packages/server` | 72 | `@reactor/server` 服务端本体（身份/网关/管理台 API/技能/Agent/知识库/审计） |
| `packages/shared` | 56 | `@reactor/shared` 契约层，服务端的**运行时**依赖（skills/agents 有值导入） |
| `packages/admin` | 246 | `@reactor/admin` 管理台 SPA（React 19 + Vite），由服务端在 `/console` 托管 |

**方式**：以旧仓 git 跟踪清单为白名单逐文件复制（374 个文件 + 4 个根配置），保证与旧仓**当前工作树**一致（含未提交改动），同时排除 `dist/`、`node_modules/`、`.runtime/` 等本地产物；复制后逐个 SHA256 核对。

**为什么保留 `packages/{server,shared,admin}` 这层**：三条相对路径契约都写死在代码/编排里，改层级就要改代码——

| 契约 | 位置 | 依赖的相对深度 |
|---|---|---|
| 管理台 SPA 产物定位 | `packages/server/src/identity/admin-static.ts` 的 `../../../admin/dist/` | 服务端 ↔ 管理台必须同处 `packages/` 下 |
| Docker 构建上下文与 `.env` | `packages/server/docker/compose.yml` 的 `context: ../../..`、`env_file: ../../../.env` | 期望 `<workspaceRoot>/.env` |
| 冒烟脚本读仓库根 `.env` | `packages/server/scripts/*.mjs` 的 `../../../.env` | 同上 |

因此本工作区根就是 `<workspaceRoot>`：`.env`、`.dockerignore`、`tsconfig.base.json` 放在 `server/` 根，`docker compose` 的构建上下文是 `server/`。

**没搬的东西**：

| 未搬项 | 原因 | 影响 |
|---|---|---|
| `.env` | 含真实凭据（DB 口令、上游 key、`REACTOR_SECRET_KEY`），按安全约定不入库 | 需你从旧项目复制，见 §3 |
| `pnpm-lock.yaml`（旧） | 旧 lockfile 覆盖已卸载的包，不可复用 | 首次 `pnpm install` 重新生成 |
| `packages/client`、`packages/sidecar` | 旧项目的**桌面端**（Electron 壳 + Node 内核）。这个位置已由主仓 Reactor-Work 本身承担，不需要搬 | `smoke:e2e` 依赖 sidecar，本工作区跑不了 |
| `docker/seed/{employees.csv,seed.ldif}` | 含真实员工信息（旧仓亦 gitignore） | 现有 LDAP 数据卷已存在，不影响运行；重建 mock 域时按 `docker/seed/README.md` 生成 |
| 旧仓 `.github/workflows/ci.yml` | 内容是桌面端门禁（探针/sidecar/electron），与服务端无关 | — |
| 旧仓 `docs/`（1.6M） | 全项目文档（BRD、实施计划、客户端方案…），非服务端代码 | 仍在旧仓可查 |

---

## 2. 目录结构

```
server/
├── .env.example              # 配置模板（复制为 .env 后填真实值）
├── .dockerignore             # Docker 构建上下文收窄（白名单式）
├── .npmrc / tsconfig.base.json
├── package.json              # 本工作区根（build / typecheck / dev / docker 快捷入口）
├── pnpm-workspace.yaml
└── packages/
    ├── shared/               # @reactor/shared —— 契约层（零第三方依赖纯 TS）
    │   └── src/              #   skills / agents / model / audit / kb / session …
    ├── admin/                # @reactor/admin —— 管理台 SPA（React 19 + Vite + Tailwind 4）
    │   ├── src/pages/        #   16 页：运营总览/用户组织/角色权限/模型与供应商/密钥/用量/
    │   │                     #        审计/同步日志/知识库/技能/技能包/Agent/个人中心…
    │   ├── public/brand/     #   管理台自带品牌素材（不依赖 client 包）
    │   └── scripts/          #   port-kb-ui.mjs（BuildingAI 移植管线，见 §9 注意事项）
    └── server/               # @reactor/server —— 服务端本体
        ├── Dockerfile
        ├── docker/compose.yml  # 一体化编排：pg + ldap + identity + gateway + portal
        ├── docker/seed/        #   mock CNPE 域种子（generate.py + 说明）
        ├── scripts/            #   冒烟与运维脚本（smoke:* 见 §4）
        └── src/
            ├── index.ts          # 网关进程入口 :8790
            ├── identity-entry.ts # 身份进程入口 :8791
            ├── gateway/          # 模型网关（多上游 registry、密钥/供应商/模型管理）
            ├── identity/         # 身份底座（登录/JWT/组织/权限/同步/管理台托管）
            ├── auth/             # LDAP + 本地 bcrypt 双源
            ├── agents/ skills/ datasets/  # Agent 目录 / 技能市场 / 公共知识库
            ├── updates/          # 软件更新（UPD）：产物登记 + 客户端 manifest + 下载
            ├── feedback/         # 反馈 / 需求（FBK）：工单落库 + 管理台受理面
            ├── audit/            # 审计事件与用量聚合
            └── common/           # 密钥封存（AES-256-GCM）、定价、三级数据范围
```

### 2.1 软件更新（UPD）

桌面端的自更新**只认服务端 manifest**（客户端路径写死 `/api/v1/releases/electron/manifest`，
打包后连 `ZCODE_UPDATE_FEED_URL` 覆盖都会被忽略），因此发版必须走管理台：

1. 管理台 →「系统 → 软件更新」→ 新建发布（平台 / 通道 / 版本 / 更新说明 / 灰度）；
2. 选择安装包（`.exe` `.msi` `.zip` `.dmg` `.pkg` `.AppImage` `.deb` `.rpm` `.pkg.tar.zst`，默认上限 1GB）；
3. 上传完成即可上线（草稿态可反复换产物；**上线后不能改文件** —— 客户端按 sha512 缓存，换了会让已下载用户校验失败）。

| 面 | 路径 | 鉴权 |
|---|---|---|
| 管理面 | `GET/POST /admin/updates/releases`、`PUT /admin/updates/releases/:id/file`、`PATCH/DELETE /admin/updates/releases/:id` | Bearer + platform_admin |
| 下发面 | `GET /api/v1/releases/electron/manifest?platform=&channel=&device_mid=`、`GET /api/v1/releases/electron/files/:name` | **公开**（客户端不带 Authorization） |
| 用户下载面 | `GET /download`（下载页）、`GET /api/v1/releases/published`（各平台最新已发布版本）、`GET /api/v1/releases/changelog`（版本历史，供官网更新日志同步） | **公开**（面向还没装客户端的普通用户） |

用户下载面解决的是「新用户第一次从哪拿安装包」：已装客户端靠下发面的 manifest 自更新，
而没装的人没有客户端、也没有账号，此前只能由管理员从数据卷里手工拷包。
现在把服务端地址给用户，让他打开 `http://<服务端地址>/download` 即可看到各平台最新版本并直接下载
（页面是服务端直出的自包含 HTML，零外部资源；版本列表只回已发布且有产物的条目，不外传 stored_name/sha512）。

`/api/v1/releases/changelog` 供**门户官网的更新日志页**同步：按**版本号去重**（同一版本发到多平台只一条）、
按上线时间倒序，只回已上线且写了更新说明的条目。官网页面用渐进增强加载，取不到时保留静态基线。
两处（客户端更新提示、官网更新日志）读的是**同一份服务端发布说明**，发版时填一次即可。

> 平台串口径：客户端上报的是 electron-builder / uname 口径（`windows-x86_64`、`darwin-aarch64`），
> 而管理台登记与库内用的是内部口径（`windows-x64`、`darwin-arm64`）。`normalizeReleasePlatform`
> 做**归一化**后再查库——**两套写法都必须接受**，否则已装客户端取 manifest 被判非法 400，
> 表现为"桌面端永远检查不到更新、右上角没有更新提示"（实测踩过的坑，冒烟里有回归断言）。

下发面必须挂在 `identity/routes.ts` 的**公开段**（`createIdentityApp` 里 authed 组之前）——
挂到 authed 之后会被 `use("*")` 拦成 401，症状是全网客户端"检查更新失败"。

客户端侧配套：把端点的 `ZCODE_ENDPOINT_ORIGIN`（或 `ZCODE_BASE_URL`）指向本服务的对外地址即可，
manifest 与产物会自动走上面两条路径；`channel` 由客户端的「接收预览版本」设置决定（数字口径 1=stable / 3=preview）。

产物落盘 `REACTOR_UPDATE_FILE_DIR`（容器内 `/app/data/updates`，卷 `updates`），
上限 `REACTOR_UPDATE_MAX_BYTES`（默认 1GB）。**删卷 = 已发布版本全部变成 404 产物**。

---

### 2.2 反馈与需求（FBK）

桌面端「帮助 → 问题上报 / 给产品提需求」提交的工单落进本服务，管理台「系统 → 反馈与需求」受理。
客户端协议**不新造**：照 `packages/services/src/feedback/feedbackHttpClient.ts` 的 wire 格式实现
（`ticket_id` / `content.category` / `environment` / `messages[].sender_type`），所以客户端只需改基址。

| 面 | 路径 | 鉴权 |
|---|---|---|
| 提交面 | `POST /api/v1/feedback/ticket`、`GET /api/v1/feedback/ticket[/:id]`、`POST /api/v1/feedback/ticket/:id/message`、`PUT /api/v1/feedback/ticket/:id/attachment`、`GET /api/v1/feedback/ticket/:id/attachments/:aid` | **公开**（Bearer 可选，验过才填报告人） |
| 管理面 | `GET/PATCH /admin/feedback/tickets[/:id]`、`POST /admin/feedback/tickets/:id/messages`、`GET /admin/feedback/tickets/:id/attachments/:aid/download` | Bearer + platform_admin |

提交面必须挂在 `identity/routes.ts` 的**公开段**：自建端只认自家 identity 签发的 JWT，
官方 `zcodejwttoken` 验不过，挂进 authed 组会让本产品自己的上报全部 401（与更新下发面同一条理由）。
报告人姓名/账号/部门**只从验过的令牌取**（`claims.name` / `claims.sub` / `claims.deptId → departments.path`），
客户端自报的 `reporter` / `environment` 不采信。

客户端接入由 `createFeedbackService` 的 `getApiBaseUrl` 完成（装配在 `services/src/node.ts`）：
企业登录后基址变为 `<serverUrl>/api/v1`；未配置企业服务端时回落官方后端，开源用法不受影响。
本地调试可用 `ZCODE_FEEDBACK_API_BASE` 硬覆盖（优先级最高）。

**附件走字节直传**：客户端在企业基址下改道 `PUT /api/v1/feedback/ticket/:id/attachment`（body = 原始字节流，
`x-file-name` 用 `encodeURIComponent` 带原始文件名），服务端流式落盘到 `REACTOR_FEEDBACK_FILE_DIR`
（容器内 `/app/data/feedback`，卷 `feedback-files`），单文件上限 `REACTOR_FEEDBACK_MAX_BYTES`（默认 1GB），
后缀白名单 `.zip .png .jpg .jpeg .webp .gif .txt .log .json .md .pdf .csv`。磁盘名用 uuid，
原始文件名只存 PG（`feedback_attachment.file_name`）；先写 `.part` 再 rename，半截文件不入库。
仅企业基址改道，走官方后端的客户端仍用 OSS 直传——`/feedback/attachment/upload-credential` 保留，
只为让**旧客户端**拿到 400 + `attachments_unsupported` 而不是 404。上传失败降级成工单里的一条系统评论，
正文、评论、状态流转不受影响。

红点语义由服务端维护：用户补充消息 → `unread=true`；管理台打开详情 → 置 false。

---

## 3. 快速开始

```bash
cd server
cp ../../Reactor-Desktop/.env .      # ① 带真实凭据的配置（不入库；若旧项目路径不同请自行替换）
pnpm install                        # ② 生成新 lockfile
pnpm build                          # ③ 建 shared → server → admin
pnpm typecheck                      # ④ 类型检查
```

> 管理台要出产物得单独构建（`vite build` 较慢，`pnpm -r build` 里也会跑到）：
>
> ```bash
> NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @reactor/admin build
> ```
>
> 产物落在 `packages/admin/dist`，服务端启动时自动挂到 `/console`（已实测 6/6 冒烟通过）。

> 只改服务端、不碰桌面端时，这就是完整流程。主仓的 `pnpm typecheck` / `lint` / `architecture:check` **不覆盖本目录**，反之亦然。

**⚠ PG 宿主端口是 15432（不是 55432）**：`55432` 落在 Windows 的保留端口段（实测 `55412-55511`，Hyper-V/WSL 动态排除），
`docker compose up` 会直接报 `bind: An attempt was made to access a socket in a way forbidden by its access permissions`。
旧项目的 `.env` 指的是**原生** PG 的 IPv6 回环 `[::1]:55432`，容器这条映射从未生效过，所以这个坑一直没暴露。
因此 `server/.env` 的 `REACTOR_DB_URL` 必须是 `postgres://…@127.0.0.1:15432/reactor`。换机器/重启后若仍冲突：

```bash
netsh int ipv4 show excludedportrange protocol=tcp   # 看保留段，挑一个段外的端口
```

**起服务**（两种形态，按需选一）：

```bash
# A. 本机直跑（需要本机 PG 与 LDAP 可达，端口见 .env）
pnpm --filter @reactor/server dev:identity   # :8791
pnpm --filter @reactor/server dev            # :8790

# B. Docker 一体化（pg + ldap + identity + gateway + portal 全在容器里）
pnpm docker:up          # = docker compose -f packages/server/docker/compose.yml up -d
pnpm docker:down        # 停止；**绝不加 -v**（数据卷是 external，加 -v 会丢 811 用户/807 员工）
```

> `portal` 是产品门户（官网 + 说明书静态站，:8080）。它与 identity 同处默认网络，
> nginx 反代 `identity:8791` 读同一 updates 卷与 app_release 数据——**一键起全栈，下载面与更新日志天然互通**。

> 数据卷中 `pg-data` / `ldap-data` / `ldap-config` 是 **external**，指回历史卷名（`docker_pg-data` 等）——换目录、改项目名都不会重建空卷；
> `kb-files` 是 compose 管理的卷（KB 上传件从未真正持久化过，见 §7.1）。

### 3.1 真实 AD 接入（替换 mock LDAP）

配置入口唯一：`packages/server/src/identity/config.ts` 读 6 个环境变量，**没有第二处配置源、没有管理台界面可配**。改完必须重启 identity 容器。

```bash
REACTOR_AUTH_MODE=mixed                      # 保留 admin 本地号，域控挂了也能进管理台
REACTOR_LDAP_URL=ldap://10.30.2.5:389        # AD 地址；若域控开了 LDAPS 则用 ldaps://<ip>:636
REACTOR_LDAP_BASE_DN=OU=cnpe,DC=cnpe,DC=cc   # 搜索根（用户 OU 或其父级）
REACTOR_LDAP_ADMIN_DN=<服务账号 DN>           # 只读权限即可，如 CN=svc_reactor,OU=...,DC=...,DC=...
REACTOR_LDAP_ADMIN_PWD=<服务账号口令>
REACTOR_LDAP_LOGIN_ATTR=sAMAccountName        # AD 登录名（也可 userPrincipalName / mail）
REACTOR_LDAP_USER_FILTER=(&(objectClass=user)(objectCategory=person)!(userAccountControl:1.2.840.113556.1.4.803:=2))
```

三条**必须知道**的差异（代码已适配，但配错仍会静默搜不到人）：

1. **用户对象**：AD 是 `objectClass=user` + `objectCategory=person`，mock OpenLDAP 是 `inetOrgPerson`。`REACTOR_LDAP_USER_FILTER` 缺省仍是 mock 口径，**接 AD 不显式改它 = 搜索返回 0 人、同步空跑**。
2. **登录属性**：AD 没有 `uid` 属性，用 `sAMAccountName`。attributes 只请求 `loginAttr` + `displayName/cn/mail`，不会再要 AD 没有的属性。
3. **禁用账户与联系人**：AD 会在同一 OU 里混放。filter 里的 `objectCategory=person` 排除联系人与共享邮箱，`!(userAccountControl:1.2.840.113556.1.4.803:=2)` 排除已禁用账户——不排除的话这些人会进用户列表但永远 bind 失败。

部门映射是通用的：按用户 DN 的 `OU=` 段落还原部门树（`ouPathFromDn` → `ensureDeptPath`），AD 的
`CN=张三,OU=设计管理部,OU=河北分公司,OU=cnpe,DC=cnpe,DC=cc` 天然能映射，**这块不用改**。

切到真实 AD 前先想清楚 mock 数据怎么处理：`sync.ts` 的规则是「AD 源缺失者停用」，
库里现有 807 个 `source=ad` 的 mock 员工**会被全部停用**（不删除，但都登不了）。想保留就先导出、想干净就清库重同步。

登录链路（`auth/login.ts`）：先查 PG——`source=local` 走 bcrypt，`source=ad` 或未入库的走
「服务账号按登录属性搜 DN → 用户 DN + 输入密码 bind」。密码**从不落库**，AD 口令归域管。

> ⚠ 389 明文端口有个真实风险：若域控启用了「LDAP 服务器签名要求」（Windows Server 2019+ 默认趋严），
> 明文 simple bind 会被拒（`strongAuthRequired`）。 ldapjs 不支持 LDAP 签名，只能走 `ldaps://`（636）
> 或请域管放开该策略。首次联调先跑一次管理台「组织同步 → 预览」，看 `total` 是否为 0 来判断。

#### 3.1.1 两重保障：本地账号与域账号并存

2026-10-14 起，原 mock LDAP 的 807 个账号已**批量转为平台本地账号**（`source=local`，
初始密码 `<uid>@123`，首次登录强制改密）。因此当前是 `mixed` 模式下的双轨并存：

| 账号来源 | 认证方式 | 密码谁管 |
|---|---|---|
| `source=local`（807 名前员工 + admin/head/user） | bcrypt 校验 PG 哈希 | **平台**（可改、可重置、可强制改密） |
| `source=ad`（接真实 AD 后同步进来的新员工） | LDAP bind | 域控（平台无权也不落库） |

**关键性质**：`sync.ts` 的 `computeSyncDiff` 对 `existing.source === "local"` 是**跳过**而非停用。
所以将来接入真实 AD 并跑组织同步时，这 807 人**不会**被误判为「AD 缺失」而停用——
AD 接不通、接错了都不会导致全员登录不了。代价是他们的姓名/部门不再随 AD 自动更新
（要更新需手工改或写一次性脚本）。

**不要**把 `REACTOR_AUTH_MODE` 切成 `local`——那会让域账号一律不可用（`auth.ts:151`），
把刚接好的 AD 又关掉。`mixed` 才是两重保障的正确形态。

运维脚本：`node packages/server/scripts/convert-ad-users-to-local.mjs [--apply]`（默认 dry-run）。

---

## 4. 冒烟与运维脚本

> **现在任意 cwd 都能跑**（2026-09-22 起）：脚本一律用**绝对路径**读 `server/.env`
> （`process.loadEnvFile?.(fileURLToPath(new URL("../../../.env", import.meta.url)))`），
> 所以 `pnpm --filter @reactor/server smoke:x` 也是对的。
>
> 此前不是这样：5 个脚本（`identity`/`skills`/`agents`/`org`/`e2e`）写的是**裸** `process.loadEnvFile()`，
> 读的是**当前工作目录**的 `.env`。而 `pnpm --filter` 把 cwd 切到 `packages/server/`，那里没有 `.env`，
> 于是静默回落到内置默认值 `127.0.0.1:55432`（compose 映射在 `15432`）并**连接失败** ——
> 只有手工 `node packages/server/scripts/…` 从 `server/` 根执行才对。两个 tsx 脚本
> （`updates`）则连 `loadEnvFile` 都没有，会打印 `SKIP` 并以 0 退出，**看起来是绿的、实际从未跑过**。
> 两者都已修掉，并在 `knowledge-smoke` 里按同一口径实现。

```bash
cd server
pnpm --filter @reactor/server smoke:knowledge
pnpm --filter @reactor/server smoke:kb-pure          # 无 PG，纯逻辑 + 源契约
pnpm --filter @reactor/server smoke:kb-server        # 连库（走 reactor_smoke）
pnpm --filter @reactor/server smoke:gateway-embeddings
```

> 2026-10-08 补：`kb-pure-smoke.ts`、`kb-server-smoke.ts`、`gateway-embeddings-smoke.ts`
> 三个脚本此前**没有注册进 `package.json`**，只能按文件路径手工调 `tsx` ——
> 于是 README 里写的 `smoke:x` 跑法对它们无效（报 `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`）。
> 现已补齐 `smoke:kb-pure` / `smoke:kb-server` / `smoke:gateway-embeddings`。
> 同时 `kb-server-smoke.ts` 漏了「绝对路径读 `.env`」那一行（正是上面记的老坑，它是唯一的漏网者），
> 且 `useSmokeDb()` 排在可达性检查**之前**、自己也会回落到 55432 ⇒ 直接 `ECONNREFUSED` 崩掉退出 1，
> 连它头注承诺的「连不上则 SKIP 退出 0」都走不到。两处都已修。

| 用途 | 脚本 |
|---|---|
| 网关端到端（**依赖未搬迁的 `packages/sidecar`，本工作区跑不了**） | `e2e-smoke.mjs` |
| 身份底座（登录/刷新/登出/同步 + **密码链路 11 项**：初始密码 / 强制改密 / 强度校验 / 管理员重置 / 越权） | `identity-smoke.mjs`（**24 项全绿**，2026-10-14） |
| 组织与用户 | `org-smoke.mjs` |
| **AD 账号批量转本地账号**（运维脚本，**非冒烟**：默认 dry-run，`--apply` 才写库；把 `source=ad` 且 active 的用户转 local、密码设 `<uid>@123`、置 `must_change_password`；见 `docs/未完成-初始密码与强制改密-方案-v1.md` §8） | `node packages/server/scripts/convert-ad-users-to-local.mjs [--apply]` |
| 管理台 API（供应商/密钥/模型） | `admin-smoke.mjs` |
| 管理台静态托管（含路径穿越反证） | `admin-static-smoke.mjs`（管理台产物缺失时会 SKIP 并以 0 退出；产物存在时 **6/6 通过**） |
| 网关鉴权 | `gateway-auth-smoke.mjs` |
| 技能市场 | `skills-smoke.mjs`、`skills-import.mjs` |
| Agent 目录 | `agents-smoke.mjs` |
| 界面模式权限（编程模式受众：默认关闭 / off·all·role·dept·user 五档 / 管理员恒全档 / 校验与越权；见 `docs/未完成-编程模式权限-方案-v1.md`） | `smoke:interface-mode`（`interface-mode-smoke.mjs`；PG 不可达时起不来） |
| 审计与用量 | `audit-smoke.mjs`、`t34-smoke.mjs` |
| 额度分配全链路（QTM P1–P4） | `smoke:quota`（`quota-smoke.ts`，**138 项全绿**：①域层 —— 建表幂等/写入回读同形/幂等键挡重放/聚合兜底/过滤/只增不改；②网关接线 —— 四形态（anthropic/openai 非流式+流式、embeddings、rerank）真实落账、**OpenAI 缓存口径减算**、SSE 顺路解析、上游 5xx 记 error 行不产生假用量、账本降级不阻断；③对账端点；④额度规则 CRUD/部门子树/分 scope 告警幂等/百分比口径；⑤**单位后缀**（`5M`/`500K`/`1.5M`/`500万`/裸数字，含 8 合法 + 8 非法形态）；⑥**硬阻断** —— 开关关闭不拦、开启后 429 + `policy_block` 审计 + 被拒不打上游 + 放宽即恢复 + dev token 放行；⑦**批量下发** —— dryRun 不写库、`expandUsers` 展开部门子树下每个在用用户、显式 uid 的停用/不存在跳过并给理由、请求内去重、500 目标上限写库前挡下、覆盖标注、重复 apply 幂等、非管理员 403。**真实起网关与 identity 进程**（自带 mock 上游）；PG 不可达时 SKIP 并以 0 退出。见 `docs/未完成-额度分配-方案-v1.md`） |
| 公共知识库（纯函数 / 带服务端） | `smoke:kb-pure`、`smoke:kb-server` |
| 软件更新（建表/上传/manifest/Range/灰度/下线清理） | `updates-smoke.ts`（PG 不可达时 SKIP 并以 0 退出） |
| 反馈与需求（公开提交面 / 管理受理 / wire 格式 / 红点与事件） | `feedback-smoke.ts`（**40 项全绿**；PG 不可达时 SKIP 并以 0 退出） |
| 知识板块（标准清单 / 术语白名单 / 规范库） | `knowledge-smoke.ts`（**46 项全绿**：三域建表幂等、内置术语 seed 与不可删、U+FFFD 护栏、幂等导入、规范库状态语义与级联删除） |
| 管理操作审计兜底（中间件留痕 + 手写埋点去重，见 `src/audit/adminAudit.ts`） | `admin-audit-smoke.ts`（**29 项全绿**；PG 不可达时 SKIP 并以 0 退出） |
| P4 真机验收·**服务端半边**（登录/网关令牌/四型事件上报与回读/幂等/策略下发/登出吊销；**非冒烟库**，直打运行中的 :8791，结束打印审计测试事件清理命令、策略自动还原） | `acceptance:p4`（**30 项全绿**，2026-10-08；桌面半边见 `docs/未完成-服务端接线-P4-用量上报与策略.md` §17） |
| 向量化走网关（自带 mock 上游） | `smoke:gateway-embeddings` |
| **额度分配·管理台视觉验收**（GUI 走查：登录 → 用量与额度 → 额度分配面板 → 新建 5M 规则看换算预览/非法提示/保存/编辑回填/对账表/删除 → **批量分配**对话框（部门下拉/100M 换算预览/超限部门明确报错/ghost uid 的 dryRun 跳过理由/零写入应用回执）；**直打运行中的 :8791**，截图存 `packages/server/shots/`） | `python scripts/quota-admin-walkthrough.py`（**31 项全绿**，2026-10-09；复用系统 Chrome/Edge，未装 playwright 浏览器时 SKIP。覆盖新版面顺序（额度分配→概览→报表）、规则行当期用量、对账折叠） |
| **标准清单 Excel 导入/筛重/导出**（模板下载 6 项 + 预检/确认/库内判重/文件内判重/多版本行/坏行容忍/导出联动/导回闭环，共 **33 项全绿**；见 `docs/standards-excel-io-spec.md` §7–8） | `node packages/server/std-io-verify.mjs`（**连运行中的实例**，非独立库：自带登录，用 `ZZTEST-` 前缀测试数据，结束自动清理；跑前确认没有真实数据带该前缀） |
| 密钥运维 | `rotate-secret-key.mjs`、`verify-secret-key.mjs` |

**数据安全**：连库的冒烟都经 `scripts/lib/smoke-db.mjs` 切到独立库 `reactor_smoke`（每次 DROP+CREATE），
真实库 `reactor` 不受影响；且该库名与真实库同名时会 **fail-closed 拒绝运行**（2026-09-18 有过一次清场脚本误删真实
技能/数字人市场的事故，这个文件就是那次事故的修复）。冒烟**必须串行**跑，两个并行会互相 DROP 对方的库。

---

## 5. 关键约束（改代码前必读）

1. **密钥封存**：`secrets.field_values` 的敏感字段以 AES-256-GCM 存为 `enc:v1:<iv>:<tag>:<ct>`，主密钥来自 `REACTOR_SECRET_KEY`（32 字节 hex/base64）。**该密钥丢失 = 已加密的密钥无法解密**，只能重新录入；留空则明文落库（仅限本地开发）。
2. **两个进程、两个入口**：`identity-entry.ts`（:8791）与 `index.ts`（:8790）共用同一个镜像，靠 compose 的 `command` 区分。新增跨进程共享的初始化要放在两处都能走到的位置。
3. **管理台挂载前缀是 `/console` 而非 `/admin`**：管理台前端自身的路由就叫 `/models`、`/providers`，而管理台 API 在 `/admin/*`——挂到 `/admin` 会与 SPA history 回退冲突（实测报 `Unexpected token '<'`）。
4. **`@reactor/shared` 是运行时依赖而非仅类型**：`skills`/`agents` 模块有值导入，镜像里必须带 `packages/shared/dist`（`Dockerfile` 已单独拷一层），否则容器启动即 `ERR_MODULE_NOT_FOUND`。
5. **三级数据范围**：`all / dept（子树）/ self` 由 `common/scope.ts` 统一裁决，SQL 层与应用层都要校验（公共知识库的双重校验是范例，去掉任一层即越权可见）。
6. **部门/权限**：`identity/permissions*.ts` 里的权限点是与管理台共用的契约，改动要同步管理台。

---

## 6. 与主仓（Reactor-Work）的关系

- 本目录**不在**主仓 `pnpm-workspace.yaml` 的匹配范围内（主仓匹配 `packages/*` 与 `apps/zcode-cli/*`），因此两边依赖、lockfile、门禁互不干扰。
- 主仓是二开的 ZCode 桌面/CLI 工作台（品牌已改为 Reactor）；本目录是它的**服务端**。两者**已接线（P1–P4，见 `docs/未完成-服务端接线-方案-v1.md`）**：桌面端 `reactorServerService` 负责企业登录/令牌刷新、网关令牌换发、服务端技能/Agent 后台同步、用量上报（`/desktop/audit/batch`）与组织策略下发（`/desktop/policy`）。
- 旧项目的 `packages/client`（Electron 桌面端）**刻意没搬**：那个位置由主仓本身承担。所以本目录只含"服务端 + 它的管理台"，不含桌面端。

---

## 7. 搬迁时修正的历史缺陷（**旧仓仍是有问题的版本**）

搬迁过程中发现 `compose.yml` 有两处会使部署出错甚至误判"数据全丢"的问题（均由旧仓 commit `216aff7` 的 KB 提交引入），
已在本工作区修好。**旧仓 `Reactor-Desktop` 里这两处仍在**——不过 §7.2 的解析错误恰好构成一道"保险"：
在旧仓执行 `docker compose up -d` 会**先报 YAML 解析失败**，不会走到 §7.1 的换卷动作；反过来说，
如果将来只修了重复键、没修卷，就会真的踩到空卷。要回修旧仓，把这三处一起改。

### 7.1 pg 数据卷被错挂到 kb-files（会误判数据丢失）

`e5e70f5` 及更早版本里 `pg-data: {external: true, name: docker_pg-data}` 是**正确**的；`216aff7` 新增 KB 文件挂载时，
把 `external/name` 整块**错粘到了 `kb-files`** 上，`pg-data` 退化成裸声明。后果两条：

1. compose 重建 pg 时会去找/新建 `reactor-desktop_pg-data`（**空卷**）→ 811 用户、组织、模型、密钥看起来全没了（数据其实还在 `docker_pg-data`，只是没挂上）。
2. `docker_pg-data` 会被 identity 挂成 `/app/data/kb-files`，也就是让它对着 **postgres 的数据目录**读写。

修法即现在文件里的写法：`pg-data` 指回 external `docker_pg-data`，`kb-files` 独立成 compose 管理卷。

### 7.2 identity 的 `environment:` 重复定义（compose 根本解析不了）

同一提交另起了一个 `environment:` 块来放 `REACTOR_KB_FILE_DIR`，于是同一个服务里 `environment` 键出现两次：

```
failed to parse …/compose.yml: mapping key "environment" already defined at line 84
```

这份 compose 因此**从未成功部署过**（运行中的容器是更早版本创建的，所以现象是"文件改了但环境没变"）。
即便换用宽容的解析器（取后一块），也会把 `REACTOR_DB_URL` / `REACTOR_LDAP_URL` / `REACTOR_GATEWAY_HOST` 覆盖掉，
容器内 identity 会退回去连 `127.0.0.1` 而必然连不上。已合并为单个 `environment` 块。

### 7.3 pg 宿主端口 55432 vs 15432

见 §3 的说明：`55432` 在 Windows 保留端口段内，绑定必失败。已改到 `15432` 并只绑回环。

---

## 8. 已修复：知识库「文档清单」必 500（搬迁前就存在，**已同步修旧仓**）

**症状**：`GET /v1/kb/datasets/:id/documents` 100% 返回 500，`kb-server-smoke` 在 37 项断言后红在这一步。

**证据**：拿产物里的真实函数复现，得到 PG `42883` `operator does not exist: bigint = text`（position 439，与冒烟一致）。

**根因**：`listDocumentsPaged()` 里两套占位符编号撞车——过滤条件从 `$1` 开始编号（`d.dataset_id = $1`），
而 `visibilitySql()` 固定占用 `$1~$3`（role/deptId/uid），实际传参是 `[...visParams, ...params]`，
于是 `$1` 绑成角色字符串去和 `bigint` 列比较。同文件 `loadSearchSegments()` 一直是正确写法（自身条件从 `$4` 起），可作对照。

**修法**（`datasets/repo.ts`）：过滤条件改为从 `$4` 起编号（`FILTER_BASE = 3`），列表与计数**共用同一个 WHERE**。

**`total` 口径的决定**：计数查询**也带**可见性谓词。理由：路由层虽然已先判库可见，但该文件自己写着
「SQL 层过滤是红线 ②，是纵深防御」——留着一条没有可见性约束的 COUNT，等于给未来绕过应用层的调用方留一个规模泄露口。
口径统一后 `total` 在正常路径上数值不变（库已可见），只多一层防护。两边 `repo.ts` 修改后 SHA256 一致，且两边冒烟均全绿。

**注意事项**：`kb-pure-smoke` 会**静态扫描** `repo.ts` 源码，断言每个 `visibilitySql(` 调用附近都有
「role/deptId/uid 打头」的参数组。改这类查询时保留 `const visParams = [...]` + `[...visParams, ...]` 的写法，
否则会踩到这条源契约断言。

