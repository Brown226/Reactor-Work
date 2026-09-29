/**
 * GenUI 动作回传：按钮/表单 → 会话 composer 草稿。
 * 与 pdf-reader 的引用进会话同源（composerDraftStore），保证一条写路径。
 */

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
 * 追加动作提示到 v4 composer 草稿。宿主可传 onAction 覆盖；不传时走本函数。
 */
export function appendGenUiActionToComposerDraft(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  scopeId: string;
  event: GenUiActionEvent;
}): void {
  const prompt = formatGenUiActionPrompt(params.event);
  void import("@/v4/composer/composerDraftStore.js").then((mod) => {
    const existing = mod.readV4ComposerDraft(
      params.workspacePath,
      params.workspaceIdentity,
      params.scopeId,
    );
    const text = existing?.text?.trim()
      ? `${existing.text.trimEnd()}\n\n${prompt}\n`
      : `${prompt}\n`;
    mod.persistV4ComposerDraft(params.workspacePath, params.workspaceIdentity, params.scopeId, {
      ...existing,
      text,
    });
  });
}
