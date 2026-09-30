# Hooks

Hook 用来在特定事件时机自动执行动作——在会话开始时注入团队约束、在工具调用前做安全检查、在模型准备结束时校验产出。适合希望在会话、模型请求、工具调用和停止阶段自动执行检查、补充上下文或实施策略的插件开发者与项目维护者。

Hook 本质上是一个本地子进程协议：Reactor 向进程的 stdin 写入一行 JSON，进程通过退出码和 stdout JSON 返回结果。Hook 不会获得可直接调用 Reactor 模型的内部对象。

> **安全提示**：Hook 会执行本地代码。启用第三方插件前请审查其来源、`hooks/hooks.json` 和脚本。

## 执行顺序与事件

```text
新 session     → SessionStart
用户提交       → UserPromptSubmit → 主模型
主模型请求工具 → PreToolUse → 需要确认时 PermissionRequest → 执行工具
工具成功       → PostToolUse；工具失败 → PostToolUseFailure
主模型准备结束 → Stop → 结束，或注入反馈后继续主模型
```

| 事件 | matcher | 主要用途与效果 |
| --- | --- | --- |
| `SessionStart` | 匹配 `source`，常见值为 `startup` / `resume` / `clear` / `compact` | 首轮模型请求前初始化环境、注入项目约束或操作说明 |
| `UserPromptSubmit` | 不参与过滤，即使填写也会执行 | 模型调用前补充上下文，或阻断本次用户请求；不能改写原始 prompt |
| `PreToolUse` | 匹配工具名 | 允许、询问或拒绝工具；可完整替换工具输入，替换后会重新校验 schema |
| `PermissionRequest` | 匹配工具名 | 只在权限结果需要询问时触发；可允许、拒绝、更新输入或权限规则 |
| `PostToolUse` | 匹配工具名 | 工具成功后追加模型可见上下文；不能替换工具输出 |
| `PostToolUseFailure` | 匹配工具名 | 工具失败后追加恢复建议、诊断或重试约束 |
| `Stop` | 不参与过滤，即使填写也会执行 | 模型准备结束时检查结果；返回 block 可让现有主模型循环继续，最多连续 3 次 |

## 配置来源

| 来源 | 位置 | 生效方式 |
| --- | --- | --- |
| 用户级配置 | `~/.reactor/cli/config.json` | 必须在该文件中设置 `hooks.enabled: true` |
| 工作区级配置 | `<仓库>/.zcode/config.json`（也兼容 `<仓库>/zcode.json`） | 配置可被发现，但每条 Hook 需先通过工作区信任审核才会执行 |
| 插件 `hooks/hooks.json` | 插件包内标准位置 | 自动发现，随插件启停；不需要再在 manifest 中重复声明同一文件 |
| `.agents/settings.json` / `.claude/settings.json` | 跨工具约定目录 | 只读展示，不直接执行；需在设置页显式导入 |

执行顺序是 user Hook → workspace Hook → 已启用插件 Hook。同一来源内按数组顺序执行。

每个 session 启动时会捕获一份 Hook 配置快照。修改文件、在设置页保存或启停插件后，请**新建 session** 验证；已经启动的 session 不保证热更新。

用户配置示例：

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 60000,
    "maxOutputBytes": 32768,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Write|Edit",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["scripts/check-write.mjs"],
              "enabled": true,
              "timeoutMs": 10000
            }
          ]
        }
      ]
    }
  }
}
```

### 工作区级 Hook 需要信任审核

写在 `<仓库>/.zcode/config.json` 或 `<仓库>/zcode.json` 里的 `hooks` 不会被静默忽略，但也不会直接执行：Reactor 会为每条声明计算摘要，把它们标记为**待审核**，并在设置 → Hooks 与会话底部提示条里给出入口。

- 只有审核通过的声明才会真正运行，未审核的声明在触发点被拦截。
- 用户级与插件 Hook 不受这道闸门影响。
- 命令行 `reactor hooks trust status | review | grant | revoke` 可以查看当前工作区的声明与信任状态，或按摘要预授权。
- 信任记录保存在用户数据目录的 `security/workspace-hook-trust-v1.json`。

> **为什么这样设计**：项目配置随仓库分发，打开一个项目就等于接受了它带来的 Hook 代码。要求显式审核，才能避免「克隆一个仓库就悄悄执行了它带的命令」。

### 最小插件 Hook 示例

下面的插件在新 session 启动时给模型补充一条团队约束，依赖系统 PATH 中的 `node`。插件目录为 `.zcode-plugin/plugin.json` + `hooks/hooks.json` + `hooks/context.mjs` 三件套（标准位置的 `hooks/hooks.json` 自动发现，不必在清单里声明）。

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "process",
            "command": "node",
            "args": ["${ZCODE_PLUGIN_ROOT}/hooks/context.mjs"],
            "timeoutMs": 5000
          }
        ]
      }
    ]
  }
}
```

```javascript
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

const input = JSON.parse(raw);
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: input.hook_event_name,
    additionalContext: "本项目提交前必须运行类型检查和受影响测试。"
  }
}));
```

验证步骤：在设置 → 插件里添加本地插件市场并安装启用；到设置 → Hooks 确认插件 Hook 以只读条目出现且事件、matcher、命令正确；新建 session 发起请求，首轮模型应能看到注入的约束。调试时日志写 stderr，stdout 只输出协议结果。

## 执行器、超时与 matcher

| 类型 | 语义 | 建议 |
| --- | --- | --- |
| `process` | `command + args[]`，直接按 argv 执行，不经过 shell；只支持同步 | 参数边界清楚，跨平台更稳定，优先用于 Node、Python 或二进制脚本 |
| `command` | 把完整字符串交给系统 shell；可设置 `shell`、`async`、`timeout` | 适合兼容现有插件；注意 Windows、macOS、Linux 的 shell 和引用差异 |

- `timeoutMs` 单位是毫秒；兼容字段 `timeout` 单位是秒。两者同时存在时优先 `timeoutMs`。
- 根级默认超时 60000 ms，默认 stdout 上限 32768 bytes。
- 单条 Hook 可写 `enabled: false`，runtime 会真正跳过。
- `command` 的 `async: true` 是 fire-and-forget：当前事件立即继续，后台 stdout 不能阻断、改输入或注入上下文；超时、取消、完成和失败仍记录生命周期。
- `statusMessage` 会保存并在设置页展示，运行时作为执行描述的一部分呈现。

**matcher 规则**：

- 缺省、空字符串或 `*`：匹配全部。
- 只含字母、数字、下划线和 `|`：按精确名称列表匹配，例如 `Write|Edit`。
- 包含其他字符：按 JavaScript 正则处理；非法正则不执行该 matcher，并产生诊断。
- 工具事件匹配实际工具名，并兼容子智能体调度工具别名（`Agent` / `Task`）。
- `SessionStart` 匹配 `source`；`UserPromptSubmit` 和 `Stop` 不使用 matcher 过滤。

## stdin 输入契约

Reactor 向每个 Hook 写入「一行 JSON + 换行」。同一份输入同时保留 camelCase 字段与兼容的 snake_case 别名，旧插件可继续读取 snake_case。

```json
{
  "session_id": "session-123",
  "transcript_path": "/tmp/zcode-hook/transcript.jsonl",
  "cwd": "/workspace/demo",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": "src/index.ts", "content": "..." },
  "tool_use_id": "tool-123"
}
```

各事件的重点字段：`SessionStart` 有 `source`（可选 `model`）；`UserPromptSubmit` 有 `prompt`；工具事件统一有 `tool_name`、`tool_input`、`tool_use_id`；`PermissionRequest` 在可用时带 `permission_suggestions`；`PostToolUse` 带完整结构化 `tool_response`；`PostToolUseFailure` 带字符串 `error` 与 `is_interrupt`；`Stop` 带 `stop_hook_active` 与 `last_assistant_message`。

`transcript_path` 指向本次 Hook 可读的临时 JSONL 文件。Reactor 会在 Hook 完成后清理临时目录，不要把它当作长期存储。

## stdout、退出码与常用返回值

stdout 为空表示成功且无附加效果；非 JSON stdout 只作为诊断，不进入模型上下文。只有去除前导空白后以 `{` 开头的合法 JSON 才按协议解析。未知字段会忽略，已知字段类型错误或事件名不符会让当前 Hook 可恢复失败，不影响后续 Hook。

注入上下文（推荐用 `hookSpecificOutput`，也兼容顶层 `additionalContext` / `additional_context`），以 `SessionStart` 为例：

```json
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "只修改与当前任务相关的文件。" } }
```

**PreToolUse：修改或拒绝工具调用**

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow",
  "updatedInput": { "file_path": "generated/index.ts", "content": "..." } } }
```

`updatedInput` 是完整替代对象，不是局部 patch；Reactor 会用工具 schema 重新校验。拒绝时返回 `permissionDecision: "deny"` 与 `permissionDecisionReason`。多个 Hook 聚合时 deny 优先于 ask，ask 优先于 allow。

**PermissionRequest：自动允许或拒绝权限询问**

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
  "decision": { "behavior": "deny", "message": "生产目录只能在发布流程中修改" } } }
```

允许时把 `behavior` 改为 `allow`，并可在 decision 中返回 `updatedInput`、`updatedPermissions`；历史字段 `permissionUpdates` 也兼容。显式 deny 规则、Plan 模式写入禁令和工具硬限制不能被 Hook allow 绕过。

**UserPromptSubmit：阻断本次模型请求** —— 返回 `{ "continue": false, "reason": "请先提供工单号" }`。

**Stop：让主模型继续一轮** —— 返回 `{ "decision": "block", "reason": "还没有给出测试命令和结果，请补齐后再结束。" }`。

`decision: "block"` 需要带 `reason` 或 `additionalContext` 才会续跑。为兼容旧配置，也接受 `continue: true` 且带 `additionalContext`。连续续跑达到 3 次后会强制结束，防止无限循环。

**退出码**

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功，解析 stdout |
| `2` | 阻断快捷方式；在可阻断事件中产生 block / deny，在 Stop 中产生继续一轮的反馈 |
| 其他非零 | 当前 Hook 可恢复失败，记录诊断，turn 不会因此整体崩溃 |

## 插件发现、变量与安全边界

- manifest 查找优先级：`.zcode-plugin/plugin.json` → `.claude-plugin/plugin.json`。
- 标准 `hooks/hooks.json` 自动加载；manifest 的 `hooks` 还支持相对 JSON 路径、inline 对象或二者数组。不要让 manifest 再指向同一个标准文件，否则会记录重复诊断并跳过重复项。
- 插件进程可读取 `ZCODE_PLUGIN_ROOT`、`ZCODE_PLUGIN_DATA`、`ZCODE_PLUGIN_ID`、`ZCODE_PLUGIN_NAME`；兼容变量 `CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA` 也会注入，另有 `ZCODE_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` 与当前 session ID。
- 命令、参数里的插件路径变量会在执行前替换。长期数据写入 `ZCODE_PLUGIN_DATA`，不要写回安装目录。
- 插件 Hook 在设置页只读，启停跟随插件本身。不支持的事件名会记录诊断并跳过，不会让整个插件加载失败。

## 在设置页创建和维护 Hook

1. 打开 **设置 → Hooks**。
2. 选择 user 或 workspace scope，新增事件、执行类型、matcher、命令 / 参数、超时、async 和状态文案。
3. 已有 `.zcode` Hook 支持查看、编辑、删除和单条启停。编辑时不能直接改变 scope；需要删除后在目标 scope 重建。
4. 工作区 Hook 在信任前以待审核状态展示，需要先完成审核才会执行。

Hook 不生效时先确认：配置来源里 `hooks.enabled` 是否为 `true`、工作区 Hook 是否已通过审核、插件是否处于启用状态，然后**新建一个 session**。

仍有问题可以查日志：`~/.reactor/cli/log/` 下的 `zcode-<日期>.jsonl` 会记录 Hook 的执行失败与被拦截的声明。

## 与上游 ZCode 的差异

| 项 | 上游写法 | 本说明书写法 | 原因 |
| --- | --- | --- | --- |
| 产品名 | ZCode | Reactor | 本仓产品名与 rebrand 契约 |
| 用户级配置与日志路径 | 上游 `.zcode/cli/config.json`、`.zcode/cli/log/` | 改为 `~/.reactor/cli/config.json`、`~/.reactor/cli/log/` | 用户数据目录契约 |
| 工作区级配置 | `<workspace>/.zcode/config.json`、`<workspace>/zcode.json` | 同左，不变 | 工作区级保持 `.zcode` |
| 项目级 Hook 是否执行 | 称项目级 Hook **整体被忽略**，日志记为 `config_project_hooks_ignored` | 改为：项目级 Hook 会被发现并进入**工作区信任审核**，审核通过后才执行；补充 `reactor hooks trust` 与信任记录文件 | 本仓已实现工作区 Hook 信任闸门，不是静默忽略 |
| 事件集合、超时与输出上限、matcher、退出码 | 7 个事件；60000 ms / 32768 bytes；列表 / 正则；0、2、其他 | 同左 | 与本仓运行时一致 |
| 插件变量 | `ZCODE_PLUGIN_*` 与 `CLAUDE_*` 兼容变量 | 同左，并补充 `ZCODE_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` 与 session ID | 与本仓注入的变量集合一致 |
| 设置页与日志排查链接 | 站内链接指向官方文档站 | 改为本说明书相对链接 | 离线站点，不请求外部资源 |
