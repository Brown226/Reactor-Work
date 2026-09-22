import { ServiceChannels, type ServerAgentDefinition } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 企业服务端 Agent 同步（server-agents）。
 *
 * 契约与决策正本：docs/服务端接线-方案-v1.md §4.4；实施计划 docs/服务端接线-P3-Agent下发.md。
 * 谁写盘：只有本服务写 `{数据根}/server-agents/`（根目录见 subagentStorage.resolveServerAgentsRoot）；
 * 发现层（subagentsService / CLI bootstrap）只读。启停不落本地第二套状态——
 * 「是否物化」即启用态，服务端 `agent_installs` 是唯一真相（D5）。
 */

/** 一次 `sync()` / `install()` / `uninstall()` / `setInstallEnabled()` 的结果。 */
export interface ServerAgentSyncResult {
  /** 本次有磁盘写入的专家名（新增或内容变化）。 */
  readonly changed: readonly string[];
  /** 本次删除本地文件的专家名（停用 / 卸载 / 收回）。 */
  readonly removed: readonly string[];
  /** 目标集（`installed && installEnabled`）全部名字。 */
  readonly names: readonly string[];
  /**
   * 目录全量投影（含未安装条目，市场字段在此）——UI「服务端目录」的数据源。
   * 同步失败时带回**上一次**成功值，UI 不因离线丢目录。
   */
  readonly catalog: readonly ServerAgentDefinition[];
  /** 单项失败信息（写盘失败等）；不阻塞其它专家。 */
  readonly errors: readonly string[];
  /** 服务端不可达 / 5xx / 取不到 token：本地零删除零写盘。 */
  readonly offline: boolean;
  /** 401/403：token 失效，UI 应提示重新登录（区别于「离线」）。 */
  readonly authExpired: boolean;
  /** 未登录：未发起任何请求，本地不动。 */
  readonly skippedNotLoggedIn: boolean;
}

export interface IServerAgentSyncService {
  /** 全量对齐：`GET /me/agents` → 目标集 → 增量 reconcile，只动 `server-agents/`。并发调用串行执行。 */
  sync(): Promise<ServerAgentSyncResult>;
  /** 安装：`POST .../install` 成功后 re-GET + reconcile（不本地推算，D3）。 */
  install(name: string): Promise<ServerAgentSyncResult>;
  /** 卸载：`DELETE .../install` 成功后才删本地文件；服务端失败则本地保留。 */
  uninstall(name: string): Promise<ServerAgentSyncResult>;
  /** 启停：`PATCH .../install {enabled}` 成功后 re-GET + reconcile（停用 = 删文件）。 */
  setInstallEnabled(name: string, enabled: boolean): Promise<ServerAgentSyncResult>;
  /** 进程内最近一次成功同步的目录投影（不联网；UI 首帧渲染用）。 */
  getCatalog(): Promise<readonly ServerAgentDefinition[]>;
  /** 登出清空：删除本目录全部物化文件；**永不**触碰 `agents/` 与 `.zcode/agents/`。 */
  clearLocal(): Promise<void>;
}

export const IServerAgentSyncService = createServiceDescriptor<IServerAgentSyncService>(
  ServiceChannels.ServerAgentSync,
);
