/**
 * useServerSkillMarket —— 企业服务端技能市场（目录/精选/安装/收藏）。
 *
 * 只做「转发动作 + 维护内存投影」：市场目录的真相在服务端（`GET /me/skills/catalog`），
 * 磁盘落盘归 host 侧 `IServerSkillSyncService`（P2），本 hook 不碰文件、不缓存 token
 * （方案见 docs/未完成-专家技能市场-方案-v1.md §5.3）。失败向上收敛为 error/notice，不抛给调用方。
 */
import { useCallback, useEffect, useState } from "react";
import type {
  ServerSkillBundleDetail,
  ServerSkillBundleSummary,
  ServerSkillCatalogItem,
  ServerSkillDetail,
} from "@zcode/shared";
import type { ServerSkillCatalogSyncResult } from "@zcode/services";
import { useServices } from "./useServices.js";

export type ServerMarketNotice = "offline" | "authExpired" | "notLoggedIn";

export interface UseServerSkillMarketResult {
  available: boolean;
  busy: boolean;
  error: string | null;
  /** 最近一次目录动作的同步标记（离线/登录过期/未登录）；成功后清空。 */
  notice: ServerMarketNotice | null;
  catalog: readonly ServerSkillCatalogItem[];
  featured: readonly ServerSkillCatalogItem[];
  /** 联网拉目录+精选（未登录/离线时由结果标记表达，不抛）。 */
  load: () => Promise<boolean>;
  install: (name: string) => Promise<boolean>;
  uninstall: (name: string) => Promise<boolean>;
  setFavorite: (name: string, favorited: boolean) => Promise<boolean>;
  /**
   * 拉单个技能详情（M2 #2）：只读转发，失败向上抛，由详情弹层自行展示加载态/错误；
   * 不动 busy/error（弹层局部状态所有者），成功也不写目录投影。
   */
  getDetail: (name: string) => Promise<ServerSkillDetail>;
  /** 套件摘要列表（M2/M3 #13）：只读转发，失败向上抛（市场页局部 state 展示）。 */
  listBundles: () => Promise<readonly ServerSkillBundleSummary[]>;
  /** 套件详情（含成员清单）：只读转发，失败向上抛（弹层自行展示）。 */
  getBundleDetail: (id: number) => Promise<ServerSkillBundleDetail>;
  /**
   * 整套安装套件：服务端逐成员写安装后落盘 reconcile + re-GET 刷新目录投影。
   * 失败向上抛（进度展示由套件弹层负责，避免错误被吞进横幅后弹层无反馈）。
   */
  installBundle: (id: number) => Promise<void>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noticeOf(result: ServerSkillCatalogSyncResult): ServerMarketNotice | null {
  if (result.skippedNotLoggedIn) return "notLoggedIn";
  if (result.authExpired) return "authExpired";
  if (result.offline) return "offline";
  return null;
}

export function useServerSkillMarket(): UseServerSkillMarketResult {
  const services = useServices();
  const service = services.serverSkillSyncService;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ServerMarketNotice | null>(null);
  const [catalog, setCatalog] = useState<readonly ServerSkillCatalogItem[]>([]);
  const [featured, setFeatured] = useState<readonly ServerSkillCatalogItem[]>([]);

  const applyResult = useCallback((result: ServerSkillCatalogSyncResult) => {
    // 失败时同步器带回上一次成功投影，UI 不因离线丢目录（与专家侧 catalog 同语义）。
    setCatalog(result.catalog);
    setFeatured(result.featured);
    setNotice(noticeOf(result));
    const softErrors = result.errors.filter(() => !noticeOf(result));
    setError(softErrors.length > 0 ? softErrors.join(" | ") : null);
  }, []);

  // 首帧：先读 host 进程内投影（不联网），联网由页面在确认登录态后触发 load()。
  useEffect(() => {
    if (!service) return;
    let active = true;
    void service
      .getCatalog()
      .then((items) => {
        if (active) setCatalog(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [service]);

  const run = useCallback(
    async (operation: () => Promise<void>): Promise<boolean> => {
      if (!service) {
        setError("当前会话不支持技能市场同步");
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        await operation();
        return true;
      } catch (cause) {
        setError(toMessage(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [service],
  );

  const load = useCallback(
    () =>
      run(async () => {
        const result = await service!.syncCatalog();
        applyResult(result);
      }),
    [applyResult, run, service],
  );

  const install = useCallback(
    (name: string) =>
      run(async () => {
        // 写后 re-GET：安装关系以服务端为准，不本地推算（D3）。
        await service!.install(name);
        applyResult(await service!.syncCatalog());
      }),
    [applyResult, run, service],
  );

  const uninstall = useCallback(
    (name: string) =>
      run(async () => {
        await service!.uninstall(name);
        applyResult(await service!.syncCatalog());
      }),
    [applyResult, run, service],
  );

  const setFavorite = useCallback(
    (name: string, favorited: boolean) =>
      run(async () => {
        applyResult(await service!.setFavorite(name, favorited));
      }),
    [applyResult, run, service],
  );

  // 详情/套件只读转发：不占用 busy/error（弹层与市场页是各自局部状态的所有者），失败向上抛。
  const requireService = useCallback(() => {
    if (!service) throw new Error("当前会话不支持技能市场同步");
    return service;
  }, [service]);

  const getDetail = useCallback(
    (name: string) => requireService().getDetail(name),
    [requireService],
  );

  const listBundles = useCallback(() => requireService().listBundles(), [requireService]);

  const getBundleDetail = useCallback(
    (id: number) => requireService().getBundleDetail(id),
    [requireService],
  );

  const installBundle = useCallback(
    async (id: number) => {
      const target = requireService();
      setBusy(true);
      try {
        // 服务端逐成员写安装 → 落盘 reconcile（service 内）→ re-GET 刷新目录投影（D3）。
        await target.installBundle(id);
        applyResult(await target.syncCatalog());
      } finally {
        setBusy(false);
      }
    },
    [applyResult, requireService],
  );

  return {
    available: Boolean(service),
    busy,
    error,
    notice,
    catalog,
    featured,
    load,
    install,
    uninstall,
    setFavorite,
    getDetail,
    listBundles,
    getBundleDetail,
    installBundle,
  };
}
