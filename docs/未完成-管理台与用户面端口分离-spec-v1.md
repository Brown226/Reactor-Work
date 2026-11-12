# 身份服务：管理台与用户面端口分离（spec v1）

状态：实现中（2026-10-22）
需求来源：大王 —— 用户登录连的端口 = 管理员开管理后台的端口（8791），普通用户有看到服务端地址/摸到管理台的风险，要求两个端口分开。

## 1. 问题确认（源码证据）

| 事实 | 证据 |
| --- | --- |
| 单进程单端口 8791 | `identity/config.ts:39 DEFAULT_IDENTITY_PORT = 8791`；`server.ts` 只 `serve()` 一次 |
| 管理台 SPA 就挂在 8791 的 `/console` | `admin-static.ts:28 ADMIN_MOUNT_PREFIX = "/console"` |
| 8791 根路径**主动跳转**到管理台 | `routes.ts:69 if (consoleMounted) app.get("/", c => c.redirect("/console/", 302))` |
| 管理 API `/admin/*` 就在 8791 上 | 101 处 `/admin` 路由 |
| 客户端从不调用 `/admin/*` | 全仓 grep `packages/{services,ui,client,shared}`、`apps/zcode-cli`：命中的 `/admin` 全是注释 |

结论：任何能访问 `http://<server>:8791/` 的用户都会被 302 送到管理台登录页，并且可以探测 `/admin/*`。

## 2. 关键约束（决定实现方式）

**约束 A：管理台与管理 API 不是干净分层。**

- 纯管理面：`/admin/*`
- **两边共用**：`/v1/kb/*`、`/desktop/*`、`/me/*`、`/auth/*`、`/users`、`/depts`
- `skills/routes.ts`、`agents/routes.ts` 在**同一个文件内**同时注册 `/admin/skills` 与 `/me/skills`

⇒ **不能按模块拆分**（拆模块会一并砍掉 `/me/skills` 等用户面功能），只能按**路径前缀**在装配层分离。

**约束 B：权限点扫描按「实际挂载后的路由表」清理不存在码。**

`permissions.ts: syncPermissions()` 会 `DELETE` 掉已不存在的权限码；`createPermissionsRoutes(db, () => app.routes.map(...))` 读的就是那个 app 的路由表。
⇒ 若用户面 app 缺 `/admin/*`，管理员在管理台点一次「扫描权限点」就会把全部 `admin:*` 权限码删掉。
⇒ **两个 app 必须都完整挂载全部业务路由**，用户面的 `/admin/*` 只能在**请求入口处拦截**，不能少挂。

**约束 C：客户端不区分端口。** 桌面端只认 `REACTOR_IDENTITY_URL`（`:8791`），本次不改客户端。

## 3. 方案：单进程双端口

```
8791  用户面（客户端连这个）  完整路由 + /admin/* → 404 + GET / → 404 + 不挂管理台 SPA
8792  管理面（管理员浏览器）  完整路由 + 管理台 SPA(/console) + GET / → 302 /console/
```

两个端口共享同一个进程、同一个 PG 连接池、同一套 ensureSchema。不新增进程、不新增镜像、不动客户端配置。

### 为什么不是双进程
双进程会各跑一遍 `ensureSchema`（十几张表并发建表有竞态）、各自一个连接池（资源翻倍），而 identity 的 DB 连接池上限只有 10。单进程双监听没有这些代价。

### 为什么不是 nginx 层做路径隔离
nginx 只能按 URL 路径分流，而管理台与用户面在 `/v1/kb/*`、`/desktop/*` 上**完全重叠**，路径无法区分；且 `GET /` 的 302 是进程内行为，nginx 拦不掉。

## 4. 状态所有者与接口

| 项 | 归属 |
| --- | --- |
| 是否挂管理台 SPA | `createIdentityApp` 的 `opts.adminSurface`（默认 `true`，保持既有行为） |
| 用户面 `/admin/*` 拦截 | 同函数内在**所有业务路由注册之前**注册的中间件：`adminSurface === false` ⇒ 直接 404，不 `next()` |
| 用户面 `GET /` | 不注册 302；落入 404（不暴露「这是一台 Reactor 服务」） |
| 端口配置 | `REACTOR_IDENTITY_PORT`（用户面，默认 8791）、`REACTOR_IDENTITY_ADMIN_PORT`（管理面，默认 8792） |
| 权限点扫描口径 | 始终以**管理面 app** 的完整路由表为准（两个 app 路由表本就相同，扫描结果不变） |

### 事件顺序（启动）
1. `ensureSchema` 等全部建表（只跑一次）
2. 构造 `adminApp = createIdentityApp(cfg, db, { adminDist, adminSurface: true })` 并挂全部路由
3. 构造 `userApp = createIdentityApp(cfg, db, { adminSurface: false })` 并挂全部路由
4. `serve(userApp, port 8791)`、`serve(adminApp, port 8792)`
5. 两个 server 任一 close 才真正停机（`stopIdentityServer` 关两个）

### 幂等边界
- 重复启动不会重复建表（既有 `ensureSchema` 幂等）
- 两个 app 共享同一 `db`，不产生第二套连接池
- `/admin/*` 拦截中间件不写任何状态，纯请求期判定

## 5. 验收场景

1. `GET http://<host>:8791/` → **404**（不再 302 到管理台）
2. `GET http://<host>:8791/console/` → **404**
3. `GET http://<host>:8791/admin/roles`（带合法 admin Bearer）→ **404**
4. `GET http://<host>:8792/` → **302 → /console/**（行为与改造前 8791 一致）
5. `GET http://<host>:8792/console/` → 200 index.html
6. `GET http://<host>:8792/admin/roles`（admin Bearer）→ 200
7. `POST http://<host>:8791/auth/login`（合法账号）→ 200，客户端登录不受影响
8. `GET http://<host>:8791/me`（Bearer）→ 200
9. `GET http://<host>:8791/v1/kb/health`（Bearer）→ 200（共用面不被误伤）
10. 管理台点「扫描权限点」→ `removed` 为 0，`admin:*` 权限码全部保留
11. `GET http://<host>:8791/desktop/policy`（Bearer）→ 200

## 6. 部署面同步

| 文件 | 改动 |
| --- | --- |
| `server/packages/server/src/identity/config.ts` | 新增 `adminPort` + `REACTOR_IDENTITY_ADMIN_PORT` |
| `server/packages/server/Dockerfile` | `EXPOSE 8790 8791 8792` |
| `server/packages/server/docker/compose.yml` | identity 增 `8792:8792` 映射（默认只绑 127.0.0.1，与 PG/LDAP 同口径） |
| `Reactor 服务端部署镜像/V1.0.5/config/compose.yml` | identity 增 `8792:8792`（内网部署版绑 0.0.0.0，由防火墙限定管理员网段） |
| `.env.example` | 增 `REACTOR_IDENTITY_ADMIN_PORT=8792` |
| 部署说明 | 增一节「管理台端口 8792 与访问控制建议」 |

> 仓库内 compose 的 identity 端口默认只绑 `127.0.0.1`（dev 口径），管理端口同样只绑回环更安全；离线部署版按内网需要绑 0.0.0.0，并在文档中要求用防火墙把 8792 限到管理员网段。

## 7. 安全说明（不夸大）

- 本次是**入口隔离**，不是密码学隔离：两个端口同一个 JWT 密钥、同一套鉴权。能访问 8792 且持有 admin 令牌的人仍然能进管理台。
- 真正的防护来自「8792 只对管理员网段开放」这一部署动作。代码侧能做到的是**不让普通用户从 8791 摸到管理台与管理 API**。
- 未改动：`/admin/*` 自身的 Bearer + `requireAdmin` 双重校验保持原样（纵深防御的第二层）。

## 8. 不做的事

- 不拆分成两个镜像 / 两个容器（约束 A + 双进程代价）
- 不改客户端 `REACTOR_IDENTITY_URL`
- 不改 `/v1/kb/*`、`/desktop/*`、`/me/*`、`/auth/*`、`/users`、`/depts` 的行为
- 不给 8792 单独配 JWT 密钥（会让两个端口的令牌互不通用，管理台登录链路需大改）
