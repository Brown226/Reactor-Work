/**
 * useReactorServer —— 企业服务端（Reactor Server）登录态。
 *
 * 只做「读状态 + 转发动作」两件事：令牌、企业 provider 与网关鉴权材料都由
 * `IReactorServerService` 独占持有，UI 不缓存任何凭据，也不直接读写 provider 配置。
 * 因此这里的状态一律以服务端返回的 `ReactorServerStatus` 为准，动作完成后重新拉取。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactorServerLoginInput, ReactorServerStatus } from "@zcode/services";
import { useServices } from "./useServices.js";

export type ReactorServerAction = "login" | "logout" | "syncModels";

export interface UseReactorServerResult {
  status: ReactorServerStatus | null;
  /** 首次状态拉取中（用于整段骨架，不要和动作中的 busy 混用）。 */
  loading: boolean;
  /** 正在执行的动作；null 表示空闲。 */
  busy: ReactorServerAction | null;
  error: string | null;
  refresh: () => Promise<void>;
  login: (input: ReactorServerLoginInput) => Promise<boolean>;
  logout: () => Promise<boolean>;
  syncModels: () => Promise<boolean>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useReactorServer(): UseReactorServerResult {
  const { reactorServerService } = useServices();
  const [status, setStatus] = useState<ReactorServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ReactorServerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 设置页可能在登录请求返回前被关闭/重挂：用请求号丢弃过期结果，避免旧状态覆盖新的登录态。
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const next = await reactorServerService.getStatus();
      if (requestIdRef.current !== requestId) return;
      setStatus(next);
      setError(null);
    } catch (cause) {
      if (requestIdRef.current !== requestId) return;
      setError(getErrorMessage(cause));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [reactorServerService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (action: ReactorServerAction, operation: () => Promise<unknown>): Promise<boolean> => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setBusy(action);
      setError(null);
      try {
        await operation();
        if (requestIdRef.current !== requestId) return true;
        setStatus(await reactorServerService.getStatus());
        return true;
      } catch (cause) {
        if (requestIdRef.current === requestId) setError(getErrorMessage(cause));
        return false;
      } finally {
        if (requestIdRef.current === requestId) setBusy(null);
      }
    },
    [reactorServerService],
  );

  const login = useCallback(
    (input: ReactorServerLoginInput) => runAction("login", () => reactorServerService.login(input)),
    [reactorServerService, runAction],
  );
  const logout = useCallback(
    () => runAction("logout", () => reactorServerService.logout()),
    [reactorServerService, runAction],
  );
  const syncModels = useCallback(
    () => runAction("syncModels", () => reactorServerService.syncModels()),
    [reactorServerService, runAction],
  );

  return { status, loading, busy, error, refresh, login, logout, syncModels };
}
