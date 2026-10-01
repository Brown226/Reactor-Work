import { useCallback, useEffect, useMemo } from "react";
import { LayoutDashboard } from "lucide-react";
import { genUiTreeKey, isGenUiTreeV1, type GenUiPatchOp, type GenUiTreeV1 } from "@zcode/shared";
import { GenUiTreeView, type GenUiActionEvent } from "@/genUi/GenUiRegistry.js";
import {
  appendGenUiActionToComposerDraft,
  formatGenUiActionPrompt,
} from "@/genUi/genUiActionBridge.js";
import { isEmitUiPatchToolCall, isEmitUiTreeToolCall } from "@/lib/genUiToolNames.js";
import { useUiTreeStore } from "@/store/uiTreeStore.js";
import { V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

/**
 * EmitUiTree / EmitUiPatch 工具卡。
 * - EmitUiTree：结果树物化进 store 槽位 workspacePath::toolCallId，并内联渲染。
 * - EmitUiPatch：对 target_tree_call_id 槽位做 replace/props 合并，展示合并后的树。
 * - 按钮/表单动作写入 v4 composer 草稿（与 pdf 引用进会话同一写路径）。
 */

const ICON = <LayoutDashboard className="size-4 shrink-0 text-foreground-subtle" />;

/** 已合并的 patch toolCallId，防止 StrictMode/重渲染重复 merge。 */
const appliedPatchCallIds = new Set<string>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function extractTree(output: unknown): GenUiTreeV1 | null {
  const parsed = parseMaybeJson(output);
  const record = isPlainRecord(parsed) ? parsed : null;
  if (!record) return null;
  const nested = isPlainRecord(record.data) ? record.data : record;
  const tree = nested.tree;
  return isGenUiTreeV1(tree) ? tree : null;
}

function readToolInput(toolCall: {
  input?: unknown;
  raw?: unknown;
}): Record<string, unknown> | null {
  const fromInput = parseMaybeJson(toolCall.input);
  if (isPlainRecord(fromInput)) return fromInput;
  const raw = parseMaybeJson(toolCall.raw);
  if (isPlainRecord(raw)) {
    const nested = parseMaybeJson(raw.input ?? raw.arguments);
    if (isPlainRecord(nested)) return nested;
  }
  return null;
}

function extractPatch(input: Record<string, unknown> | null): {
  targetTreeCallId: string;
  ops: GenUiPatchOp[];
} | null {
  if (!input) return null;
  const target = input.target_tree_call_id ?? input.targetTreeCallId;
  if (typeof target !== "string" || target.trim().length === 0) return null;
  const rawOps = input.ops;
  if (!Array.isArray(rawOps)) return null;
  const ops = rawOps.filter((op): op is GenUiPatchOp => {
    if (!isPlainRecord(op)) return false;
    if (op.op === "replace") return typeof op.path === "string" && isPlainRecord(op.node);
    if (op.op === "props") return typeof op.path === "string" && isPlainRecord(op.props);
    return false;
  });
  return { targetTreeCallId: target, ops };
}

export function EmitUiTreeToolCallBlock(context: ToolCallBlockRenderContext) {
  const { toolCall } = context.toolCallNode;
  const toolCallId = toolCall.toolId || "unknown";
  const isPatch = isEmitUiPatchToolCall(toolCall) && !isEmitUiTreeToolCall(toolCall);
  const treeFromOutput = useMemo(
    () => (isPatch ? null : extractTree(toolCall.output)),
    [isPatch, toolCall.output],
  );
  const patchInfo = useMemo(
    () => (isPatch ? extractPatch(readToolInput(toolCall)) : null),
    [isPatch, toolCall],
  );

  // EmitUiPatch 的目标槽位；EmitUiTree 用自身 toolCallId。
  const targetMessageId = patchInfo?.targetTreeCallId ?? toolCallId;
  // 树槽位按 workspace 身份 key 分桶（workspaceIdentity?.trim() || workspacePath）：
  // 远程 workspace 的路径与身份不一致时，只按路径分桶会把两棵树混进同一个槽位。
  const treeWorkspaceKey = context.workspaceIdentity?.trim() || context.workspacePath;
  const storeKey = genUiTreeKey(treeWorkspaceKey, targetMessageId);
  const storeTree = useUiTreeStore((s) => s.treesByKey[storeKey]);

  // 物化 EmitUiTree 结果树
  useEffect(() => {
    if (!treeFromOutput || isPatch) return;
    useUiTreeStore.getState().setTree({
      sessionId: treeWorkspaceKey,
      messageId: toolCallId,
      tree: treeFromOutput,
    });
  }, [treeWorkspaceKey, toolCallId, isPatch, treeFromOutput]);

  // 合并 EmitUiPatch（同一 patch 只应用一次）
  useEffect(() => {
    if (!isPatch || !patchInfo || patchInfo.ops.length === 0) return;
    if (appliedPatchCallIds.has(toolCallId)) return;
    appliedPatchCallIds.add(toolCallId);
    useUiTreeStore.getState().applyPatch({
      sessionId: treeWorkspaceKey,
      messageId: patchInfo.targetTreeCallId,
      ops: patchInfo.ops,
    });
  }, [treeWorkspaceKey, isPatch, patchInfo, toolCallId]);

  const tree = treeFromOutput ?? storeTree ?? null;

  const handleAction = useCallback(
    (event: GenUiActionEvent) => {
      const workspacePath = context.workspacePath;
      if (!workspacePath) return;
      appendGenUiActionToComposerDraft({
        workspacePath,
        // 远程 workspace 的请求按 identity 分桶，不能只按路径匹配（AGENTS.md）。
        ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
        // 会话内回传要进本会话输入框；context.sessionId 缺席（权限弹窗里的工具卡、
        // 嵌套子工具卡未透传）时保持旧的根草稿槽降级行为。
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        scopeId: V4_DRAFT_SCOPE_ROOT,
        event,
      });
    },
    [context.workspaceIdentity, context.sessionId, context.workspacePath],
  );

  const renderContent = useCallback(() => {
    const actionHint = formatGenUiActionPrompt({ actionId: "…" });
    if (!tree) {
      return (
        <div className="mb-2 rounded-xl border border-border bg-panel px-4 py-3 text-ui-base text-foreground-subtle">
          {context.isRunning
            ? "UI 树流式写入中…"
            : isPatch
              ? `Patch 目标树未找到（target=${patchInfo?.targetTreeCallId ?? "?"}）`
              : "UI 树尚未就绪"}
        </div>
      );
    }
    return (
      <div className="mb-2 rounded-xl border border-border bg-panel px-4 py-3">
        <GenUiTreeView tree={tree} onAction={handleAction} />
        <p className="mt-2 text-ui-base text-foreground-subtle">
          按钮/表单会写入输入框草稿，例如 <code className="font-mono">{actionHint}</code>
        </p>
      </div>
    );
  }, [context.isRunning, handleAction, isPatch, patchInfo?.targetTreeCallId, tree]);

  const primaryText = useMemo(
    () => (
      <span className="truncate font-mono text-foreground-subtlest">
        {isPatch ? "UI Patch" : "Interactive UI"}
        {tree ? ` · ${tree.root.kind}` : patchInfo ? ` · → ${patchInfo.targetTreeCallId}` : ""}
      </span>
    ),
    [isPatch, patchInfo, tree],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      autoOpen
      kindLabel={context.kindLabelOverride ?? (isPatch ? "GenUI Patch" : "GenUI")}
      sourceLabel={context.sourceLabel}
      primaryText={primaryText}
      statusLabel={context.statusLabel}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={context.isRunning}
      title={toolCall.title}
      renderContent={renderContent}
    />
  );
}
