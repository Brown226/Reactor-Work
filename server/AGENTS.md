# AGENTS.md — Reactor 服务端工作区（server/）

适用范围：本目录及其子目录。**本文件优先于仓库根的 `AGENTS.md`** —— 根文件描述的是主仓（二开的 ZCode 桌面/CLI 工作台），其中的 `pnpm typecheck`、`architecture:check`、`check-workspace-freshness.mjs`、模块边界与 `USER_DATA_DIR_NAME` 等规则**只管主仓，不管这里**。

## 边界

- 本目录是**独立 pnpm workspace**（自己的 `package.json`、`pnpm-workspace.yaml`、lockfile、`node_modules`），不在主仓 `pnpm-workspace.yaml` 的匹配范围内。
- 所有命令在本目录执行：`pnpm install` / `pnpm build` / `pnpm typecheck` / `pnpm --filter @reactor/server <script>`。
- 不要在主仓根执行 `pnpm install` 来"修"本目录的依赖，也不要把主仓的 lint/架构门禁套到这里。

## 不可随意改动的相对路径契约

改目录层级会直接打断三条契约（详见 `README.md` §1）：

1. `packages/server/src/identity/admin-static.ts` 用 `../../../admin/dist/` 定位管理台产物 ⇒ 管理台必须落在 `packages/admin`。
2. `packages/server/docker/compose.yml` 用 `context: ../../..`、`env_file: ../../../.env`、`dockerfile: packages/server/Dockerfile`。
3. `packages/server/scripts/*.mjs` 用 `../../../.env` 读配置。

## 强制验证

代码改动后必须实际执行并如实报告结果：

```bash
pnpm --filter @reactor/shared build      # 先建契约层（server 的 tsc 依赖它的 .d.ts）
pnpm build                               # = pnpm -r build，拓扑序自动先 shared 后 server
pnpm typecheck
```

行为改动优先补对应冒烟脚本（清单见 `README.md` §4），不要只靠类型通过就宣称可用。

## 安全

- 不在日志、示例、脚本或提交中写入凭据、真实用户数据与内网地址；上游 key、DB 口令、`REACTOR_SECRET_KEY`、LDAP 绑定口令一律走 `.env`（已 gitignore）。
- `docker/seed/employees.csv` 与 `seed.ldif` 含真实员工信息，**保持 gitignore**，不要 `git add -f`。
- `REACTOR_SECRET_KEY` 丢失 = 已加密的密钥永久不可解。任何涉及密钥封存（`common/secrets-crypto.ts`）的改动都要同时保证 `scripts/verify-secret-key.mjs` 通过。
- 数据卷在 `compose.yml` 里是 `external` 的历史卷（811 用户 / 807 员工），**任何 `docker compose down -v` 都会造成不可恢复的数据丢失**。

## 风格

- 沿用现有实现风格：文件头写清"为什么"，关键分支写"反例是什么"；中文注释。
- 单文件不要写成千行（现有最大文件约 400 行量级，新增逻辑优先拆分模块）。
- 跨模块只从公开入口导入；`src/<域>/routes.ts` 负责 HTTP 面，`repo.ts` 负责 SQL，`schema.ts` 负责建表——不要混层。
