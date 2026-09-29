# GenUI 消息体 · 最小内核 Spec

状态：P0 底座已落地（schema/store/registry/inline）｜适用范围：聊天消息体 / 工具结果展示｜维护者：桌面工具组
设计来源：LeAgent `frontend/src/components/canvas/genUi/*`、`types/genUi.ts`、
`backend/leagent/services/gen_ui/schema.py`、`tools/canvas/ui_components.py`
（Apache-2.0）。只取「声明式 UI 树 + 组件目录 + 动作回传」三件套，
不引入 LeAgent 的 Pet、工作流编排与 Canvas 产物后端。

## 1. 背景与缺口

当前会话消息体只有两种载荷：**Markdown 文本** 与 **工具结果块**（`ToolCallBlocks`）。
天气卡、KPI 看板、步骤条、幻灯这类「结构化、可交互」的界面只能退化成
markdown 表格或静态截图。LeAgent 官方主推的 Generative UI 能力，本质是：

> 智能体流式输出**声明式 UI 树**，聊天内联渲染，并可导出 PDF / PPTX；按钮/表单可回传给智能体。

与四件套创作层的边界（产品规则，不是实现细节）：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| **GenUI（本 spec）** | 会话内**轻量结构化界面**：看板、步骤条、卡片、表单、幻灯播放 | 成稿级 Word/PPTX/PDF 排版 |
| 创作层（四件套 skill） | 从无到有产出办公文档 | 聊天内的临时 UI |
| 操作层（file-tools） | 确定性文件读写 | 展示 |

一句话：**GenUI 是「消息体」，不是「文档生成」**。导出 PDF/PPTX 属于 P2，
且必须声明与四件套的关系（复用渲染器 or 降级截图），不得出现第二条成稿写入路径。

## 2. 目标与非目标

### 2.1 目标（P0）

1. Agent 通过工具 `emit_ui_tree` 流式输出符合 schema 的 UI 树，聊天列内联渲染。
2. 支持 **10 个最小节点**（见 §4），覆盖截图中的天气卡、KPI、步骤条形态。
3. 交互节点（Button / Form）能把 `actionId` + 表单值**回传进会话**。
4. 同一消息可被 `emit_ui_patch` 增量更新（工具执行中先骨架后数据）。
5. 未知 `kind` **优雅降级**为折叠的 JSON 调试块，不崩消息流。

### 2.2 非目标（明确不做）

- LeAgent 全量 70+ 节点（ThreeJs / LiveCamera / RTSP / Model3D 等）。
- Canvas 产物后端、HTML 画布持久化、右栏多标签工作台（另案）。
- 同树导出 DOCX/PPTX 成稿（P2，且优先「截图/打印路径」而非重写 docgen 渲染器）。
- 工作流表单阻塞态接管（`blockedToGenUiTree`）——等 P0 验收后再评估。

## 3. 状态所有权与数据流

```text
Agent 工具 emit_ui_tree / emit_ui_patch
        │  (tool_result + 可选 ui_tree stream payload)
        ▼
uiTreeStore（packages/ui/src/store/）
  key = workspaceIdentity + sessionId + messageId
  value = { schemaVersion:'1', root: GenUiNode, updatedAt }
        │
        ▼
消息行 <GenUiInline> ──► <GenUiTreeView>（registry 按 kind 分发）
        │
        └─ Button/Form onClick ──► genUiActionBus ──► 会话输入/工具回调
```

| 状态 | 唯一所有者 | 说明 |
| --- | --- | --- |
| UI 树 | `uiTreeStore` | 按 `sessionId+messageId` 槽位；patch 合并后整体替换 root 引用 |
| 流式中的树 | 工具结果显示层 | 未 finalize 前允许 `JsonDebug` 占位 |
| 动作回传 | `genUiActionBus` → 会话草稿/CommandInbox | **不得**直接写 task/session 业务状态 |
| 组件目录 | 前端 registry 纯映射 | 无全局可变注册，避免运行时注入 |

**禁**：UI 组件内直接调 Repo/Service；禁止把 UI 树状态同步进 Zustand 以外的第二处。

## 4. 最小节点目录（P0）

| kind | 用途 | 必要 props |
| --- | --- | --- |
| `Stack` / `Row` / `Grid` | 布局 | `gap` / `columns` |
| `SectionHeader` | 分区标题 | `title`, `eyebrow?` |
| `Text` / `Heading` | 文案 | `text` / `level` |
| `MetricCard` | 单指标（温度、百分比） | `label`, `value`, `unit?`, `delta?` |
| `KpiBoard` | 指标墙 | children: MetricCard[] |
| `WeatherCard` | 示范卡（官方截图同款） | `city`, `temp`, `condition`, `forecast[]` |
| `Stepper` | 步骤条 | `steps[]`, `current?` |
| `Image` | 图 | `src`, `alt?` |
| `Button` / `InteractiveButton` | 动作 | `label`, `actionId` 或 `action` |
| `Form` + `Input` / `NumberInput` / `Textarea` | 回传表单 | `formId`, 字段 `name` |
| `Alert` / `Callout` | 提示 | `tone`, `text` |
| `JsonDebug` | 降级 | 任意 |

P1 再扩：`Table` / `Chart` / `ImageGallery` / `QuoteCard` / `SlideDeck` / `Progress` / `Badge`。

Schema 契约：`schemaVersion: '1'`，节点 `{ nodeId, kind, props?, children? }`。
校验用 JSON Schema（建议从 LeAgent `gen_ui/schema.py` 裁剪出 P0 子集为
`packages/shared/src/genUi/schema-v1.json`，前后端共用）。

## 5. 工具接口

### 5.1 `emit_ui_tree`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `tree` | GenUiTreeV1 | 完整树；单棵节点数建议 ≤ 200 |
| `replace_message_id?` | string | 覆盖同消息旧树；缺省追加为本条工具结果 |

- 工具结果：`{ ok, nodeCount, treeKey }`。
- 描述必须写明「用于会话内结构化界面；办公成稿请用四件套技能」。

### 5.2 `emit_ui_patch`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `message_id` | string | 目标消息 |
| `ops` | array | P0 仅支持 `{op:'replace', path, node}` 与 `{op:'props', path, props}` |

路径语义为 nodeId 路径（`root/metrics/t2`），不是 JSON Pointer，避免下标漂移。

### 5.3 动作回传（无新工具）

按钮/表单触发后写入**会话草稿**或直接以用户消息发出结构化文本：

```text
[GenUI action] actionId=refresh_weather formId=weather_form values={city:"北京"}
```

由既有聊天链路进 Agent；**不**新开 RPC。表单值在前端 `formComponents` 采集。

## 6. 前端落点

| 模块 | 路径（建议） | 职责 |
| --- | --- | --- |
| 类型 + schema | `packages/shared/src/genUi/` | 零依赖类型与 JSON Schema |
| store | `packages/ui/src/store/uiTreeStore.ts` | 树槽位与 patch 合并 |
| registry | `packages/ui/src/genUi/GenUiRegistry.tsx` | kind → 组件纯映射 |
| 内联入口 | `packages/ui/src/genUi/GenUiInline.tsx` | 折叠、导出（P2）、调试开关 |
| 动作总线 | `packages/ui/src/genUi/genUiActionBus.ts` | actionId 回传 |
| 消息接入 | `packages/ui/src/v4/` 现有消息行 | 工具名含 `emit_ui_*` 时挂 GenUiInline |

遵守 `DESIGN.md`：组件走既有 token，禁止阴影/渐变堆砌；中文文案进 i18n。

## 7. 与现有能力的边界

| 已有 | 关系 |
| --- | --- |
| Markdown 消息 | 并列载荷；**不**把 UI 树转 markdown 再渲染 |
| `ToolCallBlocks` | 工具行仍存在；`emit_ui_*` 的工具行内嵌 GenUiInline（可折叠） |
| Markdown 导出三件套 | P0 导出为「节点截图 PNG」；P2 才接 PDF 打印 |
| 四件套 skill | 不动；GenUI 不写 docx/pptx 成稿 |
| presentation 预览 | 不动；`SlideDeck` 节点 P1 再考虑复用其引擎 |

## 8. 验收场景

1. **天气卡**：Agent `emit_ui_tree` 输出 WeatherCard，聊天内显示城市/温度/预报，无原始 JSON。
2. **KPI + 步骤条**：一棵树同时含 KpiBoard 与 Stepper，布局不塌、中文不换行错位。
3. **增量**：先 emit 骨架 → 执行工具 → `emit_ui_patch` 只改 props，消息不闪烁重建整树。
4. **动作**：Button `actionId=demo` 点击后会话中出现回传内容，Agent 能读到。
5. **表单**：Form 三个字段 + 提交按钮，回传 values 含全部字段。
6. **降级**：`kind: 'FutureWidget'` 显示 JsonDebug 折叠块，消息流其余部分正常。
7. **长流**：同一消息持续 patch 100 次，输入框不卡、旁路消息不重解析 markdown。
8. 门禁：`pnpm typecheck` / `pnpm lint` / `architecture:check --changed` 零新增违规。

## 9. 分期

| 阶段 | 内容 | 完成定义 |
| --- | --- | --- |
| P0 | schema + 10 节点 + emit_ui_tree + 内联 + 动作回传 | 场景 1–6 |
| P1 | patch、Table/Chart/SlideDeck、主题 surface | 场景 7 + 扩展节点 |
| P2 | 导出 PDF（打印/截图）、与右栏产物（另案）对接 | 导出验收另立 |

### 落地进度（2026-09-28）

- **已落地**：
  - `packages/shared/src/genUi/`（类型 + tree key + patch op）
  - `packages/ui/src/store/uiTreeStore.ts`（槽位 + replace/props patch）
  - `packages/ui/src/genUi/GenUiRegistry.tsx`（P0 kind 渲染 + JsonDebug 降级）
  - `packages/ui/src/genUi/GenUiInline.tsx`、`genUiActionBridge.ts`（动作 → v4 composer 草稿）
  - 工具：`EmitUiTree` / `EmitUiPatch`（contracts + core handler）
  - 工具卡：`emit-ui-tree.tsx`——Tree 物化进 store；**Patch 按 target_tree_call_id 合并**（幂等）；
    Button/Form **onAction → composer 草稿**
- **单测**：`uiTreeStore.test.ts` 5、`emit-ui-tree.test.ts` 3、`genUiActionBridge.test.ts` 3
- **可选增强**：Table/Chart/SlideDeck 节点（P1）、同树导出 PDF（P2）

## 10. 风险

| 风险 | 处置 |
| --- | --- |
| schema 前后端漂移 | 唯一 JSON Schema 在 `packages/shared`，CI 校验示例树 |
| 双写路径（GenUI vs 四件套） | §1 边界写入工具 description；审查文档时对照 |
| XSS | 节点一律结构化渲染，禁止 `dangerouslySetInnerHTML`；`HtmlFrame` 不进 P0 |
| 流式性能 | store 按 messageId 订阅；registry 纯函数；必要时对树做 memo |
