/**
 * GenUI 动作回传：按钮/表单 → 会话 composer 草稿。
 * 与 pdf-reader 的引用进会话同源（requestComposerTextInsert / 根草稿槽），保证一条写路径。
 */

import {
  appendBlockToComposerDraftText,
  normalizeComposerTextInsertSessionId,
} from "@/lib/composerTextInsert.js";

export interface GenUiActionEvent {
  actionId?: string;
  formValues?: Record<string, unknown>;
}

export function formatGenUiActionPrompt(event: GenUiActionEvent): string {
  const actionId = event.actionId?.trim() || "action";
  const values =
    event.formValues && Object.keys(event.formValues).length > 0
      ? ` values=${JSON.stringify(event.formValues)}`
      : "";
  return `[GenUI action] actionId=${actionId}${values}`;
}

/**
 * 把动作提示送进 v4 composer 草稿。宿主可传 onAction 覆盖；不传时走本函数。
 * - 有活跃会话（`sessionId`）：走既有「实时插入当前输入框」通道 `requestComposerTextInsert`，
 *   请求带目标会话标识 + `append` 模式，追加到该会话已有草稿之后。
 * - 无会话（新建任务态）：保持原行为，追加进根草稿槽 `scopeId`（通常 `__draft__`）。
 *
 * 修复依据：此前不分会话一律写 `__draft__`，已有会话里点 GenUI 按钮/表单时文本进了新建任务
 * 草稿槽，当前会话输入框看不到任何东西（docs/未完成-GenUI-消息体-最小内核-spec-v1.md §5.3
 * 要求的是「会话草稿」）。
 */
export function appendGenUiActionToComposerDraft(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  scopeId: string;
  sessionId?: string | null;
  event: GenUiActionEvent;
}): void {
  const prompt = formatGenUiActionPrompt(params.event);
  const targetSessionId = normalizeComposerTextInsertSessionId(params.sessionId);
  if (targetSessionId) {
    void import("@/store/zcodeSessionStore.js").then(({ useZCodeSessionStore }) => {
      useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          params.workspacePath,
          prompt,
          params.workspaceIdentity,
          undefined,
          "append",
          targetSessionId,
        );
    });
    return;
  }
  void import("@/v4/composer/composerDraftStore.js").then((mod) => {
    const existing = mod.readV4ComposerDraft(
      params.workspacePath,
      params.workspaceIdentity,
      params.scopeId,
    );
    const text = appendBlockToComposerDraftText(existing?.text, prompt);
    mod.persistV4ComposerDraft(params.workspacePath, params.workspaceIdentity, params.scopeId, {
      ...existing,
      text,
    });
  });
}
