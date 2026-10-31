# Web 端每用户工作区与配额 spec v1

状态：**后端已落地**（`packages/server/src/user-workspace.ts` + `http.ts` 挂载），前端接入、上传链路改造与 `/ws` 鉴权（P2）均未做。
关联：`docs/未完成-WEB端功能增强与验证计划-v1.md` §4 P0/P2；部署形态见 `docs/未完成-管理端双平台运营看板-方案-v1.md` 与 `deploy/web/Dockerfile`（`ZCODE_DATA_BASE_DIR=/data`、`ZCODE_SERVER_WORKSPACE=/data/workspace`）。

## 1. 目标与方案

- 产品口径：总容量 20GB、每用户上限 1GB；产出与上传文件落用户自己的目录。
- B 方案：单容器多目录 —— 每个企业账号一个目录 `<REACTOR_WEB_WORKSPACE_ROOT>/<uid>/`（默认 `/data/users/<uid>/`），配额在应用层记账（**软限制**）。
- 共享工作区 `/api/server-info` 的旧字段（`workspaces[0]`，来自 `ZCODE_SERVER_WORKSPACE`）保持不变，兼容旧客户端；仅追加 `userWorkspaceRoot` 能力发现字段。

## 2. 状态所有权与事件序

```text
浏览器登录 RPC（/ws → reactor-server 频道）
      │
      ▼
reactorServerService.login()                    ← @zcode/services 内 client.login 的唯一调用点
（packages/services/src/reactor-server/reactorServerService.ts:959）
      │ 成功返回 status.user.uid                  （packages/server 侧包装该实例的 login/logout 做观察）
      ▼
user-workspace.ts「当前登录 uid」记录            ← 进程内单值，唯一所有者
      │ login 成功 → 覆盖写入；logout → 清空；无持久化（重启后由用户重新登录重建）
      ▼
POST /api/user-workspace · GET /api/user-workspace/usage
      │ uid 校验 → mkdir -p（仅 POST）→ 目录大小扫描
      ▼
<root>/<uid>/ 目录 + usedBytes（30s TTL 缓存 + in-flight 合并，所有者同模块）
```

- uid 记录、用量缓存的所有者都是 `user-workspace.ts`，不存在第二条写路径。
- 幂等边界：POST 重复调用等价（mkdir recursive 幂等）；记录 uid 覆盖语义幂等。
- 失败语义：uid 非法 → 400；无身份可用 → 401；建目录 IO 失败 → 500；用量扫描中单个条目不可读按 0 跳过（展示口径，不放大失败）。

## 3. 接口契约

### POST /api/user-workspace

请求：`{"uid": "u001"}`（uid 可省略；省略时使用服务端记录的当前登录 uid）。

响应 200：

```json
{
  "path": "/data/users/u001",
  "quotaBytes": 1073741824,
  "usedBytes": 52428800,
  "totalBytes": 21474836480,
  "overQuota": false
}
```

错误：400（uid 非法 / 请求体非 JSON）、401（请求未带 uid 且服务端无登录记录）、500（建目录失败）。

### GET /api/user-workspace/usage?uid=u001

同响应结构；只读（不创建目录），uid 省略时用登录记录。供 UI 轮询展示用量。

### GET /api/server-info（追加字段）

在既有响应上追加 `"userWorkspaceRoot": "/data/users"`。`packages/shared` 的 `ServerRemoteInfo` 未加该字段（本任务不碰 shared 包），JSON 追加字段对旧客户端向后兼容。

## 4. 配置

| env | 默认 | 说明 |
| --- | --- | --- |
| `REACTOR_WEB_WORKSPACE_ROOT` | `/data/users` | 每用户目录根（容器内 /data 卷） |
| `REACTOR_WEB_USER_QUOTA_BYTES` | `1073741824`（1GB） | 每用户软配额 |
| `REACTOR_WEB_TOTAL_QUOTA_BYTES` | `21474836480`（20GB） | 只做记录与告警口径，不做全盘硬控 |

非法 env 值 warn 一次后回退默认。uid 白名单：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，另做 resolve 后包含校验双保险（防路径穿越）。

## 5. 假设与限制（如实标注）

1. **uid 即身份（阶段一口径）**：`/ws` 无鉴权是独立 P0（计划 §4 P2）。显式传 uid（POST body / GET query）等于**可伪造后门**，任何客户端可报任意 uid 查/建别人目录；保留只为联调，接入登录身份后必须移除或收紧。两处响应与代码注释均标注此假设。
2. **软配额**：agent 与文件工具直接写盘、完全绕过本模块；`usedBytes`/`overQuota` 仅展示与提示口径，不做硬阻断。
3. **进程级单 uid 记录**：多浏览器并发登录时「后登录者覆盖」，单用户/演示形态正确；多用户正确性依赖 P2 鉴权落地后把 uid 绑定到连接而非进程。
4. **用量非实时**：30s TTL 缓存；扫描不跟随符号链接（防越界与成环），不可读条目跳过计 0。
5. `totalBytes`（20GB）只是记录与告警口径，服务端不做全盘强控。

## 6. 验收

- `pnpm typecheck` 全链通过；`pnpm exec oxlint packages/server/src` 0 error；`pnpm architecture:check --changed` 0 violation。
- 行为冒烟：dist 产物下验证目录创建幂等、非法 uid 400、无身份 401、用量扫描与缓存。
- 容器内端到端（真实登录 → 目录隔离 → 前端展示）待部署后补测。
