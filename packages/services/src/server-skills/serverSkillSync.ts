import { ServiceChannels, type ServerSkillCatalogItem } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 企业服务端技能同步（server-skills）。
 *
 * 契约正本：docs/server-skill-sync.md。谁写盘：只有本服务写
 * `~/.reactor/server-skills/`（路径见 serverSkillsRoot.ts）；发现（skillsService /
 * CLI skillRoots）只读。启停不走本服务（仍是 ISkillsService.setEnabled 的路径 key map）。
 */

/** 一次 `sync()` / `refreshFromServer(name)` 的结果。 */
export interface ServerSkillSyncResult {
  /** 本次有磁盘写入的技能名（新增或内容变化）。 */
  readonly changed: readonly string[];
  /** 本次删除本地目录的技能名（硬收回 / 已卸载残留）。 */
  readonly removed: readonly string[];
  /** 落盘集全部技能名（不论是否变更）。 */
  readonly names: readonly string[];
  /**
   * 「已下架」只读投影：在落盘中但不在注入集的名字（服务端 enabled=false）。
   * 仅用于 UI 徽标；P2 不据此改变注入（契约 R5）。
   */
  readonly disabledNames: readonly string[];
  /** 单项失败信息（附件 sha 不符、写盘失败等）；不阻塞其它技能。 */
  readonly errors: readonly string[];
  /** 服务端不可达 / 5xx / 取不到 token：本地零删除零写盘。 */
  readonly offline: boolean;
  /** 401/403：token 失效，UI 应提示重新登录（区别于「离线」）。 */
  readonly authExpired: boolean;
  /** 未登录：未发起任何请求，本地不动。 */
  readonly skippedNotLoggedIn: boolean;
}

export interface IServerSkillSyncService {
  /** 全量对齐：以 `GET /me/skills` 为真相，只动 `server-skills/`。并发调用串行执行。 */
  sync(): Promise<ServerSkillSyncResult>;
  /**
   * 拉市场目录（catalog + featured）刷新**进程内投影**；纯内存，**不碰磁盘**——
   * 失败时保留上一次成功值（与 P3 `ServerAgentSyncResult.catalog` 同语义），本地落盘零影响。
   */
  syncCatalog(): Promise<ServerSkillCatalogSyncResult>;
  /** 市场安装：`POST .../install` 成功后 re-GET + 落盘 reconcile（不本地推算聚合字段，D3 同款）。 */
  install(name: string): Promise<ServerSkillSyncResult>;
  /** 卸载：先 `DELETE .../install`（服务端写 dismissal），成功后才删本地目录。 */
  uninstall(name: string): Promise<void>;
  /** 更新单个技能：全量对齐后 `POST .../refresh` 归位 hasUpdate。 */
  refreshFromServer(name: string): Promise<ServerSkillSyncResult>;
  /** 收藏/取消收藏（纯标记）：写成功后 re-GET 刷新目录投影。 */
  setFavorite(name: string, favorited: boolean): Promise<ServerSkillCatalogSyncResult>;
  /** 进程内最近一次成功 `syncCatalog()` 的目录投影（不联网；UI 首帧渲染用）。 */
  getCatalog(): Promise<readonly ServerSkillCatalogItem[]>;
}

/** 一次 `syncCatalog()` / `setFavorite()` 的结果（市场投影，只在内存，不落盘）。 */
export interface ServerSkillCatalogSyncResult {
  /** 目录全量投影（含未安装条目，市场字段在此）——市场页卡片的数据源。 */
  readonly catalog: readonly ServerSkillCatalogItem[];
  /** 精选投影（featured=true 的目录条目子集，服务端按 nonce 加权抽取）。 */
  readonly featured: readonly ServerSkillCatalogItem[];
  /** 单项失败信息；投影失败时 catalog/featured 带回**上一次**成功值。 */
  readonly errors: readonly string[];
  /** 服务端不可达 / 5xx / 取不到 token：本地落盘零影响，投影保留旧值。 */
  readonly offline: boolean;
  /** 401/403：token 失效，UI 应提示重新登录（区别于「离线」）。 */
  readonly authExpired: boolean;
  /** 未登录：未发起任何请求，投影不动。 */
  readonly skippedNotLoggedIn: boolean;
}

export const IServerSkillSyncService = createServiceDescriptor<IServerSkillSyncService>(
  ServiceChannels.ServerSkillSync,
);
