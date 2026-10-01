/**
 * 技能套件弹层（M2/M3 #13）：列出套件成员 + 整套安装。
 *
 * 数据经 `detailLoader`（→ `GET /me/bundles/:id`）按需拉取，加载/失败/进度由本组件
 * 局部 state 承担；整套安装走服务端 bundle install 端点（可见且 enabled 的成员逐个写安装），
 * 完成后**重新拉详情**以服务端口径展示「装成 n/m」——部分成功如实显示，不在本地推算。
 */
import { useCallback, useEffect, useState } from "react";
import { PackageOpen } from "lucide-react";
import type { ServerSkillBundleDetail } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface SkillBundleDialogProps {
  /** 打开的套件 id；null = 关闭。 */
  bundleId: number | null;
  /** 市场级 busy（hook 安装动作进行中）；用于禁用按钮防重复提交。 */
  busy: boolean;
  onClose: () => void;
  /** 套件详情加载通道：失败向上抛，由本组件展示失败态。 */
  detailLoader: (id: number) => Promise<ServerSkillBundleDetail>;
  /** 整套安装：失败向上抛（本组件展示错误），成功后由本组件重拉详情刷新 n/m。 */
  onInstall: (id: number) => Promise<void>;
}

type DetailState = "loading" | "ready" | "error";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SkillBundleDialog({
  bundleId,
  busy,
  onClose,
  detailLoader,
  onInstall,
}: SkillBundleDialogProps) {
  const { intl } = useZCodeIntl();
  const [detail, setDetail] = useState<ServerSkillBundleDetail | null>(null);
  const [detailState, setDetailState] = useState<DetailState>("loading");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 最近一次整套安装的结果口径：all = 全装上；partial = 装成 n/m（部分成员不可见/未启用）。 */
  const [installNotice, setInstallNotice] = useState<"all" | "partial" | null>(null);

  const refreshDetail = useCallback(
    async (id: number): Promise<ServerSkillBundleDetail | null> => {
      try {
        const next = await detailLoader(id);
        setDetail(next);
        setDetailState("ready");
        setDetailError(null);
        return next;
      } catch (cause) {
        setDetailState("error");
        setDetailError(toMessage(cause));
        return null;
      }
    },
    [detailLoader],
  );

  useEffect(() => {
    if (bundleId === null) return;
    let active = true;
    setDetail(null);
    setDetailState("loading");
    setDetailError(null);
    setActionError(null);
    setInstallNotice(null);
    setInstalling(false);
    void detailLoader(bundleId)
      .then((next) => {
        if (active) {
          setDetail(next);
          setDetailState("ready");
        }
      })
      .catch((cause) => {
        if (active) {
          setDetailState("error");
          setDetailError(toMessage(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [bundleId, detailLoader]);

  const handleInstall = useCallback(async () => {
    if (bundleId === null || detailState !== "ready" || !detail) return;
    setInstalling(true);
    setActionError(null);
    setInstallNotice(null);
    try {
      await onInstall(bundleId);
      // 重拉详情：装成 n/m 以服务端口径为准（部分成员不可见/未启用时如实显示部分成功）。
      const next = await refreshDetail(bundleId);
      if (next) setInstallNotice(next.allInstalled ? "all" : "partial");
    } catch (cause) {
      setActionError(toMessage(cause));
      // 失败也重拉一次：服务端可能已写入部分成员，界面不滞留旧数字。
      await refreshDetail(bundleId);
    } finally {
      setInstalling(false);
    }
  }, [bundleId, detail, detailState, onInstall, refreshDetail]);

  const installing_ = installing || busy;
  const open = bundleId !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {bundleId !== null ? (
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <div className="flex min-w-0 items-start gap-3 pr-8">
            <div
              aria-hidden="true"
              className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-background text-ui-lg text-foreground-subtle ring-1 ring-border"
            >
              {detail?.icon || <PackageOpen className="size-5" aria-hidden="true" />}
            </div>
            <DialogHeader className="min-w-0 flex-1">
              <DialogTitle className="truncate text-ui-lg font-semibold">
                {detailState === "ready" && detail
                  ? detail.title
                  : intl.formatMessage({ id: "marketplace.bundle.title" })}
              </DialogTitle>
              {detailState === "ready" && detail ? (
                <p className="text-ui-sm text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "marketplace.bundle.installedProgress" },
                    { installed: detail.installedCount, total: detail.memberCount },
                  )}
                </p>
              ) : null}
            </DialogHeader>
          </div>

          {detailState === "loading" ? (
            <p className="text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "marketplace.bundle.detailLoading" })}
            </p>
          ) : detailState === "error" ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
              {intl.formatMessage({ id: "marketplace.bundle.detailFailed" })}
              {detailError ? `：${detailError}` : ""}
            </div>
          ) : detail ? (
            <>
              {detail.description ? (
                <p className="text-ui-base text-foreground-subtle">{detail.description}</p>
              ) : null}

              {/* 整套安装：服务端幂等；全部装上后按钮置灰，部分成功如实显示 n/m。 */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={installing_ || detail.allInstalled}
                  onClick={() => void handleInstall()}
                >
                  {installing_
                    ? intl.formatMessage({ id: "marketplace.bundle.installing" })
                    : detail.allInstalled
                      ? intl.formatMessage({ id: "marketplace.bundle.allInstalled" })
                      : intl.formatMessage({ id: "marketplace.bundle.installAll" })}
                </Button>
              </div>

              {actionError ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
                  {intl.formatMessage({ id: "marketplace.bundle.installFailed" })}
                  {actionError ? `：${actionError}` : ""}
                </div>
              ) : null}
              {!actionError && installNotice === "all" ? (
                <p className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "marketplace.bundle.installDone" },
                    { total: detail.memberCount },
                  )}
                </p>
              ) : null}
              {!actionError && installNotice === "partial" ? (
                <p className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "marketplace.bundle.installPartial" },
                    { installed: detail.installedCount, total: detail.memberCount },
                  )}
                </p>
              ) : null}

              <div className="space-y-1.5">
                <h4 className="flex items-center gap-1.5 text-ui-base font-medium text-foreground">
                  <PackageOpen className="size-4 text-foreground-subtle" aria-hidden="true" />
                  {intl.formatMessage({ id: "marketplace.bundle.members" })}
                  {detail.members.length > 0 ? ` (${detail.members.length})` : ""}
                </h4>
                {detail.members.length > 0 ? (
                  <ul className="space-y-1 rounded-lg bg-surface p-2">
                    {detail.members.map((member) => (
                      <li
                        key={member.name}
                        className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1"
                      >
                        <span
                          aria-hidden="true"
                          className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-background text-ui-sm text-foreground-subtle ring-1 ring-border"
                        >
                          {member.icon || member.title.slice(0, 1)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-ui-sm font-medium text-foreground">
                            {member.title}
                          </span>
                          {member.description ? (
                            <span className="block truncate text-ui-xs text-foreground-subtlest">
                              {member.description}
                            </span>
                          ) : null}
                        </span>
                        {member.installed ? (
                          <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
                            {intl.formatMessage({ id: "marketplace.card.installed" })}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-lg bg-surface px-3 py-3 text-center text-ui-sm text-foreground-subtlest">
                    {intl.formatMessage({ id: "marketplace.bundle.noMembers" })}
                  </p>
                )}
              </div>
            </>
          ) : null}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
