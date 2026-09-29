import { useCallback, useState } from "react";
import { genUiTreeKey, type GenUiTreeV1 } from "@zcode/shared";
import { useUiTreeStore } from "@/store/uiTreeStore.js";
import { GenUiTreeView, type GenUiActionEvent } from "./GenUiRegistry.js";

/**
 * 消息体内联入口：按 sessionId+messageId 订阅 UI 树。
 * 动作回传由宿主（消息行）提供 onAction，默认写入会话草稿。
 */
export function GenUiInline({
  sessionId,
  messageId,
  onAction,
}: {
  sessionId: string;
  messageId: string;
  onAction?: (event: GenUiActionEvent) => void;
}) {
  const key = genUiTreeKey(sessionId, messageId);
  const tree = useUiTreeStore((s: { treesByKey: Record<string, GenUiTreeV1 | undefined> }) => s.treesByKey[key]);
  const [expanded, setExpanded] = useState(true);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const handleAction = useCallback(
    (event: GenUiActionEvent) => {
      setLastAction(
        `[GenUI action] actionId=${event.actionId ?? ""}${event.formValues ? ` values=${JSON.stringify(event.formValues)}` : ""}`,
      );
      onAction?.(event);
    },
    [onAction],
  );

  if (!tree) return null;

  return (
    <div className="gen-ui-inline rounded-xl border border-border bg-surface/80 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Interactive UI
        </span>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "折叠" : "展开"}
        </button>
      </div>
      {expanded ? (
        <GenUiTreeView tree={tree as GenUiTreeV1} onAction={handleAction} />
      ) : null}
      {lastAction ? (
        <div className="mt-2 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
          {lastAction}
        </div>
      ) : null}
    </div>
  );
}
