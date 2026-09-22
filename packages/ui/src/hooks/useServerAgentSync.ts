/**
 * useServerAgentSync —— 企业服务端专家同步（server-agents）。
 *
 * 只做「转发动作 + 展示结果」：server-agents 目录的唯一写者是 host 侧
 * `IServerAgentSyncService`，UI 不碰文件、不缓存 token（契约 docs/服务端接线-P3-Agent下发.md）。
 *
 * 与 useServerSkillSync 的差异：动作失败**向上抛**（服务端 409 等原文需要调用方 toast），
 * 因此各回调均返回稳定的 Promise，失败时调用方自行 try/catch。
 */
import { useCallback, useState } from "react";
import type { ServerAgentDefinition } from "@zcode/shared";
import type { IServerAgentSyncService, ServerAgentSyncResult } from "@zcode/services";
import { useServices } from "./useServices.js";

export interface UseServerAgentSyncResult {
  /** host 未提供该服务（旧 wire / 测试 double）时为 false，UI 应整体隐藏入口。 */
  available: boolean;
  /** 正在执行同步/安装/卸载/启停。 */
  busy: boolean;
  /** 最近一次结果（含目录投影与离线/鉴权失效标记）。 */
  result: ServerAgentSyncResult | null;
  /** 最近一次失败信息（成功后清空）。 */
  error: string | null;
  /** 全量对齐；失败抛出。未登录/离线由结果标记表达，不抛。 */
  sync: () => Promise<ServerAgentSyncResult>;
  /** host 进程内最近一次成功同步的目录（不联网；首帧渲染用）。 */
  getCatalog: () => Promise<readonly ServerAgentDefinition[]>;
  install: (name: string) => Promise<ServerAgentSyncResult>;
  uninstall: (name: string) => Promise<ServerAgentSyncResult>;
  setInstallEnabled: (name: string, enabled: boolean) => Promise<ServerAgentSyncResult>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useServerAgentSync(): UseServerAgentSyncResult {
  const services = useServices();
  const service: IServerAgentSyncService | undefined = services.serverAgentSyncService;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ServerAgentSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runResult = useCallback(
    async (operation: () => Promise<ServerAgentSyncResult>): Promise<ServerAgentSyncResult> => {
      setBusy(true);
      setError(null);
      try {
        const next = await operation();
        setResult(next);
        return next;
      } catch (cause) {
        setError(toMessage(cause));
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const requireService = useCallback((): IServerAgentSyncService => {
    if (!service) throw new Error("当前会话不支持企业专家同步");
    return service;
  }, [service]);

  const sync = useCallback(
    () => runResult(() => requireService().sync()),
    [requireService, runResult],
  );

  const getCatalog = useCallback(
    async () => (service ? service.getCatalog() : ([] as readonly ServerAgentDefinition[])),
    [service],
  );

  const install = useCallback(
    (name: string) => runResult(() => requireService().install(name)),
    [requireService, runResult],
  );

  const uninstall = useCallback(
    (name: string) => runResult(() => requireService().uninstall(name)),
    [requireService, runResult],
  );

  const setInstallEnabled = useCallback(
    (name: string, enabled: boolean) =>
      runResult(() => requireService().setInstallEnabled(name, enabled)),
    [requireService, runResult],
  );

  return {
    available: Boolean(service),
    busy,
    result,
    error,
    sync,
    getCatalog,
    install,
    uninstall,
    setInstallEnabled,
  };
}
