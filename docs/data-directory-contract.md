# 用户数据目录契约（Reactor）

> 适用范围：任何新增或修改「把文件写到用户 HOME 下」的代码之前，先读本文件。
> 相关实现：`packages/shared/src/user-data-dir.ts`、`packages/services/src/paths.ts`。
> 背景与阶段划分见 [REACTOR-REBRAND-PLAN.md](REACTOR-REBRAND-PLAN.md) 的 P3。

## 1. 唯一所有者

用户级数据目录名由 **`USER_DATA_DIR_NAME` 一个常量**拥有，别无第二处定义：

| 位置 | 角色 |
| --- | --- |
| `packages/shared/src/user-data-dir.ts` | 唯一事实源 |
| `apps/zcode-cli/packages/telemetry/src/user-data-dir.ts` | 同值副本（该包刻意不依赖 `@zcode/shared`） |
| `apps/zcode-cli/packages/debug/server/user-data-dir.ts` | 同值副本（同上） |

**不变式**：仓库里不允许再出现第二个字面量的用户级目录名。要改目录名，只改这三处常量值（它们必须同时改），全仓用户级路径自动跟随。

常量值**含前导点**（当前 `".reactor-ds"`），与磁盘目录名一致，使每个引用点都是从 `.zcode` 到常量的 1:1 替换：`join(home, USER_DATA_DIR_NAME, ...)`。

## 2. 两族目录，边界明确

| 族 | 归属 | 写法 | 例子 |
| --- | --- | --- | --- |
| **用户级** | 本契约管辖 | `USER_DATA_DIR_NAME` | `~/.reactor-ds/v2/setting.json`、`~/.reactor-ds/cli/config.json`、`~/.reactor-ds/skills` |
| **工作区级** | 项目配置的产品语义 | 字面量 `.zcode`，**不要改** | `<repo>/.zcode/config.json`、`<repo>/.zcode/agents`、`<repo>/.zcode/workflows`、`<repo>/.zcode/plans` |

判定方法：看**基目录是谁**。

- 基目录是 `homedir()` / `resolveUserHomeDir()` / `getDataBaseDir()` / `ZCODE_HOME` / `storage.dir` → 用户级，用常量。
- 基目录是 `workingDirectory` / `workspacePath` / `workspaceRoot` / `cwd` → 工作区级，保持 `.zcode`。

一个函数同时服务两档时（如 `adapters/src/{commands,skills}/roots.ts` 的 `*ForBase`），**必须按作用域分别取目录名**，不能共用一个字面量。

## 3. 跨工具约定目录（保持原样）

这些不是 ZCode 的数据目录，而是跨工具约定或第三方的位置，**不使用本常量**：

- `~/.agents/` 与 `<repo>/.agents/`（AGENTS.md 生态的兼容目录）
- `~/.claude/`（`hooksService` 的 `claude` 来源）
- `.zcodeignore`、`.zcode-plugin/`、`.zcode-share/`、`.zcode/workflow-drafts/`（文件名/工作区目录，非用户数据根）
- 官方版 ZCode 应用自身的 Electron `appData`（如 `appData/ZCode`、`appData/ai.z.zcode`）——只作为**导入来源**被读取，不写入

## 4. 允许的覆盖项（优先级高于常量）

这些环境变量/配置是**用户显式指定**的，必须优先于常量；只在它们缺席时才回落到常量：

| 覆盖项 | 语义 |
| --- | --- |
| `ZCODE_DATA_BASE_DIR` | 数据基目录，用户数据根 = `{dataBaseDir}/{USER_DATA_DIR_NAME}` |
| `ZCODE_HOME` | 直接指定用户数据根（不再拼接常量） |
| `storage.dir`（CLI 用户配置） | 同上，配置形态 |
| `ZCODE_STORAGE_DIR` | 同上 |

**注意**：`DefaultRuntimeConfig.storage`（`contracts/src/config/index.ts`）与 `subagentStorage` 的回落值必须是同一个值——一处是 CLI 的 System 层默认配置，一处是读不到配置时的兜底，两者分叉会导致「配置说一个目录、实际写另一个目录」。

## 5. 失败语义

- 目录不存在 = 合理空状态，不是错误。用 `readFile`/`mkdir(recursive)` 的 `ENOENT` 判定，不要 `existsSync` 预检（会引入 TOCTOU 窗口，也阻塞服务线程）。
- 读不到旧目录（`~/.zcode`）**不删、不迁**：本产品不做数据迁移，官方版的数据保持原样。两个产品在同一台机器上并存互不干扰，是本契约的目标而非副作用。

## 6. 不在本契约范围（有意保留，勿当漏改处理）

| 位置 | 为什么保留 |
| --- | --- |
| 工作区内所有 `.zcode` | 项目配置语义，见第 2 节 |
| `mcpUserDirectory/legacy.ts` 的 `appData/ZCode`、`appData/ai.z.zcode` | 从官方版**导入**旧 MCP 配置的来源，改掉等于废掉该功能 |
| `scripts/zcode-distribution/installer.mjs` 的 `$HOME/.zcode/runtime` | 是**安装树**而非用户数据；迁移需要先决定用哪个目录名，并处理已安装 shim 的指向，属独立决策 |
| `~/.agents/**` | 跨工具约定目录 |

## 7. 验证

```bash
pnpm typecheck && pnpm lint && pnpm architecture:check --changed

# 字面量清零检查：下面这条不应命中任何「用户级」写法
git grep -nE '"(homedir\(\)|resolveUserHomeDir\([^)]*\)|getDataBaseDir\(\)|~)/?[^"]*\.zcode' \
  -- '*.ts' '*.tsx' '*.mjs' ':(exclude)*/node_modules/*'

# 运行时：数据必须落在新目录，且官方版目录不被写入
ls -d ~/.reactor-ds && ls ~/.zcode/v2 | wc -l
```
