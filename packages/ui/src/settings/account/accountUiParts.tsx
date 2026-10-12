/**
 * 「账号」分区的共用页内小组件。
 *
 * 只有两件事值得单独成文件：卡片标题条（`SettingsGroupCard` 自身不带标题，
 * 各卡片手写标题会慢慢漂成两种字号/间距）和「值 + 说明」的行内文本块。
 */
import type { ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 卡片标题条：与 `SettingsRow` 的分隔线共用同一套边框语言。 */
export function AccountCardHeader({ titleId }: { titleId: string }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="border-b border-border px-4 py-3 text-ui-base font-medium text-foreground">
      {intl.formatMessage({ id: titleId })}
    </div>
  );
}

/** 卡片底部说明（一行灰字），用于交代口径来源这类必须说清但不能抢焦点的话。 */
export function AccountCardNote({ children }: { children: ReactNode }) {
  return <p className="px-4 pb-3 text-ui-base leading-6 text-foreground-subtle">{children}</p>;
}

/** 空态：取不到数据时如实说明，不留空白卡片让人以为界面坏了。 */
export function AccountEmptyNote({ messageId }: { messageId: string }) {
  const { intl } = useZCodeIntl();
  return (
    <p className="px-4 py-3 text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: messageId })}
    </p>
  );
}
