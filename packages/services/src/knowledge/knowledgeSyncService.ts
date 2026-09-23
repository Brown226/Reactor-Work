/**
 * 知识缓存同步服务（文件审查板块，docs/审查板块-方案-v1.md §4.4.3）。
 *
 * ## 为什么需要它
 *
 * 知识板块的三个子域（标准清单 / 术语白名单 / 规范库）都在企业服务端，而执行审查的 Agent
 * 在 CLI 进程里 —— **它拿不到企业令牌，也不该拿到**。所以由本服务（服务端侧、持有凭据）
 * 把三份数据拉到用户数据目录，Agent 只读本地文件：令牌不进入 Agent 进程，审查还能离线跑。
 *
 * ## 纪律
 *
 * - **一次拉取 + 版本失效**：按服务端 `maxUpdatedAt` 作版本，条件请求命中 304 时不重写文件。
 *   1.3 万条标准清单是本链路唯一有量的接口，不许每次审查都全量拉。
 * - **原子写**：先写 `.tmp` 再 rename。半截写入的 JSON 会让工具侧读到损坏缓存，
 *   而契约是「读不到就当没有缓存、提示重新同步」，比读到半截更安全。
 * - **失败不清缓存**：同步失败保留上一份可用数据（与 `ServerAgentSyncResult.catalog` 同语义）——
 *   网络抖动不该让审查失去依据。
 * - **只下发已发布库**：`/v1/rule-libraries` 只列 published；草稿库服务端就返回 404，
 *   这里也不把它写进缓存。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ApiClient } from "@zcode/shared";

import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  REACTOR_SERVER_CREDENTIAL_KEYS,
  type IReactorServerService,
} from "../reactor-server/reactorServer.js";
import { resolveKnowledgeCacheRoot } from "./knowledgeCacheRoot.js";

const logger = createServiceLogger("knowledge-sync");

/** 缓存文件名：与 CLI 工具 `knowledge-check.ts` 的读取路径一一对应，改名要同时改两处。 */
export const KNOWLEDGE_CACHE_FILES = {
  standards: "standards.json",
  terminology: "terminology.json",
  ruleLibraries: "rule-libraries.json",
} as const;

export interface KnowledgeSyncResult {
  readonly ok: boolean;
  /** 各份缓存的写入情况：`updated` 表示这次真的换了内容（含首次），`skipped` 表示 304/未变更。 */
  readonly standards: "updated" | "skipped" | "failed" | "logged-out";
  readonly terminology: "updated" | "skipped" | "failed" | "logged-out";
  readonly ruleLibraries: "updated" | "skipped" | "failed" | "logged-out";
  readonly cacheDir: string;
  readonly error?: string;
}

export interface KnowledgeSyncStatus {
  readonly cacheDir: string;
  readonly standards: { maxUpdatedAt: string | null; fetchedAt: string; count: number } | null;
  readonly terminology: { maxUpdatedAt: string | null; fetchedAt: string; count: number } | null;
  readonly ruleLibraries: { fetchedAt: string; libraries: number; items: number } | null;
}

export interface IKnowledgeSyncService {
  /** 全量对齐（幂等，可反复调用）：登录后、手动刷新、进入审查档时都走它。 */
  sync(): Promise<KnowledgeSyncResult>;
  /** 只读缓存现状，供 UI 展示"知识库已同步到什么时候"。 */
  getStatus(): Promise<KnowledgeSyncStatus>;
}

interface CacheEnvelope {
  maxUpdatedAt?: string | null;
  fetchedAt?: string;
  [key: string]: unknown;
}

async function readEnvelope(path: string): Promise<CacheEnvelope | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CacheEnvelope;
  } catch {
    return null;
  }
}

/** 原子写：同目录临时文件 + rename（跨设备 rename 会失败，所以临时文件必须同目录）。 */
async function writeAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data)}\n`, "utf8");
  await rename(temporary, path);
}

export function createKnowledgeSyncService(options: {
  apiClient: ApiClient;
  credentials: ICredentialService;
  reactorServer: IReactorServerService;
  /** 注入时钟便于测试（缺省 `Date.now`）。 */
  now?: () => number;
}): IKnowledgeSyncService {
  const cacheDir = resolveKnowledgeCacheRoot();
  const now = options.now ?? Date.now;
  // 串行：登录钩子、启动补一次、手动刷新可能同时触发，并发会交叉写同一批文件。
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function resolveSession(): Promise<{ serverUrl: string; accessToken: string } | null> {
    let status;
    try {
      status = await options.reactorServer.getStatus();
    } catch {
      return null;
    }
    if (!status.loggedIn || !status.serverUrl) {
      logger.info("知识缓存同步跳过：未登录企业服务端", { loggedIn: status.loggedIn });
      return null;
    }
    const accessToken = await options.credentials
      .load(REACTOR_SERVER_CREDENTIAL_KEYS.accessToken)
      .catch(() => null);
    if (!accessToken) {
      logger.warn("知识缓存同步跳过：已登录但凭据库里没有 accessToken", {
        serverUrl: status.serverUrl,
      });
      return null;
    }
    return { serverUrl: status.serverUrl, accessToken };
  }

  /**
   * 取一个消费面接口。返回 `null` 表示**未变更**（304）或该接口不可用（404 等）——
   * 两者对调用方的动作相同：保留现有缓存，不写坏数据。
   */
  async function fetchJson<T>(
    session: { serverUrl: string; accessToken: string },
    path: string,
    ifModifiedSince?: string | null,
  ): Promise<{ data: T; lastModified: string | null } | null> {
    const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` };
    if (ifModifiedSince) headers["if-modified-since"] = ifModifiedSince;
    const response = await options.apiClient.request(`${session.serverUrl}${path}`, {
      method: "GET",
      headers,
    });
    if (response.status === 304) return null;
    if (!response.ok) {
      if (response.status === 401) {
        // 令牌过期是最常见的失败原因（应用重启后凭据库里的 access 往往已过期）。
        // 会话层负责刷新并回写凭据库；刷新后重试一次，避免"要用户手动重登一次才行"。
        await options.reactorServer.getStatus().catch(() => undefined);
        const refreshed = await options.credentials
          .load(REACTOR_SERVER_CREDENTIAL_KEYS.accessToken)
          .catch(() => null);
        if (refreshed && refreshed !== session.accessToken) {
          const retried = await options.apiClient.request(`${session.serverUrl}${path}`, {
            method: "GET",
            headers: { authorization: `Bearer ${refreshed}` },
          });
          if (retried.ok) {
            const data = (await retried.json()) as T;
            return { data, lastModified: retried.headers.get("last-modified") };
          }
          logger.warn("知识缓存取数 401 后重试仍失败", { path, status: retried.status });
          return null;
        }
      }
      // 404 = 该库未发布/不存在，属正常态；其余状态记日志但仍然不写坏缓存。
      if (response.status !== 404) {
        logger.warn("知识缓存取数失败", { path, status: response.status });
      }
      return null;
    }
    const data = (await response.json()) as T;
    return { data, lastModified: response.headers.get("last-modified") };
  }

  async function syncOne(
    session: { serverUrl: string; accessToken: string },
    fileName: string,
    endpoint: string,
  ): Promise<"updated" | "skipped" | "failed"> {
    const path = join(cacheDir, fileName);
    const existing = await readEnvelope(path);
    const fetched = await fetchJson<{ items?: unknown[]; maxUpdatedAt?: string | null; total?: number }>(
      session,
      endpoint,
      existing?.maxUpdatedAt ?? null,
    );
    if (!fetched) return existing ? "skipped" : "failed";
    const items = Array.isArray(fetched.data?.items) ? fetched.data.items : [];
    await writeAtomic(path, {
      maxUpdatedAt: fetched.data?.maxUpdatedAt ?? fetched.lastModified ?? null,
      fetchedAt: new Date(now()).toISOString(),
      count: items.length,
      items,
    });
    return "updated";
  }

  async function syncRuleLibraries(session: {
    serverUrl: string;
    accessToken: string;
  }): Promise<"updated" | "skipped" | "failed"> {
    const path = join(cacheDir, KNOWLEDGE_CACHE_FILES.ruleLibraries);
    const existing = await readEnvelope(path);
    const list = await fetchJson<{ items?: { id?: number; name?: string; status?: string }[] }>(
      session,
      "/v1/rule-libraries",
    );
    if (!list) return existing ? "skipped" : "failed";
    const libraries = (list.data?.items ?? []).filter(
      (library) => typeof library.id === "number" && library.status === "published",
    );
    // 每个已发布库拉条目（按库缓存：端侧只在下结论时按需用某个库）。
    const entries: Record<string, unknown> = {};
    let itemCount = 0;
    let anyUpdated = false;
    for (const library of libraries) {
      const cached = (existing?.items as Record<string, { maxUpdatedAt?: string | null }> | undefined)?.[
        String(library.id)
      ];
      const detail = await fetchJson<{ library?: unknown; items?: unknown[]; maxUpdatedAt?: string | null }>(
        session,
        `/v1/rule-libraries/${library.id}/items`,
        cached?.maxUpdatedAt ?? null,
      );
      if (!detail) {
        // 304：沿用旧条目，别把库写空
        if (cached) {
          entries[String(library.id)] = cached;
          itemCount += Array.isArray((cached as { items?: unknown[] }).items)
            ? ((cached as { items?: unknown[] }).items as unknown[]).length
            : 0;
        }
        continue;
      }
      const items = Array.isArray(detail.data?.items) ? detail.data.items : [];
      entries[String(library.id)] = {
        maxUpdatedAt: detail.data?.maxUpdatedAt ?? detail.lastModified ?? null,
        library: detail.data?.library ?? library,
        items,
      };
      itemCount += items.length;
      anyUpdated = true;
    }
    if (libraries.length === 0 && !anyUpdated && existing) return "skipped";
    await writeAtomic(path, {
      fetchedAt: new Date(now()).toISOString(),
      libraries,
      items: entries,
      count: itemCount,
    });
    return anyUpdated || !existing ? "updated" : "skipped";
  }

  async function runSync(): Promise<KnowledgeSyncResult> {
    const session = await resolveSession();
    if (!session) {
      // 未登录不是错误：审查端会在工具侧看到 stale=true 并提示用户先登录同步。
      return {
        ok: false,
        standards: "logged-out",
        terminology: "logged-out",
        ruleLibraries: "logged-out",
        cacheDir,
      };
    }
    const standards = await syncOne(session, KNOWLEDGE_CACHE_FILES.standards, "/v1/standards/index").catch(
      () => "failed" as const,
    );
    const terminology = await syncOne(
      session,
      KNOWLEDGE_CACHE_FILES.terminology,
      "/v1/terminology/index",
    ).catch(() => "failed" as const);
    const ruleLibraries = await syncRuleLibraries(session).catch(() => "failed" as const);
    const ok = [standards, terminology, ruleLibraries].every((state) => state !== "failed");
    if (ok) {
      logger.info("知识缓存同步完成", { cacheDir, standards, terminology, ruleLibraries });
    } else {
      logger.warn("知识缓存同步存在失败项（保留上一份可用缓存）", {
        cacheDir,
        standards,
        terminology,
        ruleLibraries,
      });
    }
    return { ok, standards, terminology, ruleLibraries, cacheDir };
  }

  return {
    sync: () => enqueue(runSync),
    getStatus: async () => {
      const [standards, terminology, ruleLibraries] = await Promise.all([
        readEnvelope(join(cacheDir, KNOWLEDGE_CACHE_FILES.standards)),
        readEnvelope(join(cacheDir, KNOWLEDGE_CACHE_FILES.terminology)),
        readEnvelope(join(cacheDir, KNOWLEDGE_CACHE_FILES.ruleLibraries)),
      ]);
      const stamp = (
        envelope: CacheEnvelope | null,
      ): { maxUpdatedAt: string | null; fetchedAt: string; count: number } | null =>
        envelope
          ? {
              maxUpdatedAt: (envelope.maxUpdatedAt as string | null) ?? null,
              fetchedAt: (envelope.fetchedAt as string) ?? "",
              count: Number(envelope.count ?? 0),
            }
          : null;
      const libraries = (ruleLibraries?.libraries as unknown[] | undefined) ?? [];
      return {
        cacheDir,
        standards: stamp(standards),
        terminology: stamp(terminology),
        ruleLibraries: ruleLibraries
          ? {
              fetchedAt: (ruleLibraries.fetchedAt as string) ?? "",
              libraries: libraries.length,
              items: Number(ruleLibraries.count ?? 0),
            }
          : null,
      };
    },
  };
}
