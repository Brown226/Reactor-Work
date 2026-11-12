/**
 * useReactorServer —— 企业服务端（Reactor Server）登录态。
 *
 * 只做「读状态 + 转发动作」两件事：令牌、企业 provider 与网关鉴权材料都由
 * `IReactorServerService` 独占持有，UI 不缓存任何凭据，也不直接读写 provider 配置。
 * 因此这里的状态一律以服务端返回的 `ReactorServerStatus` 为准，动作完成后重新拉取。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ReactorServerLoginInput,
  ReactorServerStatus,
  ReactorServerUsageOverview,
} from "@zcode/services";
import { useServices } from "./useServices.js";
import { useOptionalPlatform } from "./usePlatform.js";
import { useRestartForDataScopeSwitch } from "./useRestartForDataScopeSwitch.js";

export type ReactorServerAction =
  | "login"
  | "logout"
  | "changePassword"
  | "syncModels"
  | "refreshUsage";

export interface UseReactorServerResult {
  status: ReactorServerStatus | null;
  /**
   * 用量/策略简报（P4.1 做-4）。`null` = 尚未取到（加载中或未登录）：
   * 月度累计只有服务端权威值，不拿本地队列冒充（见 P4 文档 §7-4）。
   */
  overview: ReactorServerUsageOverview | null;
  /** 首次状态拉取中（用于整段骨架，不要和动作中的 busy 混用）。 */
  loading: boolean;
  /** 正在执行的动作；null 表示空闲。 */
  busy: ReactorServerAction | null;
  error: string | null;
  refresh: () => Promise<void>;
  login: (input: ReactorServerLoginInput) => Promise<boolean>;
  logout: () => Promise<boolean>;
  /** 自助修改密码（设置页与强制改密弹窗共用）；成功后 mustChangePassword 被清掉。 */
  changePassword: (oldPassword: string, newPassword: string) => Promise<boolean>;
  syncModels: () => Promise<boolean>;
  refreshUsage: () => Promise<boolean>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useReactorServer(): UseReactorServerResult {
  // 该 hook 只在「接入企业服务端的 host」上挂载（设置页账号分区 / 登录页），
  // 这些 host 必定提供 reactorServerService。Web 前端不挂载本 hook。
  const { reactorServerService } = useServices();
  const reactorServer = reactorServerService!;
  const platform = useOptionalPlatform();
  // 登录/登出会改写本机数据命名空间（企业用户隔离），成功后必须重启应用才生效。
  const restartForDataScopeSwitch = useRestartForDataScopeSwitch();
  const [status, setStatus] = useState<ReactorServerStatus | null>(null);
  const [overview, setOverview] = useState<ReactorServerUsageOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ReactorServerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 设置页可能在登录请求返回前被关闭/重挂：用请求号丢弃过期结果，避免旧状态覆盖新的登录态。
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const next = await reactorServer.getStatus();
      if (requestIdRef.current !== requestId) return;
      setStatus(next);
      setError(null);
      // 简报依赖登录态（未登录直接返回空视图），因此状态先落地再拉简报：
      // 两者并行会让"退出登录后还闪一下上个月用量"。
      const nextOverview = await reactorServer.getUsageOverview();
      if (requestIdRef.current !== requestId) return;
      setOverview(nextOverview);
    } catch (cause) {
      if (requestIdRef.current !== requestId) return;
      setError(getErrorMessage(cause));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [reactorServer]);

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
        // Web 没有 Electron RelaunchApp：登出必须同时吊销网关会话并回到登录页，
        // 否则浏览器会话还在，worker 却已登出，下一次登录会复用旧 uid 的 worker。
        if (action === "logout" && platform?.webSessionAuth === true) {
          await fetch("/api/auth/logout", {
            method: "POST",
            credentials: "same-origin",
            signal: AbortSignal.timeout(5_000),
          }).catch(() => undefined);
          window.location.reload();
          return true;
        }
        // 身份切换即数据切换：登出后不回本地态、登录后不进该用户命名空间，
        // 同一台机器上的下一个用户就会看到上一任的任务与消息（方案文档 §1）。
        // 重启必须排在状态刷新**之前**：刷新走 host 的登录态查询，过期会话的令牌刷新
        // 可能挂起数十秒（实测 51s / 54s），等它走完才重启，用户感知就是"点了登录卡几分钟"。
        // 反正进程马上重启，重启前的状态投影没有读者。
        if (action === "login" || action === "logout") {
          await restartForDataScopeSwitch();
        }
        if (requestIdRef.current !== requestId) return true;
        setStatus(await reactorServer.getStatus());
        setOverview(await reactorServer.getUsageOverview());
        return true;
      } catch (cause) {
        if (requestIdRef.current === requestId) setError(getErrorMessage(cause));
        return false;
      } finally {
        if (requestIdRef.current === requestId) setBusy(null);
      }
    },
    [platform, reactorServer, restartForDataScopeSwitch],
  );

  const login = useCallback(
    (input: ReactorServerLoginInput) => runAction("login", () => reactorServer.login(input)),
    [reactorServerService, runAction],
  );
  const logout = useCallback(
    () => runAction("logout", () => reactorServer.logout()),
    [reactorServerService, runAction],
  );
  const syncModels = useCallback(
    () => runAction("syncModels", () => reactorServer.syncModels()),
    [reactorServerService, runAction],
  );
  // 改密码不是身份切换：不触发数据命名空间重启（runAction 只对 login/logout 重启），
  // 否则用户改完密码会被强行重启一次，且改密弹窗的状态全丢。
  const changePassword = useCallback(
    (oldPassword: string, newPassword: string) =>
      runAction("changePassword", () =>
        reactorServer.changePassword(oldPassword, newPassword),
      ),
    [reactorServerService, runAction],
  );
  // 手动刷新简报：补传一次积压 + 重新拉服务端月度累计（策略不在此列，走 refreshPolicy 的既有触发点）。
  const refreshUsage = useCallback(
    () => runAction("refreshUsage", () => reactorServer.flushUsageReports()),
    [reactorServerService, runAction],
  );

  return {
    status,
    overview,
    loading,
    busy,
    error,
    refresh,
    login,
    logout,
    changePassword,
    syncModels,
    refreshUsage,
  };
}
