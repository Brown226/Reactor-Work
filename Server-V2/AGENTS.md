# AGENTS.md — Server-V2

适用范围：本目录及其子目录。**本文件优先于仓库根 `AGENTS.md`**：根文件描述的是
Reactor-Work 主仓（Electron/React/pnpm），其中的 `pnpm typecheck`、`architecture:check`、
`check-workspace-freshness.mjs`、`USER_DATA_DIR_NAME` 等规则不管本目录。

本目录是 Reactor 的新服务端基线，源代码来自 MonkeyAI（AGPL-3.0，见 `LICENSE` 与
`NOTICE.md`），允许按 `REACTOR-PATCHES.md` 的登记方式改造。

## 1. 边界

- `backend/` 是 Go 模块（`go 1.27`），`web/` 是独立的 pnpm 项目（Node 24 / pnpm 10）。
- 本目录不是根 pnpm workspace 的成员；不要在主仓根执行 `pnpm install` 来修这里的依赖。
- 上游核心代码与 Reactor 定制必须可区分：
  - Reactor 专属逻辑优先放在 `backend/reactor/`（新建包）。
  - 必须改上游核心文件时，逐条登记到 `REACTOR-PATCHES.md`，写清原因、回归测试、
    上游同步风险。
  - 不得在核心包里直接写 Reactor 品牌、员工数据、内网地址或一次性迁移逻辑。

## 2. 命令

```bash
# 后端
cd backend
go build ./...
go test ./...
go vet ./...
make check            # sqlc 校验 + 全量测试 + vet
make generate         # 修改 schema/query.sql 后重新生成 sqlc

# 管理台
cd web
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

数据库迁移使用 `golang-migrate`：

```bash
migrate -path backend/migrations -database "$MONKEYAI_DATABASE_URL" up
```

**迁移只追加**：已发布的 `*.up.sql` / `*.down.sql` 不得改写；新变更使用
`migrate create -ext sql -dir migrations -seq <feature>_<action>` 生成六位递增序号。

## 3. 架构约束

- 一个业务目录一个包，包含业务对象、服务、HTTP handler、数据访问和测试；不建
  `pkg/`、`utils/`、`common/` 大杂烩。
- `cmd/server` 只负责启动；依赖组装集中在 `internal/app`。
- Admin API（`/api/admin/v1`）与 Agent API（`/api/v1`）只共享业务服务，不共享请求 DTO。
- 跨包依赖用使用方定义的小接口；禁止循环依赖。
- HTTP DTO 不直接充当业务对象。
- 宿主扩展走 `extension.Module` / `extension.Bindings` / `extension.Services`；
  不要为 Reactor 需求修改 `internal/app` 的公共装配顺序，除非别无他法。
- 成员/分组写入走 `member.UserWriter` / `member.GroupWriter`；不要在 handler 里直接
  写 `users` / `group_users` 表绕过它。

## 4. Reactor 适配的安全红线

- 模型密钥、MCP 凭据、OAuth client secret 不得明文落库或写日志；上游 `models.api_key`
  当前是明文，改造完成前不得把真实生产密钥迁入。
- 不把 `REACTOR_SECRET_KEY`、LDAP 绑定口令、数据库口令写入示例、测试或提交。
- 日志遵循上游 `logging` 包；不要在循环里逐请求打印正文或凭据。
- 远程执行/终端/文件代理沿用上游的签名、租约、来源校验；不得为联调方便放宽
  Origin、scope、路径或文件授权检查。

## 5. 验证口径

- 后端改动：`go build ./...`、`go vet ./...`、受影响包的 `go test ./...`。
- 管理台改动：`pnpm typecheck`、`pnpm build`；涉及交互的页面补浏览器验收脚本。
- 涉及迁移：在全新数据库执行 `up`，再执行 `down -all` + `up`，确认可重建。
- 涉及 Reactor 兼容/数据迁移：必须提供可重复的 dry-run 脚本与回滚步骤。
- 未执行的验证要如实说明，不能把"类型通过"当作"行为可用"。

## 6. 与主仓的关系

- 主仓桌面端通过 HTTP/WS 访问本服务；本目录不依赖主仓的 TypeScript 源码。
- 旧服务端 `server/`（TS）在切换完成前保持可运行；数据迁移与双跑方案见
  `docs/未完成/未完成-服务端替换-MonkeyAI-方案-v1.md`。
