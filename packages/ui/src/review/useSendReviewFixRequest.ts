/**
 * 「把我采纳的审查问题改掉」= 发一轮新对话（不含附件、不走草稿）。
 *
 * 为什么直接发而不是预填：预填通道（`requestComposerTextInsert`）现在已经能在已有会话里生效
 * （见 P0-2 修复：请求带目标 sessionId + append 语义），但「一键修改」要的是**立刻开始改**，
 * 不是让用户再点一次发送 —— 预填会把这一步退化成两步操作。所以这里仍走协议原语：
 * `sendText` 命令（非 CAS、行级目标无关），幂等由 `commandId` 保证，
 * busy/running 时的入队/抢占由 CLI 按 `inputRouting` 裁决，UI 不自行判断。
 *
 * 标记的清理：**accepted / duplicate 才清**。rejected/stale/failed 时保留，用户改完队列状态能再点一次；
 * 清掉也不会丢信息 —— 整份清单就在刚发出的那条消息里。
 */
import { useCallback, useMemo, useState } from "react";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { buildReviewFixPrompt } from "@/review/reviewFixRequest.js";
import { selectSortedReviewMarks, useReviewMarksStore } from "@/store/reviewMarksStore.js";

export interface ReviewFixSendResult {
  ok: boolean;
  /** 失败时的原因码（协议 ack 的 status 或本地前置条件），用于提示文案 */
  reason: "no-session" | "no-marks" | "sending" | "rejected" | "stale" | "failed" | null;
}

export function useSendReviewFixRequest(
  /** 当前会话 id（由行渲染上下文传下来）：面板可能出现在没有 provider 的地方，所以不从这里取 */
  sessionId: string | null,
): {
  send: () => Promise<ReviewFixSendResult>;
  count: number;
  sending: boolean;
} {
  const { sendCommand } = useV4Conversation();
  // 只订阅 marks 本身（引用稳定），排序放在 useMemo 里做：selector 每次返回新数组会被
  // useSyncExternalStore 判定为「快照每次都变」，直接把整个会话区域打进无限重渲染。
  const marks = useReviewMarksStore((state) => state.marks);
  const sorted = useMemo(() => selectSortedReviewMarks({ marks }), [marks]);
  const [sending, setSending] = useState(false);

  const send = useCallback(async (): Promise<ReviewFixSendResult> => {
    if (!sessionId) return { ok: false, reason: "no-session" };
    const prompt = buildReviewFixPrompt(selectSortedReviewMarks(useReviewMarksStore.getState()));
    if (!prompt) return { ok: false, reason: "no-marks" };
    if (sending) return { ok: false, reason: "sending" };
    setSending(true);
    try {
      const ack = await sendCommand(
        createCommandEnvelope({ type: "sendText", sessionId, payload: { text: prompt } }),
      );
      if (ack.status === "accepted" || ack.status === "duplicate") {
        useReviewMarksStore.getState().clear();
        return { ok: true, reason: null };
      }
      if (ack.status === "rejected" || ack.status === "stale" || ack.status === "noop") {
        return { ok: false, reason: "rejected" };
      }
      return { ok: false, reason: "failed" };
    } catch {
      return { ok: false, reason: "failed" };
    } finally {
      setSending(false);
    }
  }, [sendCommand, sending, sessionId]);

  return { send, count: sorted.length, sending };
}
