/**
 * composer 文本插入请求的纯逻辑（可 `npx tsx --test` 直接单测）：
 * 目标会话归属判定 + 草稿槽追加拼接。
 *
 * 背景（bug 依据）：`requestComposerTextInsert` 的请求存放在 **workspace 级** store 里，
 * 同一个 workspace 下的草稿 pane 与多个会话 pane 会同时读到同一份请求。请求原先没有目标
 * 会话标识，消费侧只能一刀切「只在新建任务态（sessionId === null）应用」，于是已有会话里
 * 点 PDF「引用进会话」/ GenUI 动作回传时，文本被写进根草稿槽 `__draft__`，当前会话输入框
 * 看不到任何东西。
 *
 * 修复：请求携带目标会话标识，消费侧按标识精确匹配——草稿 composer 只吃无目标请求，
 * 会话 composer 只吃目标等于自己的请求。判定与拼接在这里收口，避免 store、SessionPane、
 * PDF 与 GenUI 两条链路各写一份。
 */

/** 归一化目标会话：空白串与 null/undefined 同义，都表示「新建任务草稿槽」。 */
export function normalizeComposerTextInsertSessionId(sessionId?: string | null): string | null {
  const trimmed = sessionId?.trim();
  return trimmed ? trimmed : null;
}

/**
 * 请求是否命中该 composer。
 * - 草稿 pane（composerSessionId 为空）：只应用无目标请求（Example Prompt / 商店预填等）。
 * - 会话 pane：只应用目标等于本会话的请求（PDF 引用 / GenUI 动作回传）。
 */
export function matchesComposerTextInsertTarget(
  request: { sessionId?: string | null } | null | undefined,
  composerSessionId?: string | null,
): boolean {
  if (!request) return false;
  return (
    normalizeComposerTextInsertSessionId(request.sessionId) ===
    normalizeComposerTextInsertSessionId(composerSessionId)
  );
}

/**
 * 草稿槽追加拼接：新块另起一段，已有正文原样保留（含用户手输内容及它自己的换行）。
 * PDF 引用与 GenUI 动作回传共用，保证「追加而非覆盖」在无会话降级路径上同样成立。
 */
export function appendBlockToComposerDraftText(
  existingText: string | null | undefined,
  block: string,
): string {
  const nextBlock = block.trim();
  const existing = existingText?.trim() ? existingText.trimEnd() : "";
  return existing ? `${existing}\n\n${nextBlock}\n` : `${nextBlock}\n`;
}
