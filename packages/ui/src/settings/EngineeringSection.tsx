/**
 * 工程软件设置分区：只读环境诊断。
 *
 * 职责边界：
 * - 只回答「本机环境能不能用」，不管理连接。MCP server 是 CLI 子进程，desktop host
 *   是另一个进程，两边连接状态不共享，这里若显示「已连接」会误导用户。
 * - 不启动软件、不改配置、不写盘，全部来自 `diagnose()` 的只读探测。
 *
 * 数据源由桌面端经 IPC 注入（`loadReport`）。未注入时如实说明「接口尚未接入」，
 * 不伪造空结果。
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, RefreshCw } from "lucide-react";
import type { EngineeringDiagnosticReport } from "@zcode/shared";

import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

export interface EngineeringSectionProps {
  /** 桌面端为 true；Web 与手机远控没有本机进程可探测。 */
  isDesktop: boolean;
  /** 桌面端注入的诊断数据源；缺省表示当前宿主尚未接入 IPC。 */
  loadReport?: () => Promise<EngineeringDiagnosticReport>;
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; report: EngineeringDiagnosticReport }
  | { status: "error"; message: string };

function Notice({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-6 py-5">
      <p className="text-ui-sm text-foreground-subtle">{text}</p>
    </div>
  );
}

export function EngineeringSection({ isDesktop, loadReport }: EngineeringSectionProps) {
  const { intl } = useZCodeIntl();
  const [state, setState] = useState<LoadState>({ status: "idle" });

  const refresh = useCallback(async () => {
    if (!loadReport) return;
    setState({ status: "loading" });
    try {
      const report = await loadReport();
      setState({ status: "ready", report });
    } catch (error) {
      // 诊断接口自身失败也要如实展示，不吞掉错误转成「全部正常」。
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [loadReport]);

  useEffect(() => {
    if (!loadReport) return;
    void refresh();
  }, [loadReport, refresh]);

  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);

  if (!isDesktop) {
    return <Notice text={t("settings.engineering.desktopOnly")} />;
  }
  if (!loadReport) {
    return <Notice text={t("settings.engineering.notWired")} />;
  }

  const loading = state.status === "loading";
  const summary =
    state.status === "ready"
      ? state.report.healthy
        ? t("settings.engineering.summaryHealthy")
        : t("settings.engineering.summaryUnhealthy")
      : t("settings.engineering.summaryPending");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-ui-lg font-semibold text-foreground">
          {t("settings.engineering.title")}
        </h2>
        <p className="text-ui-sm text-foreground-subtle">
          {t("settings.engineering.description")}
        </p>
      </header>

      <SettingsGroupCard>
        <div className="flex items-center justify-between gap-4 px-6 py-4">
          <div className="min-w-0 space-y-1">
            <div className="text-ui-base font-medium text-foreground">{summary}</div>
            {state.status === "ready" && state.report.supported.length > 0 ? (
              <div className="break-words text-ui-caption text-foreground-subtle">
                {state.report.supported.join(" · ")}
              </div>
            ) : null}
          </div>
          <Button
            type="button"
            size="lg"
            variant="outline"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-4" aria-hidden="true" />
            )}
            {t("settings.engineering.refresh")}
          </Button>
        </div>

        {state.status === "error" ? (
          <div className="flex items-start gap-3 border-t border-border px-6 py-3">
            <CircleAlert
              className="mt-0.5 size-4 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="text-ui-base text-foreground">
                {t("settings.engineering.summaryUnhealthy")}
              </div>
              <p className="break-words text-ui-sm text-foreground-subtle">{state.message}</p>
            </div>
          </div>
        ) : null}

        {state.status === "ready"
          ? state.report.checks.map((check) => (
              <div
                key={check.name}
                className="flex items-start gap-3 border-t border-border px-6 py-3"
              >
                {check.ok ? (
                  <CircleCheck
                    className="mt-0.5 size-4 shrink-0 text-green-500"
                    aria-hidden="true"
                  />
                ) : (
                  <CircleAlert
                    className="mt-0.5 size-4 shrink-0 text-destructive"
                    aria-hidden="true"
                  />
                )}
                <div className="min-w-0 space-y-1">
                  <div className="text-ui-base text-foreground">{check.name}</div>
                  <p className="break-words text-ui-sm text-foreground-subtle">{check.detail}</p>
                  {check.suggestion ? (
                    <p className="text-ui-caption text-foreground-subtlest">{check.suggestion}</p>
                  ) : null}
                </div>
              </div>
            ))
          : null}
      </SettingsGroupCard>
    </div>
  );
}
