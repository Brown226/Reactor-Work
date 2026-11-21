# 桌面 Office 编辑器与人机双写 — 工作交接

- 交接日期：2026-11-21
- 当前阶段：**Phase 0（spec + 许可证已完成；构建 spike 首次失败，待重试；嵌入 spike 未开始；Phase 1 未开始）**
- 关联文档：
  - [产品 spec](未完成-桌面Office编辑器-人机双写-spec-v1.md)
  - [ADR-0005](../adr/0005-desktop-office-editor-embedding.md)

---

## 一、交接摘要

需求是桌面端「对话 + Office 文档并排，人直接编辑，AI 修改同一份文件，Word 改动记修订，冲突由人选择」。方案对比后选择 **C 桌面优先**：GenOffice 作编辑器内核，Main 用 `WebContentsView` 承载，文件写入由新增的 `DocumentEditService` 独占，AI 修改走 GenOffice MCP（打开时）或 CLI/OOXML（未打开时）。

已完成：需求/源码对比、方案选型、计划批准、spec、ADR、GenOffice 许可证核实、上游静态 spike。

未完成：GenOffice 构建与嵌入 spike、修订保真度/包体积实测、Phase 1 的 `DocumentEditService` 模块与 E2E 骨架。

---

## 二、已完成

### 1. 方案调研与选型

- 对比了 KnowWork 的 Office 在线编辑实现：GenOffice + 每人容器 + 商业扩展。
- 结论：KnowWork 的编辑器内核是第三方 GenOffice，不是自研；其 Web 容器架构不适合桌面优先的 Reactor。
- 选定路线 C：桌面内嵌编辑器 + 本机文件；AI 通过文档 API/OOXML/MCP 修改，Word 走修订。
- 详细对比见对话记录与 [产品 spec](未完成-桌面Office编辑器-人机双写-spec-v1.md) 的「核心决策」。

### 2. 计划与文档

| 交付物 | 路径 | 状态 |
| --- | --- | --- |
| 实施计划 | 已通过 `ExitPlanMode` 批准 | 完成 |
| 产品 spec | `docs/未完成-桌面Office编辑器-人机双写-spec-v1.md` | 完成 |
| ADR | `docs/adr/0005-desktop-office-editor-embedding.md` | 完成（Proposed） |
| 文档索引 | `docs/README.md` 增加 spec 条目、ADR 计数 4→5 | 完成 |

### 3. GenOffice 许可证与上游能力核实

| 项 | 结论 |
| --- | --- |
| 许可证 | **Apache-2.0**；`ee/` 目录保留企业许可，构建必须排除 |
| 商标 | GenOffice / Genspark 名称与 Logo 为 Mainfunc, Inc. 商标；README 明确 forks 应使用自己的品牌，分发必须换品牌 |
| 原生格式 | `.docx` / `.xlsx` / `.pptx` 原生读写；保存只重写被编辑块，其余字节保留 |
| 修订 | Docs 有完整 revision / accept / reject；AI ops 支持 `track: { author }` |
| CLI | `genoffice docs read/apply/compare`；`docs compare` 可生成 redline 修订 |
| MCP | `apps/shell/src/main/mcp/mcp-server.ts`：loopback HTTP，`/mcp` + `/sse`，默认端口 3093；可见编辑工具 `create_session` 等 |
| web/嵌入 | **上游没有** `GENOFFICE_WEB` / `--web-only`；需 KnowWork 补丁 1/2/4 |
| 外部 MCP 修订 | **上游默认不记修订**：`mcp-bridge.ts` 调 `executeTool` 不传 `track`；KnowWork 补丁 3 增加 `track: true` / `author` |
| 安全 | 主窗口 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；control socket 只支持 open/selection |

### 4. 静态 spike 产物

| 产物 | 路径 | 说明 |
| --- | --- | --- |
| GenOffice 浅克隆 | `C:\Work\tmp\genoffice-spike` | 154 MB，只读检查用，未运行上游代码 |
| KnowWork 补丁集 | `开源参考项目/KnowWork-main/deploy/docker/office/patches/0001-0005` | Apache-2.0，可复用；需 rebase |
| Office Dockerfile | `开源参考项目/KnowWork-main/deploy/docker/office.Dockerfile` | GenOffice 固定 commit + 5 补丁 + xvfb 运行 |
| 构建日志 | `C:\Work\tmp\knowwork-office-build.log` | 首次构建 `knowwork-office:spike` 失败，日志保留；失败原因见下 |

### 5. 文档门禁

- `pnpm docs:stale-phrases:check`：通过（2370 个文件）。
- `pnpm fmt:check`：**失败，但不是本次文档导致**。失败来自未跟踪的 `开源参考项目/EvoFlow-1.3.40` 内的 JSON/HTML 语法错误；`oxfmt` 扫描了整个仓库。
- `pnpm architecture:check --changed`：通过（0 violations）。

---

## 三、关键结论（接手必读）

1. **GenOffice 是内核，不是成品。** 上游具备原生格式、修订、CLI、MCP，但没有 web/嵌入模式；外部 MCP 命令默认不记修订。桌面并排体验依赖 KnowWork 的 web/embedded 补丁与 `track`/`author` 补丁，**补丁是硬依赖**。
2. **补丁来源与许可。** KnowWork 仓库 Apache-2.0；补丁基于 GenOffice 的 PR #2283 commit（`2a1735d...`）。上游不收这些补丁，升级需 rebase。
3. **唯一写入者。** `DocumentEditService` 拥有文件租约、版本、备份、冲突与幂等；编辑器保存、AI 修改、另存为、外部改动检测都经它。
4. **AI 修改两条路。** 文档开着走 GenOffice HTTP MCP，带 `track: true` + `author: "显示名（AI）"`；文档没开走 `genoffice` CLI/OOXML，生成修订后原子写回。
5. **冲突不静默。** 只做打开、保存、轮末三个检查点；AI 改过且人未保存时，必须由人选择「载入 AI 版本 / 保留我的」。
6. **范围。** 本期只支持本地 workspace；远程 workspace、Web/多用户容器版、移动端编辑、实时多人协同都不做。

---

## 四、未完成 / 阻塞

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Docker 构建 `knowwork-office:spike` | **失败（exit code 1）** | 卡在拉取 `node:24.18.0-bookworm` 的 1.25 MB 层（约 1786 秒无进展），未生成镜像；日志：`C:\Work\tmp\knowwork-office-build.log` |
| 嵌入 spike | 未开始 | 需要构建成功后在容器里验证 web UI 与 MCP |
| 修订保真度 spike | 未开始 | 真实 docx 的表格/批注/脚注/复杂格式 |
| 包体积实测 | 未开始 | 镜像/安装包体积、按平台拆分策略 |
| 跨平台构建 | 未开始 | Windows 本机缺 Rust；macOS/Linux 未验证 |
| Phase 1 `DocumentEditService` | 未开始 | 模块、契约、租约/版本/备份、E2E 骨架 |
| Phase 2–5 | 未开始 | 见 spec 分期表 |

---

## 五、下一步（按优先级）

### P0：完成构建/嵌入 spike

1. **首次构建结果（2026-11-21）：失败，exit code 1，未生成镜像。**
   - `source` 阶段卡在拉取 `node:24.18.0-bookworm` 的 `sha256:1b351d...`（1.25 MB）约 1786 秒，Docker Hub 网络无进展；
   - `runtime` 阶段的 apt 安装已完成，构建缓存可复用；
   - 日志：`C:\Work\tmp\knowwork-office-build.log`；当前 Docker 构建缓存约 26.6 GB（可回收 19.4 GB）。
2. **重试构建：**
   ```bash
   # 先单独拉取基础镜像（可重试）；或从可用镜像源拉取后打回原名
   docker pull node:24.18.0-bookworm
   # 如直连失败，使用镜像源并重跑（不修改 Dockerfile）
   docker build -f deploy/docker/office.Dockerfile \
     --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24.18.0-bookworm \
     -t knowwork-office:spike .
   ```
   - 也可在 CI 或网络可靠的 Linux 构建机上执行同一 Dockerfile；
   - 若仍卡住，按 `UPSTREAM` 的 commit 浅取 + `git am` 补丁，改用镜像源/代理；
   - 重试结果与失败原因继续记录到本文件。
3. **构建成功后**启动容器验证：
   ```bash
   docker run --rm -p 8931:8931 -p 8932:8932 \
     -e KNOWWORK_OFFICE_MCP_TOKEN=dev-token-0123456789 \
     knowwork-office:spike
   ```
   - 打开 `http://127.0.0.1:8931`，确认编辑器加载。
   - 用 MCP 客户端连 `http://127.0.0.1:8932`，调 `create_session` 打开一个 docx，再调 `run_tool` 带 `track: true` / `author`，确认生成修订。

### P1：Phase 1 模块骨架

1. 先读 `architecture-policy.yaml` 与 `pnpm architecture:context` 相关模块。
2. 注册新模块：
   ```bash
   pnpm architecture:adopt document-editing \
     --root packages/services/src/document-editing \
     --layer app \
     --owner conversation
   ```
3. 填 `contract.ts` / `CONTRACT.md`，只暴露 spec 里的 `open/close/save/applyAiEdit/selection/changes/discardEdits/recover`。
4. 先写 E2E 骨架（`packages/desktop/test/e2e/ui-shell/panels/manual-review/pending/`），再实现。
5. 租约/版本/备份/冲突按 spec 的「状态所有权与事件顺序」实现；写盘原子、写前备份、路径严格相对化。

### P2：编辑器宿主

- Main 的 `WebContentsView`、子进程 supervisor、独立 partition、bounds 同步、崩溃恢复。
- 侧边面板 tab、文件树/对话卡片打开、未保存关闭确认。
- 参考 `packages/desktop/src/main/pluginSandbox/CONTRACT.md` 与 browser-use 的 view 管理。

---

## 六、环境与工作区注意事项

- Node 24.14、pnpm 10.33、Docker 29.9（Linux 容器）可用。
- **本机没有 Rust**；GenOffice 完整构建需要 Rust + 平台原生工具链，建议用 Docker/CI。
- 工作区有**与本任务无关的本地改动**（engineering、i18n、server 等，见 `git status`）；交接时不要回滚、不要 `git checkout .`。
- `开源参考项目/` 是未跟踪的参考资料，不要提交；`C:\Work\tmp\genoffice-spike` 在仓库外，可随时删除重建。
- `pnpm fmt:check` 会被 `开源参考项目/EvoFlow-1.3.40` 的坏 JSON/HTML 拖失败；这是既有问题，不要通过删除参考项目来“修复”。
- 分发/构建时必须排除 GenOffice `ee/` 目录，并移除 GenOffice/Genspark 名称与 Logo。

---

## 七、验证命令速查

```bash
# 基线
node scripts/check-workspace-freshness.mjs

# 文档
pnpm docs:stale-phrases:check

# 架构
pnpm architecture:check --changed

# 构建 spike
cd 开源参考项目/KnowWork-main
docker build -f deploy/docker/office.Dockerfile -t knowwork-office:spike .

# 代码门禁（Phase 1 之后）
pnpm typecheck
pnpm lint

# Desktop E2E（Phase 2 之后）
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/ui-shell/panels/document-editor-open-save.test.ts'
```

---

## 八、待决问题

1. 编辑器随包分发还是首次使用下载？取决于 Phase 0 实测体积与目标客户离线要求。
2. 首批平台是否只做 Windows？建议 Windows 先行，macOS 紧随。
3. KnowWork 补丁最小集：web 模式 + 嵌入式 + `track`/`author` 是否足够；patch 3 的 `run_docx_tool` 是否全量复用。
4. 版本快照保留策略与磁盘配额。
5. 远程 workspace 的后续方案（另立 spec）。

---

## 九、交接确认

| 项 | 填写 |
| --- | --- |
| 交接人 |  |
| 接手人 |  |
| 交接时间 | 2026-11-21 |
| 当前分支 | `main` |
| 未提交改动 | spec、ADR、docs/README；另有与本任务无关的既有本地改动 |
| 下一步负责人 |  |
