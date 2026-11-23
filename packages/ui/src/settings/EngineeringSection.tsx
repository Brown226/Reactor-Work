/**
 * 工程软件设置分区：能力总览 + 只读环境诊断。
 *
 * 职责边界：
 * - 只回答「本机能用哪些工程软件、能做什么、环境缺什么」，不管理连接。MCP server
 *   是 CLI 子进程，desktop host 是另一个进程，两边连接状态不共享，这里若显示
 *   「已连接」会误导用户。
 * - 不启动软件、不改配置、不写盘，全部来自 `diagnose()` 的只读探测。
 *
 * 为什么要有「能力总览」：诊断只回答「缺什么」，用户看完仍不知道装了能干什么。
 * 能力段回答「能调用多少函数、走什么接口、对应哪个技能包、可以怎么开口」。
 *
 * 数据源由桌面端经 IPC 注入（`loadReport`）。未注入时如实说明「接口尚未接入」，
 * 不伪造空结果。
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, CircleMinus, LoaderCircle, RefreshCw } from "lucide-react";
import type {
  EngineeringCapability,
  EngineeringCheckLevel,
  EngineeringDiagnosticCheck,
  EngineeringDiagnosticReport,
} from "@zcode/shared";

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

/** 分级兜底：旧宿主不返回 level 时按 ok 推导，避免把未安装渲染成故障。 */
function levelOf(check: EngineeringDiagnosticCheck): EngineeringCheckLevel {
  return check.level ?? (check.ok ? "ok" : "error");
}

function CheckIcon({ level }: { level: EngineeringCheckLevel }) {
  if (level === "ok") {
    return <CircleCheck className="mt-0.5 size-4 shrink-0 text-green-500" aria-hidden="true" />;
  }
  if (level === "missing") {
    // 未安装是正常态，用灰色减号，不用红色告警。
    return (
      <CircleMinus className="mt-0.5 size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
    );
  }
  return <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />;
}

function CapabilityCard({
  capability,
  t,
}: {
  capability: EngineeringCapability;
  t: (id: string, values?: Record<string, string | number>) => string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-ui-base font-medium text-foreground">
          {capability.productName}
        </div>
        <span
          className={
            capability.installed
              ? "shrink-0 text-ui-caption text-green-600"
              : "shrink-0 text-ui-caption text-foreground-subtlest"
          }
        >
          {t(
            capability.installed
              ? "settings.engineering.installed"
              : "settings.engineering.notInstalled",
          )}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-ui-caption text-foreground-subtle">
        <span>{t("settings.engineering.bridge", { name: capability.bridge })}</span>
        {capability.functionCount > 0 ? (
          <span>
            {t("settings.engineering.functionCount", { count: capability.functionCount })}
          </span>
        ) : null}
        {capability.skillDir ? (
          <span>{t("settings.engineering.skill", { name: capability.skillDir })}</span>
        ) : null}
      </div>

      {capability.exePath ? (
        <p className="mt-1 break-all text-ui-caption text-foreground-subtlest">
          {capability.exePath}
        </p>
      ) : null}

      {capability.hint ? (
        <p className="mt-2 text-ui-sm text-foreground">{`“${capability.hint}”`}</p>
      ) : null}
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

  const t = useCallback(
    (id: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id }, values as never),
    [intl],
  );

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
  // 桌面端主进程自带一份 @zcode/services 构建产物，可能与当前 UI 包不同版本：
  // 旧版 diagnose() 不返回 capabilities/supported/checks，直接读 length 会抛
  // "Cannot read properties of undefined"，把整个设置页打进错误边界。这里统一兜底为空数组。
  const capabilities = state.status === "ready" ? (state.report.capabilities ?? []) : [];
  const supported = state.status === "ready" ? (state.report.supported ?? []) : [];
  const checks = state.status === "ready" ? (state.report.checks ?? []) : [];

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-ui-lg font-semibold text-foreground">
          {t("settings.engineering.title")}
        </h2>
        <p className="text-ui-sm text-foreground-subtle">{t("settings.engineering.description")}</p>
      </header>

      {capabilities.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-ui-base font-medium text-foreground">
            {t("settings.engineering.capabilities")}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {capabilities.map((capability) => (
              <CapabilityCard key={capability.server} capability={capability} t={t} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <h3 className="text-ui-base font-medium text-foreground">
          {t("settings.engineering.diagnostics")}
        </h3>

        <SettingsGroupCard>
          <div className="flex items-center justify-between gap-4 px-6 py-4">
            <div className="min-w-0 space-y-1">
              <div className="text-ui-base font-medium text-foreground">{summary}</div>
              {supported.length > 0 ? (
                <div className="break-words text-ui-caption text-foreground-subtle">
                  {supported.join(" · ")}
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
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-ui-base text-foreground">
                  {t("settings.engineering.summaryUnhealthy")}
                </div>
                <p className="break-words text-ui-sm text-foreground-subtle">{state.message}</p>
              </div>
            </div>
          ) : null}

          {state.status === "ready"
            ? checks.map((check) => (
                <div
                  key={check.name}
                  className="flex items-start gap-3 border-t border-border px-6 py-3"
                >
                  <CheckIcon level={levelOf(check)} />
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
      </section>
    </div>
  );
}
