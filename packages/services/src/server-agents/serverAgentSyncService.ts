import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isServerAgentNameFileSafe,
  mapServerAgentPolicyMode,
  type ApiClient,
  type ServerAgentDefinition,
} from "@zcode/shared";
import type { SubAgentConfig } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  REACTOR_SERVER_CREDENTIAL_KEYS,
  type IReactorServerService,
} from "../reactor-server/reactorServer.js";
import {
  createReactorServerClient,
  ReactorServerHttpError,
} from "../reactor-server/reactorServerClient.js";
import { serializeSubagentMarkdown } from "../subagents/subagentMarkdown.js";
import {
  resolveServerAgentsRoot,
  type SubagentStorageOptions,
} from "../subagents/subagentStorage.js";
import { IServerAgentSyncService, type ServerAgentSyncResult } from "./serverAgentSync.js";

/**
 * 同步器实现。字段映射、同步时序与验收见 docs/服务端接线-P3-Agent下发.md。
 *
 * 三条硬约束：
 *  1. 写操作成功后 **re-GET 全量再 reconcile**，不在本地推算 installed/hot 等聚合字段（D3）；
 *  2. 未登录 / 网络失败一律零删除零写盘，只有拿到目录才允许清理本地；
 *  3. 删除只认「合法专家名 + `<name>.md`」的文件，绝不碰 `agents/`、`.zcode/agents/` 与本目录里的其它内容。
 */

const logger = createServiceLogger("serverAgentSync");

/** 物化文件名：`<name>.md`（name 已由 shared 契约校验为文件安全）。 */
function agentFilePath(root: string, name: string): string {
  return join(root, `${name}.md`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyResult(catalog: readonly ServerAgentDefinition[]): ServerAgentSyncResult {
  return {
    changed: [],
    removed: [],
    names: [],
    catalog,
    errors: [],
    offline: false,
    authExpired: false,
    skippedNotLoggedIn: false,
  };
}

function skippedNotLoggedIn(catalog: readonly ServerAgentDefinition[]): ServerAgentSyncResult {
  return { ...emptyResult(catalog), skippedNotLoggedIn: true };
}

function failedResult(
  error: unknown,
  context: string,
  catalog: readonly ServerAgentDefinition[],
): ServerAgentSyncResult {
  const unauthorized =
    error instanceof ReactorServerHttpError &&
    (error.status === 401 || error.status === 403 || error.isUnauthorized);
  // 401/403 要提示重新登录；其余归「离线」，本地副本保持可用（与技能同步同语义）。
  return {
    ...emptyResult(catalog),
    errors: [`${context}: ${errorMessage(error)}`],
    offline: !unauthorized,
    authExpired: unauthorized,
  };
}

interface ServerSession {
  readonly serverUrl: string;
  readonly accessToken: string;
}

export function createServerAgentSyncService(options: {
  apiClient: ApiClient;
  credentials: ICredentialService;
  reactorServer: IReactorServerService;
  storageOptions?: SubagentStorageOptions;
}): IServerAgentSyncService {
  const client = createReactorServerClient(options.apiClient);
  // 串行队列：全量对齐与单专家安装/卸载/启停同一时刻只跑一个，避免交叉写撕裂。
  let queue: Promise<unknown> = Promise.resolve();
  /** 最近一次成功同步的目录（进程内存；失败时作为 catalog 兜底）。 */
  let lastCatalog: readonly ServerAgentDefinition[] = [];

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function resolveSession(): Promise<ServerSession | null> {
    let status;
    try {
      status = await options.reactorServer.getStatus();
    } catch {
      return null;
    }
    if (!status.loggedIn || !status.serverUrl) return null;
    const accessToken = await options.credentials
      .load(REACTOR_SERVER_CREDENTIAL_KEYS.accessToken)
      .catch(() => null);
    if (!accessToken) return null;
    return { serverUrl: status.serverUrl, accessToken };
  }

  /**
   * 组装单个专家的 markdown：
   * - `model` 的 provider 必须落到本地企业 providerId（`reactor:providerId`），服务端
   *   `provider` 是网关逻辑名**禁止字面写入**（§4.4）；providerId 缺席（登录未完成 /
   *   条目被删）时不写 `model`，跟随主会话，下次同步自愈（U-P3-2）。
   * - `thinkingLevel` 只有 modelSelection 存在时才被序列化（U-P3-7）；无 model 时丢弃并记 debug。
   * - `description` 服务端可空而 parser 必填：title → name 兜底（title 是服务端必填的人类名称）。
   */
  function buildAgentMarkdown(
    agent: ServerAgentDefinition,
    enterpriseProviderId: string | null,
  ): string {
    const reasoningLevel = agent.thinkingLevel?.trim();
    const modelSelection =
      enterpriseProviderId && agent.modelId
        ? {
            providerId: enterpriseProviderId,
            modelId: agent.modelId,
            ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
          }
        : undefined;
    if (!modelSelection && reasoningLevel) {
      logger.debug(undefined, "无模型的企业专家丢弃 thinkingLevel（U-P3-7）", {
        name: agent.name,
      });
    }
    const permissionMode = mapServerAgentPolicyMode(agent.policyMode);
    const skills = agent.skills.length > 0 ? [...agent.skills] : undefined;
    const config: SubAgentConfig = {
      name: agent.name,
      description: agent.description?.trim() || agent.title || agent.name,
      systemPrompt: agent.persona ?? "",
      ...(skills ? { skills } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(modelSelection ? { modelSelection } : {}),
    };
    return serializeSubagentMarkdown(config);
  }

  /** 删除目标集之外的物化文件。只认 `<合法名>.md`，其它内容（人手放置）一律不碰。 */
  async function removeObsoleteAgents(keepNames: ReadonlySet<string>): Promise<string[]> {
    const root = await resolveServerAgentsRoot(options.storageOptions);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      // ENOENT = 还没有同步过，合理空状态。
      return [];
    }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      const name = entry.name.slice(0, -".md".length);
      if (!isServerAgentNameFileSafe(name)) continue;
      if (keepNames.has(name)) continue;
      await rm(join(root, entry.name), { force: true });
      removed.push(name);
    }
    return removed.sort((left, right) => left.localeCompare(right));
  }

  async function runSync(): Promise<ServerAgentSyncResult> {
    const session = await resolveSession();
    if (!session) return skippedNotLoggedIn(lastCatalog);

    let agents: ServerAgentDefinition[];
    try {
      agents = await client.listAgents(session.serverUrl, session.accessToken);
    } catch (error) {
      return failedResult(error, "读取专家目录失败", lastCatalog);
    }
    lastCatalog = agents;

    // 企业 providerId 必须在登录流程（reconcileProviderModels）之后读取，见 U-P3-2。
    const enterpriseProviderId = await options.credentials
      .load(REACTOR_SERVER_CREDENTIAL_KEYS.providerId)
      .catch(() => null);

    const target = agents.filter((agent) => agent.installed && agent.installEnabled);
    const errors: string[] = [];
    const changed: string[] = [];
    const keepNames = new Set<string>();
    const root = await resolveServerAgentsRoot(options.storageOptions);
    for (const agent of target) {
      keepNames.add(agent.name);
      try {
        const content = buildAgentMarkdown(agent, enterpriseProviderId);
        const file = agentFilePath(root, agent.name);
        const existing = await readFile(file, "utf-8").catch(() => null);
        // 内容不等才写：重复 sync 不碰 mtime，幂等。
        if (existing !== content) {
          await mkdir(root, { recursive: true });
          await writeFile(file, content, "utf-8");
          changed.push(agent.name);
        }
      } catch (error) {
        errors.push(`专家 ${agent.name} 同步失败: ${errorMessage(error)}`);
      }
    }
    changed.sort((left, right) => left.localeCompare(right));

    let removed: string[] = [];
    try {
      removed = await removeObsoleteAgents(keepNames);
    } catch (error) {
      errors.push(`清理过期专家文件失败: ${errorMessage(error)}`);
    }

    if (changed.length > 0 || removed.length > 0) {
      logger.debug(
        undefined,
        `server agents synced changed=${changed.length} removed=${removed.length} total=${keepNames.size}`,
      );
    }
    return {
      changed,
      removed,
      names: [...keepNames].sort((left, right) => left.localeCompare(right)),
      catalog: lastCatalog,
      errors,
      offline: false,
      authExpired: false,
      skippedNotLoggedIn: false,
    };
  }

  async function runInstall(name: string): Promise<ServerAgentSyncResult> {
    if (!isServerAgentNameFileSafe(name)) throw new Error(`非法专家名: ${name}`);
    const session = await resolveSession();
    if (!session) throw new Error("未登录企业服务端，无法安装专家");
    await client.installAgent(session.serverUrl, session.accessToken, name);
    // 写后 re-GET：安装关系以服务端为准，本地不推算（D3）。
    return runSync();
  }

  async function runUninstall(name: string): Promise<ServerAgentSyncResult> {
    if (!isServerAgentNameFileSafe(name)) throw new Error(`非法专家名: ${name}`);
    const session = await resolveSession();
    if (!session) {
      throw new Error("未登录企业服务端，无法卸载（本地只删会被下次同步写回）");
    }
    try {
      await client.uninstallAgent(session.serverUrl, session.accessToken, name);
    } catch (error) {
      if (error instanceof ReactorServerHttpError && error.status === 404) {
        // 服务端已无安装记录：按已卸载处理，只清理本地残留。
      } else {
        throw new Error(`卸载失败（服务端未确认）: ${errorMessage(error)}`);
      }
    }
    // 服务端关系已确认删除 → 本地文件立即回收；随后 re-GET 刷新目录投影（失败不影响已删事实）。
    const root = await resolveServerAgentsRoot(options.storageOptions);
    await rm(agentFilePath(root, name), { force: true });
    try {
      return await runSync();
    } catch (error) {
      logger.debug(undefined, "卸载后刷新目录失败（文件已删）", errorMessage(error));
      return {
        ...emptyResult(lastCatalog),
        removed: [name],
        errors: [`卸载后刷新目录失败: ${errorMessage(error)}`],
      };
    }
  }

  async function runSetInstallEnabled(
    name: string,
    enabled: boolean,
  ): Promise<ServerAgentSyncResult> {
    if (!isServerAgentNameFileSafe(name)) throw new Error(`非法专家名: ${name}`);
    const session = await resolveSession();
    if (!session) throw new Error("未登录企业服务端，无法启停专家");
    await client.setAgentInstallEnabled(session.serverUrl, session.accessToken, name, enabled);
    return runSync();
  }

  async function runClearLocal(): Promise<void> {
    const removed = await removeObsoleteAgents(new Set());
    if (removed.length > 0) {
      logger.debug(undefined, "登出清空 server-agents", { count: removed.length });
    }
    lastCatalog = [];
  }

  return {
    sync: () => enqueue(runSync),
    install: (name: string) => enqueue(() => runInstall(name)),
    uninstall: (name: string) => enqueue(() => runUninstall(name)),
    setInstallEnabled: (name: string, enabled: boolean) =>
      enqueue(() => runSetInstallEnabled(name, enabled)),
    getCatalog: async () => lastCatalog,
    clearLocal: () => enqueue(runClearLocal),
  };
}
