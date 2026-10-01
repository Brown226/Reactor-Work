/**
 * server-skills 同步器的服务端访问原语：会话解析（既有逻辑原样下沉）+ M2 市场出口（详情/套件）。
 *
 * 为什么单独成文件：与 `reactorServerP4Endpoints.ts` 同款惯例——宿主工厂
 * （serverSkillSyncService.ts）受 `max-lines` 约束，把会话解析与详情/套件方法搬出来，
 * 语义逐字保留：会话解析仍只依赖 reactorServer 状态 + 凭据；落盘 reconcile 仍由
 * 主同步器注入 runSync，不出现第二套会话解析或第二套写盘逻辑。
 */
import { isServerSkillNameFileSafe } from "@zcode/shared";
import type {
  ServerSkillBundleDetail,
  ServerSkillBundleSummary,
  ServerSkillDetail,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { IReactorServerService } from "../reactor-server/reactorServer.js";
import { REACTOR_SERVER_CREDENTIAL_KEYS } from "../reactor-server/reactorServer.js";
import type { ReactorServerClient } from "../reactor-server/reactorServerClient.js";
import type { ServerSkillSyncResult } from "./serverSkillSync.js";

export interface ServerSession {
  readonly serverUrl: string;
  readonly accessToken: string;
}

/** 会话解析依赖（与主同步器 options 同源，结构化传入避免整对象耦合）。 */
export interface ServerSessionResolverDeps {
  reactorServer: IReactorServerService;
  credentials: ICredentialService;
}

/** 由登录态 + 凭据解析服务端会话；未登录/离线/取不到 token 一律 null（原 serverSkillSyncService 语义）。 */
export function createServerSessionResolver(
  deps: ServerSessionResolverDeps,
): () => Promise<ServerSession | null> {
  return async () => {
    let status;
    try {
      status = await deps.reactorServer.getStatus();
    } catch {
      return null;
    }
    if (!status.loggedIn || !status.serverUrl) return null;
    const accessToken = await deps.credentials
      .load(REACTOR_SERVER_CREDENTIAL_KEYS.accessToken)
      .catch(() => null);
    if (!accessToken) return null;
    return { serverUrl: status.serverUrl, accessToken };
  };
}

export interface ServerSkillMarketAccessOptions {
  client: ReactorServerClient;
  /** 与主同步器同源的会话解析。 */
  resolveSession: () => Promise<ServerSession | null>;
  /** 整套安装后的落盘 reconcile：复用主同步器 runSync（单一写盘所有者）。 */
  runSync: () => Promise<ServerSkillSyncResult>;
  /** 安装动作的串行队列（防与「全量对齐删目录」交叉执行）；只读方法不经队列。 */
  enqueueInstall: <T>(task: () => Promise<T>) => Promise<T>;
}

export function createServerSkillMarketAccess(options: ServerSkillMarketAccessOptions) {
  const { client, resolveSession, runSync, enqueueInstall } = options;

  async function requireSession(action: string): Promise<ServerSession> {
    const session = await resolveSession();
    if (!session) throw new Error(`未登录企业服务端，无法${action}`);
    return session;
  }

  /** 技能详情（M2 #2）：只读、不落盘、不走同步队列；失败原样上抛由 UI 弹层展示。 */
  async function getDetail(name: string): Promise<ServerSkillDetail> {
    if (!isServerSkillNameFileSafe(name)) throw new Error(`非法技能名: ${name}`);
    const session = await requireSession("读取技能详情");
    return client.skillDetail(session.serverUrl, session.accessToken, name);
  }

  async function listBundles(): Promise<readonly ServerSkillBundleSummary[]> {
    const session = await requireSession("读取技能套件");
    return client.skillBundles(session.serverUrl, session.accessToken);
  }

  async function getBundleDetail(id: number): Promise<ServerSkillBundleDetail> {
    if (!Number.isInteger(id) || id <= 0) throw new Error(`非法套件 id: ${id}`);
    const session = await requireSession("读取套件详情");
    return client.skillBundleDetail(session.serverUrl, session.accessToken, id);
  }

  async function installBundle(id: number): Promise<ServerSkillSyncResult> {
    if (!Number.isInteger(id) || id <= 0) throw new Error(`非法套件 id: ${id}`);
    const session = await requireSession("安装技能套件");
    await client.installSkillBundle(session.serverUrl, session.accessToken, id);
    // 写后 re-GET + 落盘 reconcile：成员安装关系以服务端为准（与单技能安装同口径 D3）。
    return runSync();
  }

  return {
    getDetail,
    listBundles,
    getBundleDetail,
    installBundle: (id: number) => enqueueInstall(() => installBundle(id)),
  };
}
