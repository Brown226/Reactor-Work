# Engineering MCP Runtime

工程软件（PKPM / BIMBase / AutoCAD 等）的连接与 Python 执行能力住在
`packages/services/src/engineering`，由 Agent 通过 MCP 调用。本文定义它如何
**随 CLI / 桌面端分发**，以及解析失败时的行为。

## 为什么不是插件

工程能力不是插件：

- 没有启用/禁用开关，也不进插件市场；
- 不需要用户手工写 `mcp.servers` 配置；
- 技能正文是产品能力的一部分，缺了模型会写出错误脚本（交叉打断、端点 z 这类坑不可推断）。

因此它和 `node_repl` 同属「内置 MCP 服务」，但技能归属不同：`node_repl` 的技能来自
Official plugin，工程技能来自 services 构建产物。

## 产物形态

```
<engineering root>/
  mcp-server-main.js      # 可执行入口（ESM）
  mcp-server.js           # 协议实现
  ...其余编译产物
  skills/<SkillName>/SKILL.md
```

约束：

- `dist/engineering` 只依赖 Node 内置模块（实测：`node:fs` / `node:path` / `node:child_process` 等，无第三方包）。
- 编译产物是 **ESM**，落点目录必须能解析为 ESM。glm 资源树没有 `package.json`，
  因此 stage 时必须写入 `{"type":"module"}`，否则 `import` 语句会被按 CJS 解析而崩溃。
- `skills/` 由 `packages/services/scripts/copy-engineering-skills.mjs` 从 src 拷贝，tsc 不会搬运。

## 解析规则

`resolveEngineeringRuntime()` 只做只读探测，不创建、不修改任何文件。

候选根（按优先级）：

1. `bundleBaseDirs()`：入口文件目录、bundle 自身 `__dirname`，各自向上回溯最多 6 层
   （`bootstrap/dist/app` → 仓库根需要 6 层，是实测下限）。
2. `process.cwd()`：**只看当前目录**，不向上回溯。

每个根依次尝试：

| 相对路径 | 适用形态 |
| --- | --- |
| `packages/services/dist/engineering` | monorepo 开发态 / 工作区根 |
| `packages/engineering` | 桌面 stage 后的 glm 资源树 |
| `engineering` | 与入口同级的扁平布局 |

命中条件（**两者都必须存在**，只有其一是残缺状态，按未命中处理）：

- `mcp-server-main.js`
- `skills/` 目录

上游回溯的目的仅是覆盖 monorepo 不同入口深度（`cli/dist`、`bootstrap/dist/app`、tsx 直跑 `src`）。
`cwd` 不作为回溯起点，避免把工作区里任意位置的同名目录当作内置能力。

## 注入点

### MCP 服务

注册名固定为 `engineering`，进入 `builtInMcpServers`：

```
configuredMcpServers = { ...pluginMcpServers, ...userConfig, ...builtInMcpServers }
```

即内置服务**优先级最高**，同名用户配置会被覆盖。这是有意为之：工程服务端的
启动参数（入口路径、`ELECTRON_RUN_AS_NODE`）必须与当前安装体一致，用户配置写错会直接连不上。

副作用：用户无法通过 `.zcode/config.json` 关闭工程服务。若后续需要开关，
应新增显式配置项（例如 `features.engineering`），不要依赖同名覆盖语义。

配置形状：

```ts
{
  type: "stdio",
  command: process.execPath,          // 桌面打包态是 ZCode Helper
  args: [<root>/mcp-server-main.js],
  env: { ELECTRON_RUN_AS_NODE: "1" }, // 缺它会误进 Electron main
  timeoutMs: 600_000,
}
```

权限模式与 Python 解释器由环境变量下发（`ZCODE_ENGINEERING_PERMISSION_MODE` /
`ZCODE_ENGINEERING_PYTHON`）；内置注入不设默认值，由 services 侧回落 `auto`。

### 技能根

以 `SkillRoot` 形式加入 `extraResolvedRoots`：

| 字段 | 值 |
| --- | --- |
| `path` | `<root>/skills` |
| `scope` | `system` |
| `source` | `bundled` |
| `priority` | `999_000` |

优先级低于插件根（`FIRST_PLUGIN_PRIORITY` 起步），高于 bundled skill pack（`1_000_000`）。
用户/项目/插件里的同名技能压过内置工程技能。

## 失败行为

| 情况 | 行为 |
| --- | --- |
| 产物缺失 | 不注册 MCP、不加技能根，`logger.warn` 一条（含缺失路径） |
| 只有入口没有 `skills/` | 同上，按未命中处理 |
| MCP 进程启动失败 | 由现有 MCP 连接层处理（连接失败对模型可见，不静默） |
| 技能正文引用缺失 | 不拦截加载；引用的 151 个 `references/` 尚未入库，属已知缺口 |

未命中不影响其他能力；`/workflow`、node_repl、插件都不依赖它。

## 打包

`packages/desktop/scripts/prepare-agent-node-bundle.mjs` 新增
`stageEngineeringRuntime()`：

1. 构建 `packages/services`（`tsc -b`），确保 `dist/engineering` 与技能资源为当前源码产物。
2. 拷贝 `dist/engineering/*` → `bundled-agents/<platform>/glm/packages/engineering/`。
3. 写入 `package.json`：`{"type":"module","private":true}`（ESM 解析依据）。
4. 断言 `mcp-server-main.js` 与 `skills/` 均存在，缺失即让打包失败（不做静默降级）。

开发态（`dev:desktop`）不经过 stage，依赖 `resolveEngineeringRuntime()` 从仓库路径直接命中。

## 已知限制

- **SEA 形态未覆盖**：`process.execPath` 不是 Node，无法指向外部脚本。SEA 需要把入口
  改为统一 host 入口或将产物内嵌为资产，本文不做。
- **远端工作区未覆盖**：远端主机的 stage 清单需要另行补充（与 prepare-prebuilds 对齐）。
- **技能引用未入库**：22 份技能正文引用的 151 个 `references/`、`scripts/` 文件当前全部缺失，
  技能可加载但引用无法解析。补齐方案见 `BKBM/分析文档/资产清单与方案映射.md`。

## 测试

- `packages/bootstrap/tests/engineering-runtime.test.ts`：解析命中、缺 `skills` 拒绝、
  入口深度回溯、`cwd` 不回溯。
- 接线：`create-app` 的 `builtInMcpServers` 含 `engineering`，且 skill roots 含工程根。
- 手动：MCP `initialize` / `tools/list` 返回 4 个工具（已有 `mcp-server-main.js` 直跑验证）。
