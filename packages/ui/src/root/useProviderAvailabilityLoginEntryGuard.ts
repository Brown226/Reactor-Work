import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelSelectionView } from "@zcode/services";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import { logger } from "@/logger.js";

interface ProviderAvailabilityLoginEntryGuardResult {
  hasUsableProvider: boolean;
  providerCount: number;
  shouldOpenLoginEntry: boolean;
}

/**
 * 启动登录门禁：**未登录企业服务端一律停在登录页**。
 *
 * 历史：本 hook 原本是开源初版的"provider 可用性引导"——没配过 provider family 又没有可用模型时
 * 打开登录入口。企业化改造后在前面加了 `!hasEnterpriseSession &&`，但保留了可用性谓词，
 * 结果机器上只要存在本地 provider（或 providerFamilyDomain 有残留）就能绕过登录进工作区；
 * 读取 provider registry 失败时还会 fail-open。2026-10-09 收窄为**只看身份**：
 * 判定唯一输入是 `hasEnterpriseSession`，其余入参只用于日志与"已登录时的模型就绪"观测。
 * 契约见 `docs/已完成/已完成-model-governance-and-dev-mode.md` §1.2 / §4。
 *
 * 失败语义：provider registry 读取失败不再提前放行，按未登录处理（fail-closed）。
 */
export function useProviderAvailabilityLoginEntryGuard({
  enabled = true,
  isRestoringOAuthSession,
  isResolvingEnterpriseSession,
  hasEnterpriseSession,
  providerFamilyDomain,
  modelSelectionView,
  modelSelectionError,
  refreshProviderState,
  readModelSelectionView,
  setLoginEntryOpen,
}: {
  enabled?: boolean;
  isRestoringOAuthSession: boolean;
  isResolvingEnterpriseSession?: boolean;
  /** 已登录企业服务端即视为可用身份：企业登录是本产品唯一的登录方式。 */
  hasEnterpriseSession?: boolean;
  providerFamilyDomain: string | null | undefined;
  modelSelectionView: ModelSelectionView | null;
  modelSelectionError?: Error;
  refreshProviderState: () => Promise<void>;
  readModelSelectionView: () => Promise<ModelSelectionView>;
  setLoginEntryOpen: (open: boolean) => void;
}) {
  const [startupCheckCompleted, setStartupCheckCompleted] = useState(!enabled);
  const startupCheckCompletedRef = useRef(false);
  const providerAvailabilityHydrated = modelSelectionView !== null;

  const syncLoginEntryWithProviderAvailability = useCallback(
    async (options: { forceRefresh?: boolean; reason: string }) => {
      if (!enabled) {
        return {
          hasUsableProvider: true,
          providerCount: modelSelectionView?.providers.length ?? 0,
          shouldOpenLoginEntry: false,
        } satisfies ProviderAvailabilityLoginEntryGuardResult;
      }

      if (options.forceRefresh) {
        await refreshProviderState();
      }

      const refreshedView = options.forceRefresh
        ? await readModelSelectionView()
        : modelSelectionView;
      const availability = resolveProviderAvailabilityState({ modelSelectionView: refreshedView });
      const { hasUsableProvider, providerCount } = availability;
      // 门禁只看身份：未登录企业服务端就停在登录页，不再读 provider 可用性。
      // 本地 provider 的可见性由 modelScope 的开发者模式旁路决定，不构成免登录理由。
      const shouldOpenLoginEntry = !hasEnterpriseSession;

      logger.info("[Root] 登录门禁完成检查", {
        reason: options.reason,
        source: availability.source,
        providerCount,
        hasUsableProvider,
        hasEnterpriseSession: Boolean(hasEnterpriseSession),
        hasProviderFamilyDomain: Boolean(providerFamilyDomain),
        shouldOpenLoginEntry,
      });
      setLoginEntryOpen(shouldOpenLoginEntry);
      return {
        hasUsableProvider,
        providerCount,
        shouldOpenLoginEntry,
      } satisfies ProviderAvailabilityLoginEntryGuardResult;
    },
    [
      enabled,
      hasEnterpriseSession,
      modelSelectionView,
      providerFamilyDomain,
      refreshProviderState,
      readModelSelectionView,
      setLoginEntryOpen,
    ],
  );

  useEffect(() => {
    if (!enabled) {
      startupCheckCompletedRef.current = true;
      setStartupCheckCompleted(true);
      return;
    }

    if (modelSelectionError) {
      // fail-closed：读取失败不能证明"已登录"，按未登录打开登录页。
      // 之前的实现只结束启动等待、不打开登录入口，会让未登录用户直接进工作区。
      logger.error("[Root] provider 可用性读取失败，按未登录处理并打开登录页", modelSelectionError);
      startupCheckCompletedRef.current = true;
      setLoginEntryOpen(true);
      setStartupCheckCompleted(true);
      return;
    }

    if (
      startupCheckCompletedRef.current ||
      isRestoringOAuthSession ||
      isResolvingEnterpriseSession ||
      !providerAvailabilityHydrated
    ) {
      return;
    }

    startupCheckCompletedRef.current = true;
    void syncLoginEntryWithProviderAvailability({
      reason: "startup",
    }).finally(() => {
      setStartupCheckCompleted(true);
    });
  }, [
    enabled,
    isRestoringOAuthSession,
    isResolvingEnterpriseSession,
    modelSelectionError,
    providerAvailabilityHydrated,
    setLoginEntryOpen,
    syncLoginEntryWithProviderAvailability,
  ]);

  return {
    startupCheckCompleted,
    syncLoginEntryWithProviderAvailability,
  };
}
