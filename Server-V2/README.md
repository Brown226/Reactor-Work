# Reactor Server V2

本目录是 Reactor 的新服务端源码基线，来源于 MonkeyAI（MonkeyCode 仓库的 `monkeyai/` 子项目）。
当前状态：**源码基线已导入，尚未做 Reactor 适配**。适配方案与分期见仓库根目录
`docs/未完成/未完成-服务端替换-MonkeyAI-方案-v1.md`。

## 1. 来源与许可证

| 项 | 值 |
| --- | --- |
| 上游仓库 | <https://github.com/chaitin/MonkeyCode> |
| 上游路径 | `monkeyai/backend`、`monkeyai/web`、`monkeyai/design` |
| 导入日期 | 2026-11-27 |
| 导入方式 | 逐字节复制；`backend`、`web`、`docs/design` 已用 `diff -rq` 与上游核对一致 |
| 许可证 | GNU AGPL-3.0，见 [LICENSE](LICENSE) |
| 书面许可 | 由项目负责人另行归档；不得把许可正文、凭据或真实用户数据写入本目录 |

上游版权归 Chaitin（长亭科技）及 MonkeyCode 贡献者所有。对本目录的修改仍需遵守
[LICENSE](LICENSE)；如书面许可对 AGPL 义务另有约定，以书面许可为准。

## 2. 目录结构

```text
Server-V2/
├── backend/              # Go 服务端（控制面 + 模型代理 + 管理端 API）
│   ├── cmd/server/       # 唯一进程入口
│   ├── internal/         # 业务模块（identity/group/model/proxy/skill/...）
│   ├── migrations/       # PostgreSQL 迁移（只追加，不改已发布版本）
│   ├── extension/        # 宿主扩展接口（Module / Bindings / Services）
│   ├── member/           # 成员写入接口（UserWriter / GroupWriter）
│   ├── server/           # 可复用的 server.Run 入口
│   ├── api/              # OpenAPI 契约（admin.yaml / agent.yaml / host.yaml）
│   └── docs/             # 后端运行与日志说明
├── web/                  # 管理台 SPA（React 19 + Vite）
├── docs/design/          # 上游设计文档（远程执行协议、计费、KB、MCP 等）
├── docker-compose.yml    # 上游一体化编排（PostgreSQL + RustFS + backend + proxy + admin + nginx）
├── .env.example          # 上游环境变量模板
├── UPSTREAM-README.md    # 上游 MonkeyAI README 原文
├── REACTOR-PATCHES.md    # 对上游核心文件的补丁登记（必须维护）
└── AGENTS.md             # 本目录的开发约束
```

## 3. 技术栈与运行前提

| 领域 | 选型 |
| --- | --- |
| 语言 | Go 1.27 |
| HTTP | `net/http` + `chi/v5` |
| 数据库 | PostgreSQL 18 + pgvector（迁移由 `golang-migrate` 执行） |
| 对象存储 | S3 兼容（上游默认 RustFS） |
| 管理台 | React 19 + Vite + TypeScript |
| 进程角色 | `control`（管理/身份/资源）与 `proxy`（模型网关）分进程部署 |

上游 `docker-compose.yml` 使用 `chaitin-registry.cn-hangzhou.cr.aliyuncs.com` 的私有基础镜像，
内网/离线构建前需要替换为可获取的公共镜像或本地镜像仓库（见 `REACTOR-PATCHES.md`）。

## 4. 本地启动（上游方式）

```bash
cd Server-V2
cp .env.example .env
# 至少修改 POSTGRES_PASSWORD、RUSTFS_ACCESS_KEY、RUSTFS_SECRET_KEY、
# MONKEYAI_INITIAL_ADMIN_EMAIL、MONKEYAI_INITIAL_ADMIN_PASSWORD
docker compose up -d --build
```

也可以直接编译后端：

```bash
cd Server-V2/backend
go build ./cmd/server
go test ./...
```

管理台：

```bash
cd Server-V2/web
pnpm install
pnpm dev
```

> 注意：当前开源版 `cmd/server` 使用 `member.EmptyUserWriter`，初始管理员与成员创建会返回
> `member_writer_unavailable`。在完成 Reactor 的成员写入实现前，空库无法创建管理员；
> 这是已知阻塞项，详见 `REACTOR-PATCHES.md`。

## 5. Reactor 适配的已知阻塞

按优先级排列，每项都在 `REACTOR-PATCHES.md` 有对应条目：

1. **成员写入**：已补 `backend/reactor/member`，`cmd/server` 通过 `app.NewWithMembers` 注入；
   初始管理员、创建用户、创建分组、分组增删成员已在 Windows 本地验证。邮箱注册/OAuth 自动注册
   仍依赖同一 writer，未单独联调。
2. **LDAP/AD 缺失**：上游只有本地密码与 OIDC；Reactor 现有域账号需要补 Go 模块。
3. **模型网关客户端门禁**：`internal/proxy` 只接受 User-Agent 含 `ohmyagent` 的请求，Reactor
   需要放行自己的 UA（或改为可配置）。
4. **软件更新下发缺失**：上游没有 `/api/v1/releases/*` 与管理端发版页，需要移植 Reactor 的
   `updates` 模块。
5. **模型密钥落库方式**：上游 `models.api_key` 明文存储；Reactor 现在是 AES-256-GCM 封存，
   迁移前必须决定加密方案。
6. **桌面端契约重写**：桌面端企业接线（`packages/services/src/reactor-server/*` 等约 5.2k 行）
   要从旧 JWT/网关令牌改到 OAuth + API Key + `/api/v1/*`。
7. **Reactor 独有管理面**：标准库、术语库、界面模式策略、桌面策略、AD 同步日志需要移植为
   扩展模块或在管理台补页。

## 6. 本地启动验证（2026-11-27）

- PostgreSQL 16 + pgvector（`127.0.0.1:15433`）、RustFS（`127.0.0.1:19000`）、
  control `:8800`、proxy `:8801`；迁移到 `version=62` 通过。
- `/healthz`、`/readyz` 均返回 200；初始管理员由 `MONKEYAI_INITIAL_ADMIN_*` 创建。
- 管理台 API 验证通过：管理员登录、普通用户登录、创建用户、创建分组、设置/清空分组成员。
- 已知：control 启动时有一次周分区锁竞争（自动重试成功）；Windows 目录 fsync 由
  `internal/kb/importkey.go` 补丁跳过（见 `REACTOR-PATCHES.md` #9）。

## 7. 修改约定

- 优先使用上游提供的扩展缝：`extension.Module`、`server.Run`、`MemberWriters`、`AdminRegistrar`。
- Reactor 专属逻辑放在 `backend/reactor/`（新建包）或 `backend/internal/app` 的显式组装处；
  不得把业务规则塞进 `internal/identity`、`internal/proxy` 等核心包。
- 必须修改核心文件时，在 `REACTOR-PATCHES.md` 登记文件名、原因、回归测试与上游同步风险。
- 迁移只追加新版本，禁止改写已发布的 `migrations/*.up.sql` / `*.down.sql`。
- 不在本目录写入真实凭据、内网地址、员工数据；`.env` 已被 gitignore。

## 8. 上游文档

- [UPSTREAM-README.md](UPSTREAM-README.md)：上游 MonkeyAI README（部署、计费、远程执行等）。
- [backend/README.md](backend/README.md)：后端模块、技术栈、本地启动与运维。
- [backend/api/](backend/api/)：管理端 / Agent / Host 三份 OpenAPI 契约。
- [docs/design/](docs/design/)：远程执行协议、知识库、MCP、计费、云环境等设计文档。
