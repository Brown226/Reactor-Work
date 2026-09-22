/**
 * useServerSkillSync —— 企业服务端技能同步（server-skills）。
 *
 * 只做「转发动作 + 展示结果」：server-skills 目录的唯一写者是 host 侧
 * `IServerSkillSyncService`，UI 不碰文件、不缓存 token（契约 docs/server-skill-sync.md）。
 */
import { useCallback, useRef, useState } from "react";
import type { IServerSkillSyncService, ServerSkillSyncResult } from "@zcode/services";
import { useServices } from "./useServices.js";

export interface UseServerSkillSyncResult {
  /** host 未提供该服务（旧 wire / 测试 double）时为 false，UI 应整体隐藏入口。 */
  available: boolean;
  /** 正在执行同步/卸载/更新。 */
  busy: boolean;
  /** 最近一次结果（含「已下架」投影与离线/鉴权失效标记）。 */
  result: ServerSkillSyncResult | null;
  error: string | null;
  sync: () => Promise<ServerSkillSyncResult | null>;
  uninstall: (name: string) => Promise<boolean>;
  refreshFromServer: (name: string) => Promise<ServerSkillSyncResult | null>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useServerSkillSync(): UseServerSkillSyncResult {
  const services = useServices();
  const service: IServerSkillSyncService | undefined = services.serverSkillSyncService;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ServerSkillSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 弹窗关闭/重挂时丢弃过期动作结果，避免旧请求覆盖新状态。
  const requestIdRef = useRef(0);

  const run = useCallback(
    async (
      operation: () => Promise<ServerSkillSyncResult | null>,
    ): Promise<ServerSkillSyncResult | null> => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setBusy(true);
      setError(null);
      try {
        const next = await operation();
        if (requestIdRef.current !== requestId) return next;
        if (next) setResult(next);
        return next;
      } catch (cause) {
        if (requestIdRef.current === requestId) setError(getErrorMessage(cause));
        return null;
      } finally {
        if (requestIdRef.current === requestId) setBusy(false);
      }
    },
    [],
  );

  const sync = useCallback(async () => {
    if (!service) return null;
    return run(() => service.sync());
  }, [run, service]);

  const uninstall = useCallback(
    async (name: string) => {
      if (!service) return false;
      try {
        await service.uninstall(name);
        return true;
      } catch (cause) {
        setError(getErrorMessage(cause));
        return false;
      }
    },
    [service],
  );

  const refreshFromServer = useCallback(
    async (name: string) => {
      if (!service) return null;
      return run(() => service.refreshFromServer(name));
    },
    [run, service],
  );

  return {
    available: Boolean(service),
    busy,
    result,
    error,
    sync,
    uninstall,
    refreshFromServer,
  };
}
