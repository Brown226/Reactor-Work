/**
 * 专家介绍弹层（专家·技能市场 M1，方案 §5.4 线框）。
 * 点击专家卡片打开；动作全部转发给 P3 `IServerAgentSyncService`（经 MarketPage），
 * 安装关系真相在服务端，本组件只渲染与发命令。
 */
import { Lightbulb, MessageCircle } from "lucide-react";
import type { ServerAgentDefinition } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ExpertDetailDialogProps {
  agent: ServerAgentDefinition | null;
  busy: boolean;
  onClose: () => void;
  onInstall: (name: string) => void;
  onUninstall: (name: string) => void;
  onToggleEnabled: (name: string, enabled: boolean) => void;
  /** starters 行点击 = 新建会话并预填；未安装或宿主无入口时为 undefined（整块隐藏）。 */
  onStarter?: (prompt: string) => void;
}

function formatUses(count: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(count);
}

export function ExpertDetailDialog({
  agent,
  busy,
  onClose,
  onInstall,
  onUninstall,
  onToggleEnabled,
  onStarter,
}: ExpertDetailDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const showStarters = Boolean(onStarter && agent && agent.starters.length > 0);

  return (
    <Dialog
      open={agent !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {agent ? (
        <DialogContent className="max-w-lg">
          <div className="flex min-w-0 items-start gap-3 pr-8">
            <div
              aria-hidden="true"
              className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-background text-ui-lg text-foreground-subtle ring-1 ring-border"
            >
              {agent.emoji || agent.title.slice(0, 1)}
            </div>
            <DialogHeader className="min-w-0 flex-1">
              <DialogTitle className="truncate text-ui-lg font-semibold">
                {agent.title}
                {agent.author ? (
                  <span className="text-ui-base font-normal text-foreground-subtle">
                    {" │ "}
                    {agent.author}
                  </span>
                ) : null}
              </DialogTitle>
              <p className="text-ui-sm text-foreground-subtlest">
                {intl.formatMessage(
                  { id: "marketplace.dialog.uses" },
                  { count: formatUses(agent.uses, locale) },
                )}
              </p>
            </DialogHeader>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {agent.installed ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    onToggleEnabled(agent.name, !(agent.installed && agent.installEnabled))
                  }
                >
                  {agent.installEnabled
                    ? intl.formatMessage({ id: "marketplace.dialog.disable" })
                    : intl.formatMessage({ id: "marketplace.dialog.enable" })}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => onUninstall(agent.name)}
                >
                  {intl.formatMessage({ id: "marketplace.dialog.uninstall" })}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={busy}
                onClick={() => onInstall(agent.name)}
              >
                {intl.formatMessage({ id: "marketplace.dialog.install" })}
              </Button>
            )}
            {/* M2：以此专家开会话薄封装（P3 §4.4 预留）；M1 只占位不实现召唤。 */}
            <Button type="button" variant="outline" size="sm" disabled>
              {intl.formatMessage({ id: "marketplace.dialog.summon" })}
            </Button>
          </div>

          <p className="text-ui-base text-foreground-subtle">
            {agent.description ||
              (agent.persona ? agent.persona.slice(0, 160) : "") ||
              intl.formatMessage({ id: "marketplace.dialog.noDescription" })}
          </p>

          {agent.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {agent.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex min-h-5 items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          {showStarters ? (
            <div className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-ui-base font-medium text-foreground">
                <Lightbulb className="size-4 text-foreground-subtle" aria-hidden="true" />
                {intl.formatMessage({ id: "marketplace.dialog.startersExpert" })}
              </h4>
              {agent.starters.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  disabled={busy}
                  onClick={() => onStarter?.(starter)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:opacity-60"
                >
                  <span className="min-w-0 truncate text-ui-base text-foreground">“{starter}”</span>
                  <MessageCircle
                    className="size-4 shrink-0 text-foreground-subtle"
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          ) : null}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
