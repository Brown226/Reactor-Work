/**
 * EmitUiTree / EmitUiPatch handlers —— GenUI 消息体。
 *
 * 状态所有权：树只存在于工具结果里；UI 的 `uiTreeStore` 在渲染工具卡时物化。
 * 这里**不**写会话存储，避免第二条状态路径。patch 的合并在 UI 侧完成
 * （op 是描述性数据，handler 只做校验与回显）。
 */
import {
  EMIT_UI_PATCH_TOOL_NAME,
  EMIT_UI_TREE_TOOL_NAME,
  EmitUiPatchInputJsonSchema,
  EmitUiPatchInputSchema,
  EmitUiPatchOutputJsonSchema,
  EmitUiPatchOutputSchema,
  EmitUiTreeInputJsonSchema,
  EmitUiTreeInputSchema,
  EmitUiTreeOutputJsonSchema,
  EmitUiTreeOutputSchema,
  countNodes,
  type EmitUiPatchInput,
  type EmitUiPatchOutput,
  type EmitUiTreeInput,
  type EmitUiTreeOutput,
} from "@zcode/contracts";

import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_INLINE_BYTES = 200_000;

const emitUiTreeHandler: ToolHandler = async (input) => {
  const parsed = EmitUiTreeInputSchema.parse(input) as EmitUiTreeInput;
  const nodeCount = countNodes(parsed.tree.root);
  return {
    ok: true,
    nodeCount,
    tree: parsed.tree,
    note: "UI tree accepted; render it in the chat message body. Not a document deliverable.",
  } satisfies EmitUiTreeOutput;
};

const emitUiPatchHandler: ToolHandler = async (input) => {
  const parsed = EmitUiPatchInputSchema.parse(input) as EmitUiPatchInput;
  return {
    ok: true,
    applied: parsed.ops.length,
    note: `Patch ops validated for ${parsed.target_tree_call_id}; UI applies them to the existing tree slot.`,
  } satisfies EmitUiPatchOutput;
};

export const emitUiTreeToolEntry: ToolEntry = {
  capability:
    "Embed a declarative GenUi tree (KPI board, weather card, stepper, form) as interactive inline UI in the chat message body",
  metadata: {
    name: EMIT_UI_TREE_TOOL_NAME,
    description:
      "Stream a declarative UI tree into the chat message body as interactive inline UI. " +
      "Use for in-conversation structured interfaces ONLY; office deliverables (docx/xlsx/pptx/pdf files) must use the document skills. " +
      "Unknown node kinds degrade to a debug block. Buttons/forms can send actions back to the conversation.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 15000,
    maxOutputBytes: MAX_INLINE_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: emitUiTreeHandler,
  inputSchema: EmitUiTreeInputJsonSchema,
  outputSchema: EmitUiTreeOutputJsonSchema,
  runtimeInputSchema: EmitUiTreeInputSchema,
  runtimeOutputSchema: EmitUiTreeOutputSchema,
  formatModelContent: (output: unknown): string => {
    const result = output as EmitUiTreeOutput;
    return `UI tree accepted (${result.nodeCount} nodes, root kind=${result.tree.root.kind}). Rendered inline in chat.`;
  },
  permission: {
    permission: "emitUi.write",
    reason: "EmitUiTree only embeds a UI tree into the current tool result",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_INLINE_BYTES,
    maxModelBytes: MAX_INLINE_BYTES,
    strategy: "truncate",
    preview: { maxBytes: 8_000, direction: "head" },
  },
  timeout: { defaultMs: 15_000, maxMs: 15_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "EmitUiTree was cancelled before the UI tree was recorded",
  },
  trace: { required: true, propagateToAdapters: false, recordInput: "summary", recordOutput: "summary" },
};

export const emitUiPatchToolEntry: ToolEntry = {
  capability: "Incrementally update a previously emitted GenUi tree by nodeId path",
  metadata: {
    name: EMIT_UI_PATCH_TOOL_NAME,
    description:
      "Incrementally update a previously emitted GenUi tree (replace a node or merge props by nodeId path). " +
      "target_tree_call_id must be the EmitUiTree toolCallId this patch applies to.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 15000,
    maxOutputBytes: MAX_INLINE_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: emitUiPatchHandler,
  inputSchema: EmitUiPatchInputJsonSchema,
  outputSchema: EmitUiPatchOutputJsonSchema,
  runtimeInputSchema: EmitUiPatchInputSchema,
  runtimeOutputSchema: EmitUiPatchOutputSchema,
  formatModelContent: (output: unknown): string => {
    const result = output as EmitUiPatchOutput;
    return `UI patch recorded (${result.applied} ops).`;
  },
  permission: {
    permission: "emitUi.write",
    reason: "EmitUiPatch only describes UI-tree edits in the tool result",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_INLINE_BYTES,
    maxModelBytes: MAX_INLINE_BYTES,
    strategy: "truncate",
    preview: { maxBytes: 4_000, direction: "head" },
  },
  timeout: { defaultMs: 15_000, maxMs: 15_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "EmitUiPatch was cancelled before the patch was recorded",
  },
  trace: { required: true, propagateToAdapters: false, recordInput: "summary", recordOutput: "summary" },
};
