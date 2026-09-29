/**
 * GenUI 声明式 UI 树 — schema v1（前后端共用类型）。
 * 契约见 docs/未完成-GenUI-消息体-最小内核-spec-v1.md。
 *
 * P0 节点集刻意小：只覆盖天气卡/KPI/步骤条/表单回传所需 kind；
 * 未知 kind 由 UI 降级为 JsonDebug，不在此枚举里阻塞演进。
 */

export const GEN_UI_SCHEMA_VERSION = "1" as const;

/** P0 kind 白名单；字符串仍允许（降级路径），注册表只认识这些。 */
export type GenUiNodeKind =
  // Layout
  | "Stack"
  | "Row"
  | "Grid"
  // Typography
  | "Text"
  | "Heading"
  | "SectionHeader"
  // Data
  | "MetricCard"
  | "KpiBoard"
  | "WeatherCard"
  | "Stepper"
  | "Image"
  | "Alert"
  | "Callout"
  // Interactive
  | "Button"
  | "InteractiveButton"
  | "Form"
  | "Input"
  | "NumberInput"
  | "Textarea"
  // Fallback
  | "JsonDebug";

export interface GenUiNode {
  nodeId: string;
  /** 未知 kind 用字符串传入，UI 走 JsonDebug 降级。 */
  kind: GenUiNodeKind | string;
  props?: Record<string, unknown>;
  children?: GenUiNode[];
}

export interface GenUiTreeV1 {
  schemaVersion: typeof GEN_UI_SCHEMA_VERSION;
  root: GenUiNode;
}

/** emit_ui_patch 的 P0 操作（路径为 nodeId 链，不是 JSON Pointer）。 */
export type GenUiPatchOp =
  | { op: "replace"; path: string; node: GenUiNode }
  | { op: "props"; path: string; props: Record<string, unknown> };

export function isGenUiTreeV1(value: unknown): value is GenUiTreeV1 {
  if (!value || typeof value !== "object") return false;
  const tree = value as GenUiTreeV1;
  return tree.schemaVersion === GEN_UI_SCHEMA_VERSION && !!tree.root?.nodeId;
}

export function countGenUiNodes(node: GenUiNode | null | undefined): number {
  if (!node) return 0;
  let n = 1;
  for (const child of node.children ?? []) n += countGenUiNodes(child);
  return n;
}

/** 树 key：会话 + 消息槽位。身份 key 口径与 workspaceIdentity 一致。 */
export function genUiTreeKey(sessionId: string, messageId: string): string {
  return `${sessionId}::${messageId}`;
}
