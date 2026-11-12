# WEB 端每浏览器登录会话与多用户隔离（spec v1）

> 状态：代码已落地，待运行时验证（开发机为 Windows，未跑 Linux 容器双账号 E2E）
> 日期：2026-11-02
> 关联：`docs/未完成-模型直连分流-解决上游IP并发限制-spec-v1.md`、
> `docs/未完成-WEB端功能增强与验证计划-v1.md`、
> `docs/已完成/已完成-企业provider可见性与登录自愈-spec-v1.md`

## 1. 目标

把 Web 端从「部署级共享令牌 + 进程级单登录态」改成「每浏览器一条登录会话 +
每 uid 一个独立 worker」：

1. 用户打开 `http://host:3030` 只看到企业账号登录页，不再输入 `REACTOR_WEB_TOKEN`。
2. 每个浏览器持有独立会话；两个账号同时在线时，工作区、模型、凭据、终端互不覆盖。
3. `/api/*` 与 `/ws` 的身份只来自会话，不再接受 `?uid=` / body `uid`。
4. 文件系统沙箱继续生效：agent、MCP、终端以该 uid 运行，host 只做会话路由。

## 2. 非目标

- 不做账号注册、找回密码、MFA；这些仍由 identity 负责。
- 不做跨容器调度；每个 Web 容器仍然自己承载当前在线用户。
- 不改变 Desktop / `zcode-server-cli` 的 stdio 登录方式。
- 不把旧共享会话自动猜给某个用户（旧表没有 uid，见 §8）。

## 3. 现状与问题

| 位置                                        | 现状                                  | 后果                                 |
| ------------------------------------------- | ------------------------------------- | ------------------------------------ |
| `packages/server/src/http.ts`               | `zcode_lite_token` 共享 Cookie        | 拿到令牌就是当前登录用户             |
| `packages/server/src/user-workspace.ts`     | `currentLoginUid` 进程单值            | 后登录者覆盖前登录者                 |
| `packages/server/src/user-space/request.ts` | `?uid=` 优先                          | 知道工号即可跨用户读空间             |
| `packages/services/src/node.ts`             | 全局单份 Reactor 凭据 / provider 配置 | 两个账号的模型与 direct key 互相覆盖 |
| `/api/rpc-host-capability` + `/ws/host`     | 共享令牌即可申请                      | 可冒充 Desktop trusted host          |

## 4. 目标架构

```text
浏览器 A ──HTTP/WS──┐
                     ├─ Web 网关（root，单进程）
浏览器 B ──HTTP/WS──┘   ├─ 会话表 / 登录 / 登出 / 静态资源
                        ├─ /api/user-workspace、/api/space：按 session.uid 路由
                        └─ /ws：校验会话后桥接到该 uid 的 worker
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
            worker(uid=A)                worker(uid=B)
            root 派生，运行身份 A          root 派生，运行身份 B
            独立 HOME / DATA / 凭据        独立 HOME / DATA / 凭据
            独立 agent / MCP / 终端        独立 agent / MCP / 终端
```

### 4.1 状态所有权

| 状态             | 唯一所有者                               | 说明                                                                 |
| ---------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| 浏览器会话       | Web 网关 `WebSessionStore`               | sid 只存哈希，Cookie 只放随机 sid                                    |
| 企业登录令牌     | 该 uid 的 worker `IReactorServerService` | 网关不保存 access/refresh token                                      |
| 工作区路径       | Web 网关                                 | `session.uid → /data/users/<uid>`                                    |
| 用户 UID 映射    | `webUserSandbox`                         | 企业 uid → 数字 UID，持久化在 `/data/.reactor/web-user-uid-map.json` |
| agent / 终端进程 | 该 uid 的 worker                         | OS 层以数字 UID 运行                                                 |
| 旧共享令牌       | 无（仅保留兼容开关）                     | 新部署不再下发                                                       |

### 4.2 worker 生命周期

- 首次登录或首个 `/ws` 请求时启动；同一 uid 单飞，不重复启动。
- worker 以 `setpriv --reuid <uid> --regid <uid> --clear-groups` 运行，环境：
  `HOME=/data/homes/<uid>`、`ZCODE_DATA_BASE_DIR=/data/homes/<uid>`、
  `ZCODE_DATA_SCOPE=local`（home 已按 uid 隔离，不再切子目录）、
  `ZCODE_WEB_USER_SANDBOX=0`、`ZCODE_WEB_WORKER=1`。
- worker 只监听 `127.0.0.1:<随机端口>`，使用一次性随机 `ZCODE_SERVER_AUTH_TOKEN`；
  浏览器永远不接触该端口或 token。
- 空闲 30 分钟且没有活动 WS 时停止；下次请求重新拉起，登录态从 worker 自己的
  凭据文件恢复。
- 崩溃后从注册表移除；下一次 `/ws` 重新启动。进行中的任务会丢失，按现有
  agent 崩溃语义处理。

## 5. 数据模型

`/data/.reactor/web-sessions/sessions.sqlite`（root 0700）：

```sql
CREATE TABLE web_sessions (
  sid_hash TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX idx_web_sessions_uid ON web_sessions(uid, revoked_at, expires_at);
```

- `sid`：32 字节随机数 base64url；只存 SHA-256。
- TTL：`REACTOR_WEB_SESSION_TTL_SECONDS`，默认 7 天，固定有效（不做无上限滑动）。
- Cookie：`zcode_web_session`，`HttpOnly; SameSite=Lax; Path=/`；
  `REACTOR_WEB_COOKIE_SECURE=1` 时加 `Secure`。
- 登录成功轮换 sid；登出只吊销当前 sid。

## 6. 接口

| 方法与路径                             | 鉴权 | 行为                                                               |
| -------------------------------------- | ---- | ------------------------------------------------------------------ |
| `POST /api/auth/login`                 | 公开 | 调 identity 登录 → 确保 worker → worker 登录 → 建会话 → Set-Cookie |
| `GET /api/auth/session`                | 会话 | 返回 `{user:{uid,username}}`；无会话 401                           |
| `POST /api/auth/logout`                | 会话 | 吊销当前 sid；该 uid 无剩余会话时停 worker                         |
| `GET /api/server-info`                 | 公开 | 未登录返回 `workspaces: []`；已登录返回该 uid 工作区               |
| `/api/user-workspace`、`/api/space/*`  | 会话 | uid 只取 `session.uid`                                             |
| `/ws`                                  | 会话 | 桥接到该 uid 的 worker `/ws`                                       |
| `/api/space/shared/*`                  | 公开 | 保持现状：share token + 过期 + 口令                                |
| `/api/rpc-host-capability`、`/ws/host` | 会话 | 会话模式下 403，不再向浏览器开放 trusted host                      |

### 6.1 登录事件序

```text
浏览器 POST /api/auth/login
  → 网关调 identity /auth/login（拿 uid，不落企业 token）
  → 网关 ensureWorker(uid)
  → 网关调 worker /api/internal/reactor-login（worker 内 IReactorServerService.login）
  → 校验 worker status.user.uid === identity uid
  → 网关写 session + Set-Cookie
  → 浏览器 reload
  → GET /api/auth/session 200
  → GET /api/server-info 返回 /data/users/<uid>
  → /ws 校验 session → 桥接 worker
```

**取舍**：v1 会调用两次 identity 登录（网关一次、worker 一次）。网关只取 uid，
企业 token 只存在 worker；后续可加 `adoptSession(tokens)` 消掉重复登录。

## 7. 隔离与安全不变量

1. 浏览器请求不得携带 uid 作为身份；`?uid=` / body `uid` 在会话模式下忽略并记 warn。
2. worker 只能服务自己的 uid；启动时把 workspace 固定为 `/data/users/<uid>`，
   对请求里的其他路径 fail-closed。
3. worker 以数字 UID 运行，`/data/.reactor`、其他用户目录、其他 home 均不可读。
4. 网关不保存企业 access/refresh token；worker 停掉后凭据只在其 home 内。
5. 会话模式下不签发 host capability；`/ws/host` 直接 403。
6. 状态变更请求校验 `Origin` / `Sec-Fetch-Site`；跨站拒绝。
7. 登录失败按 `IP + username` 限流（5 次 / 15 分钟）；日志不打印密码与 token。
8. 用量/审计归属由 worker 自己的 `IReactorServerService` 持有，不再跨账号串。

## 8. 旧数据迁移

- 旧共享会话库 `/data/.reactor/cli/db` 与旧 tasks-index 没有 uid 列，无法可靠
  自动拆分到多个用户。
- v1 提供手动迁移脚本：`node scripts/migrate-web-user-data.mjs --uid <uid> [--source <旧库>] [--workspace <旧工作区>]`；
  管理员明确指定归属，脚本只做复制/备份，不删除旧库。
- 未迁移前，老用户看不到旧任务；部署说明必须写明，避免被当成数据丢失。

## 9. 失败语义

| 场景                         | 行为                                                |
| ---------------------------- | --------------------------------------------------- |
| identity 登录失败            | 401/502，不建会话                                   |
| worker 启动失败              | 502，不建会话；网关日志带 uid 与 worker stderr 尾部 |
| worker 登录成功但 uid 不一致 | 立即 worker logout，拒绝建会话                      |
| 会话过期/被吊销              | `/api/*` 401；`/ws` 以 4401 关闭                    |
| worker 崩溃                  | `/ws` 以 1011 关闭；前端重新探测会话                |
| 会话有效但 worker 已登出     | `/ws` 校验 worker status 后吊销会话并 4401          |

**已知边界**：如果页面已经打开、worker 在页面存活期间失登录（例如 refresh 失效），
应用可能先渲染应用内企业登录页；下一次刷新时网关会通过 `/api/auth/session` 吊销会话
并回到网关登录页。v1 不额外拦截这个瞬时窗口。

## 10. 验收场景

1. 两个浏览器分别登录 A/B：各自 `/api/server-info` 工作区为 `/data/users/A`、`/data/users/B`；
   A 的 `/api/space?uid=B` 不再能读 B。
2. A/B 同时挂着 WS：A 的模型清单、终端 `id`、工作区文件均属于 A；B 同理。
3. A 登出：B 不受影响；A 的 worker 在无剩余会话后停止。
4. 网关重启：会话 Cookie 仍有效，`/ws` 重新拉起 worker，worker 从本地凭据恢复登录。
5. 伪造/过期 sid：`/api/*` 401，`/ws` 4401。
6. 不带 Cookie 访问 `/ws`、`/api/user-workspace`：401。
7. 跨站 POST `/api/auth/login` 以外的受保护接口：403。
8. `/api/rpc-host-capability`、`/ws/host`：403。
9. 旧共享令牌部署（未开 `REACTOR_WEB_SESSION_AUTH`）行为不变。

## 11. 实施阶段

1. **会话层**：session store、Cookie、登录/登出/会话接口、限流、CSRF。
2. **身份贯穿**：`/api/server-info`、user-workspace、user-space 改为 session uid；
   删除显式 uid 身份。
3. **worker 隔离**：worker 注册表、UID 沙箱准备、内部登录/状态/登出接口、WS 桥。
4. **前端**：登录页替代共享令牌页；401 回登录；旧令牌页仅保留兼容。
5. **部署**：compose/Dockerfile/部署说明；镜像 tag 与 `1.1.1` 对齐。
6. **验证**：session store 单测、双浏览器双账号 E2E、跨用户读取、重启、登出。

## 12. 回滚

- 保留 `REACTOR_WEB_SESSION_AUTH` 开关；关闭时回到共享令牌模式。
- 新会话表与 worker 目录独立，不回写旧库；回滚只需换镜像并恢复旧 `REACTOR_WEB_TOKEN`。
- 迁移脚本只复制不删除；回滚后旧库仍可用。

## 13. 当前验证证据（2026-11-02 / 2026-11-03）

| 验证                                 | 结果                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `pnpm typecheck`                     | 通过                                                                                     |
| `pnpm lint`                          | 0 error（全仓既有 81 warning）                                                           |
| `pnpm --filter @zcode/server test`   | 6/6 通过                                                                                 |
| `pnpm architecture:check --changed`  | violations 0                                                                             |
| `pnpm --filter @zcode/server build`  | 通过                                                                                     |
| `pnpm --filter @zcode/web build`     | 通过                                                                                     |
| `node scripts/smoke-web-session.mjs` | `authRequired=true`、`workspaces=[]`、`/api/auth/session` 401、`/api/user-workspace` 401 |

**未验证**：Linux 容器内双账号/双浏览器 E2E（每 uid worker、WS 桥、`setpriv` 沙箱）。
开发机为 Windows，无法启动 Linux UID/`setpriv` 链路；需在部署机按 §10 验收场景实测。
