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
        ├── docker/compose.yml  # 一体化编排：pg + ldap + identity + gateway
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
| 提交面 | `POST /api/v1/feedback/ticket`、`GET /api/v1/feedback/ticket[/:id]`、`POST /api/v1/feedback/ticket/:id/message` | **公开**（Bearer 可选，验过才填报告人展示名） |
| 管理面 | `GET/PATCH /admin/feedback/tickets[/:id]`、`POST /admin/feedback/tickets/:id/messages` | Bearer + platform_admin |

提交面必须挂在 `identity/routes.ts` 的**公开段**：Reactor 用户只有企业账号、没有官方 `zcodejwttoken`，
挂进 authed 组会让本产品自己的上报全部 401（与更新下发面同一条理由）。

客户端接入由 `createFeedbackService` 的 `getApiBaseUrl` 完成（装配在 `services/src/node.ts`）：
企业登录后基址变为 `<serverUrl>/api/v1`；未配置企业服务端时回落官方后端，开源用法不受影响。
本地调试可用 `ZCODE_FEEDBACK_API_BASE` 硬覆盖（优先级最高）。

**一期不支持附件**：客户端上传走 OSS 直传凭证，本服务没有对象存储，`POST /feedback/attachment/upload-credential`
回 400 + `attachments_unsupported` 标记；客户端据此把「日志没传上去」降级成工单里的一条系统评论，
而不是把已建好的工单报成提交失败。正文、评论、状态流转不受影响。

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

# B. Docker 一体化（pg + ldap + identity + gateway 全在容器里）
pnpm docker:up          # = docker compose -f packages/server/docker/compose.yml up -d
pnpm docker:down        # 停止；**绝不加 -v**（数据卷是 external，加 -v 会丢 811 用户/807 员工）
```

> 数据卷中 `pg-data` / `ldap-data` / `ldap-config` 是 **external**，指回历史卷名（`docker_pg-data` 等）——换目录、改项目名都不会重建空卷；
> `kb-files` 是 compose 管理的卷（KB 上传件从未真正持久化过，见 §7.1）。

---

## 4. 冒烟与运维脚本

> ⚠ **必须在 `server/` 目录下执行**，且用 `node packages/server/scripts/…` 直接跑。
> 原因：多数脚本用裸 `process.loadEnvFile()` 读**当前工作目录**的 `.env`；而 `pnpm --filter @reactor/server` 会把
> cwd 切到包目录（`packages/server/`），那里没有 `.env`，脚本会静默回落到内置默认值 `127.0.0.1:55432` 并连接失败。
> tsx 跑的两个脚本连 `loadEnvFile()` 都没有，要显式带 `--env-file=.env`。

```bash
cd server
node packages/server/scripts/identity-smoke.mjs                 # 其余同名替换
./packages/server/node_modules/.bin/tsx --env-file=.env packages/server/scripts/kb-server-smoke.ts
```

| 用途 | 脚本 |
|---|---|
| 网关端到端（**依赖未搬迁的 `packages/sidecar`，本工作区跑不了**） | `e2e-smoke.mjs` |
| 身份底座（登录/刷新/登出/同步） | `identity-smoke.mjs` |
| 组织与用户 | `org-smoke.mjs` |
| 管理台 API（供应商/密钥/模型） | `admin-smoke.mjs` |
| 管理台静态托管（含路径穿越反证） | `admin-static-smoke.mjs`（管理台产物缺失时会 SKIP 并以 0 退出；产物存在时 **6/6 通过**） |
| 网关鉴权 | `gateway-auth-smoke.mjs` |
| 技能市场 | `skills-smoke.mjs`、`skills-import.mjs` |
| Agent 目录 | `agents-smoke.mjs` |
| 审计与用量 | `audit-smoke.mjs`、`t34-smoke.mjs` |
| 公共知识库（纯函数 / 带服务端） | `kb-pure-smoke.ts`、`kb-server-smoke.ts` |
| 软件更新（建表/上传/manifest/Range/灰度/下线清理） | `updates-smoke.ts`（PG 不可达时 SKIP 并以 0 退出） |
| 反馈与需求（公开提交面 / 管理受理 / wire 格式 / 红点与事件） | `feedback-smoke.ts`（**24 项全绿**；自读 `../../../.env`，PG 不可达时 SKIP 并以 0 退出） |
| 向量化走网关（自带 mock 上游） | `gateway-embeddings-smoke.ts` |
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
- 主仓是二开的 ZCode 桌面/CLI 工作台（品牌已改为 Reactor）；本目录是它的**服务端**。两者目前**尚未接线**——桌面端还没有登录、拿 token、拉取服务端下发的技能/Agent 的能力，这是下一步要做的事。
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

