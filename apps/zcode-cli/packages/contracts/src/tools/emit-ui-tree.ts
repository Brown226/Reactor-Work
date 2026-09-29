/**
 * EmitUiTree / EmitUiPatch —— GenUI 消息体（docs/未完成-GenUI-消息体-最小内核-spec-v1.md）。
 *
 * 工具只负责把**声明式 UI 树**送进工具结果；树的状态所有者是 UI 侧 `uiTreeStore`
 * （按 sessionId::toolCallId 槽位），工具本身不写任何会话业务状态。
 *
 * 边界：这是「会话内结构化界面」，不是办公成稿——成稿走四件套技能。
 */
import { z } from "zod";

import type { GenUiNode, GenUiTreeV1 } from "@zcode/shared";
import { toToolJsonSchema } from "./json-schema.js";

export const EMIT_UI_TREE_TOOL_NAME = "EmitUiTree";
export const EMIT_UI_PATCH_TOOL_NAME = "EmitUiPatch";

/** 节点 schema 刻意宽松（props 任意键），kind 白名单由 UI registry 决定并降级。 */
export const GenUiNodeSchema: z.ZodType<GenUiNode> = z.lazy(() =>
  z.object({
    nodeId: z.string().min(1),
    kind: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    children: z.array(GenUiNodeSchema).optional(),
  }),
) as z.ZodType<GenUiNode>;

export const GenUiTreeV1Schema = z.object({
  schemaVersion: z.literal("1"),
  root: GenUiNodeSchema,
});

export const EmitUiTreeInputSchema = z
  .object({
    tree: GenUiTreeV1Schema.describe(
      "Declarative UI tree (schemaVersion 1). For in-chat interactive surfaces only — office deliverables must use the document skills.",
    ),
  })
  .strict();

export type EmitUiTreeInput = z.infer<typeof EmitUiTreeInputSchema>;
export const EmitUiTreeInputJsonSchema = toToolJsonSchema(EmitUiTreeInputSchema);

export interface EmitUiTreeOutput {
  ok: true;
  nodeCount: number;
  tree: GenUiTreeV1;
  note: string;
}

export const EmitUiTreeOutputSchema = z.object({
  ok: z.literal(true),
  nodeCount: z.number().int().nonnegative(),
  tree: GenUiTreeV1Schema,
  note: z.string(),
});

export type ParsedEmitUiTreeOutput = z.infer<typeof EmitUiTreeOutputSchema>;
export const EmitUiTreeOutputJsonSchema = toToolJsonSchema(EmitUiTreeOutputSchema);

export const GenUiPatchOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace"),
    path: z.string().min(1).describe("nodeId chain, e.g. root/metrics/m1"),
    node: GenUiNodeSchema,
  }),
  z.object({
    op: z.literal("props"),
    path: z.string().min(1),
    props: z.record(z.string(), z.unknown()),
  }),
]);

export const EmitUiPatchInputSchema = z
  .object({
    target_tree_call_id: z
      .string()
      .min(1)
      .describe("toolCallId of the EmitUiTree (or previous patch) this patch applies to"),
    ops: z.array(GenUiPatchOpSchema).min(1).max(50),
  })
  .strict();

export type EmitUiPatchInput = z.infer<typeof EmitUiPatchInputSchema>;
export const EmitUiPatchInputJsonSchema = toToolJsonSchema(EmitUiPatchInputSchema);

export interface EmitUiPatchOutput {
  ok: true;
  applied: number;
  note: string;
}

export const EmitUiPatchOutputSchema = z.object({
  ok: z.literal(true),
  applied: z.number().int().nonnegative(),
  note: z.string(),
});
export const EmitUiPatchOutputJsonSchema = toToolJsonSchema(EmitUiPatchOutputSchema);

export function countNodes(node: GenUiNode): number {
  let n = 1;
  for (const child of node.children ?? []) n += countNodes(child);
  return n;
}
