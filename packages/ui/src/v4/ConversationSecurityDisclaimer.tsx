import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

/**
 * 输入区合规提示：新建任务首页（面板右下角，右对齐）与会话对话页
 * （输入卡与面板底边之间的空隙，居中）共用同一份文案与同一个组件。
 *
 * 纯展示：无 state、无服务依赖；草稿态那份带 pointer-events-none，不占角落命中。
 * 文案唯一来源是 i18n key `chat.securityDisclaimer`；渲染挂点在 SessionPane，
 * 按 isDraft 二选一（草稿态绝对定位于面板右下角，会话态在 composer dock 内）——
 * 见 docs/已完成/已完成-conversation-security-disclaimer.md。
 */
export function ConversationSecurityDisclaimer({ className }: { className?: string }) {
  const { intl } = useZCodeIntl();

  return (
    <p
      data-v4-conversation-security-disclaimer="true"
      className={cn("px-1 text-ui-sm text-foreground-subtle", className)}
    >
      {intl.formatMessage({ id: "chat.securityDisclaimer" })}
    </p>
  );
}
