/**
 * GenUI（D4 决策后实施）—— 出口。
 *
 * 设计来源：LeAgent `services/gen_ui/`（Apache-2.0）。**只取子集**：
 * 70 个 kind 里取 26 个（第一刀 11 个已登记并落地渲染），其余明确排除
 * 并在 `types.ts` 逐条写明理由（3D/摄像头/任意 HTML 嵌入 = 内控合规风险；
 * 交互表单 = 缺「动作回传」通道）。
 *
 * 三层：契约（`types.ts`）→ 容错归一（`normalize.ts`）→ 使用者（`emit_ui_tree` 工具 + 前端渲染器）。
 */

export * from "./types.js";
export * from "./normalize.js";
export * from "./to-blocks.js";
