# Reactor 对上游核心文件的补丁登记

原则：**能不改正本就不改正本**。优先用 `extension.Module`、`server.Run`、`MemberWriters`、
`AdminRegistrar` 等扩展缝；必须改核心文件时在此登记，说明原因、影响面和回归方式。

状态图例：`planned`（仅设计） / `applied`（已改） / `upstreamed`（已反馈上游） / `obsolete`（不再需要）。

| # | 文件 | 改动 | 原因 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | `backend/cmd/server/main.go`、`backend/reactor/member/writer.go` | `cmd/server` 改用 `app.NewWithMembers` 注入 `reactormember.NewWriters`；新增 `UserWriter` / `GroupWriter` 的 SQL 实现（初始管理员、用户 CRUD、邮箱注册、OAuth 身份、分组增删/移动） | 空库无法创建初始管理员，管理台创建用户/分组返回 `member_writer_unavailable` | applied |
| 2 | `backend/internal/identity/password.go`、`backend/internal/identity/service.go` | 增加 LDAP/AD 登录与 AD 同步；`verifyPassword` 兼容 Reactor 迁移用户的 bcrypt，并在首次登录后升级为 PBKDF2 | 保留现有域账号，避免 807 个本地账号全部重置 | planned |
| 3 | `backend/internal/proxy/proxy.go` | 把 User-Agent 门禁从固定 `ohmyagent` 改为可配置 allowlist（至少接受 Reactor/ZCode UA） | 当前非 ohmyagent 客户端一律 401，Reactor 无法走模型网关 | planned |
| 4 | `backend/internal/model` + 新迁移 | 模型 `api_key` 与 MCP 凭据改为信封加密（AES-256-GCM），密钥来自环境变量 | 上游明文落库，低于 Reactor 现有安全基线 | planned |
| 5 | `backend/internal/identity/service.go` | 可选：注册 `reactor-desktop` OAuth client（loopback redirect）；若复用 `monkeyai-desktop` 的 `http://127.0.0.1:<port>/oauth/callback` 则无需改 | 品牌与授权页文案；复用现成 client 可把改动降为零 | planned |
| 6 | `backend/internal/app/app.go` | 显式注册 Reactor 扩展模块：`updates`、`desktop-policy`、`standards`、`terminology`、`interface-mode`、`ldap-sync-logs` | 这些是 Reactor 生产功能，上游没有对应模块 | planned |
| 7 | `backend/Dockerfile`、`web/Dockerfile*` | 私有基础镜像替换为公共/内网镜像；构建参数化 | 当前 `chaitin-registry...` 在内网/离线环境不可获取 | planned |
| 8 | 新迁移 `000063_reactor_legacy_mapping` 等 | 增加 `legacy_uid` / `legacy_dept_id` 映射表，保留旧库主键关联 | 旧库用户 id 非 UUID，直接迁移会丢失外键语义 | planned |
| 9 | `backend/internal/kb/importkey.go` | Windows 跳过目录 `fsync` 与 POSIX 0600 权限位检查（文件内容仍 `Sync`） | Windows 上 `dir.Sync()` 返回 `Access is denied`，服务启动即退出 | applied |

## 变更记录

- 2026-11-27：创建本表；源码基线导入，尚未应用任何补丁。
- 2026-11-27：应用 #1（成员写入）与 #9（Windows 启动修复）；本地验证见 `README.md` §6。
