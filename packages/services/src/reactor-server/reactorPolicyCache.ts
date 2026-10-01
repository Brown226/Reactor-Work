/**
 * 组织策略缓存（P4.2b）：`{用户数据根}/desktop-policy.json` 的**唯一写入者**。
 *
 * 状态所有权（P4 文档 §3）：
 * - 写：只有本模块（Host 侧，随 `IReactorServerService` 寿命）；CLI 的强制点只读它；
 * - 读：`getPolicy()` 内存优先、首次读盘（进程刚启动时用上一份，避免"重启后策略消失"）；
 * - 清：登出 / 未登录时 `clear()` —— 「未登录不同步、不强制」，此时 CLI 侧读不到文件即不限制。
 *
 * 三条语义（P4 文档 §4.3）在实现里各自对应：
 * 1. 未登录不拉取 → 由调用方（service）短路，本模块不决定登录态；
 * 2. 拉取失败保留上一份 → `markStale()` 只改标记，**绝不**改 `policy`、也不删文件；
 * 3. 缺字段按默认合并 → `normalizeReactorDesktopPolicy` 在 `save()` 前完成，
 *    因此落盘与被 CLI 读到的都是完整策略（空数组 = 不限制，不是"全禁"）。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  normalizeReactorDesktopPolicy,
  parseReactorDesktopPolicyFile,
  type ReactorDesktopPolicy,
} from "@zcode/shared";
import type { ReactorServerPolicyView } from "./reactorServer.js";

export interface ReactorPolicyCache {
  /** 当前生效策略（内存 → 磁盘 → null）。null = 无策略 = 不限制。 */
  getPolicy(): Promise<ReactorDesktopPolicy | null>;
  /** 设置页/探针用的只读视图（来源、陈旧标记、错误）。 */
  getView(): Promise<ReactorServerPolicyView>;
  /** 服务端拉取成功后写入（原子重写 + 刷新内存）。 */
  save(policy: unknown): Promise<void>;
  /** 拉取失败：保留上一份，只标 `stale` + 错误（禁止清空限制）。 */
  markStale(error: string): Promise<ReactorServerPolicyView>;
  /** 登出 / 未登录：删除缓存文件并清内存（此后不限制）。 */
  clear(): Promise<void>;
}

export function createReactorPolicyCache(options: {
  filePath: string;
  logger?: { warn: (message: string, meta?: unknown) => void };
}): ReactorPolicyCache {
  const { filePath } = options;
  /** `undefined` = 尚未读盘；`null` = 明确没有策略。 */
  let policy: ReactorDesktopPolicy | null | undefined;
  let fetchedAt: string | null = null;
  /** 本轮刷新失败留下的标记；下一次成功 save() 清掉。 */
  let staleError: string | null = null;

  async function load(): Promise<ReactorDesktopPolicy | null> {
    if (policy !== undefined) return policy;
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = parseReactorDesktopPolicyFile(JSON.parse(raw) as unknown);
      policy = parsed?.policy ?? null;
      fetchedAt = parsed?.fetchedAt ?? null;
    } catch {
      // 文件不存在/损坏 = 没有可用策略：视为不限制（绝不让坏文件变成"全禁"）。
      policy = null;
      fetchedAt = null;
    }
    return policy;
  }

  const getView = async (): Promise<ReactorServerPolicyView> => {
    const current = await load();
    return {
      // 有文件 = 曾经从服务端拿到过（source=server）；拉取失败不改写文件，此时标 stale。
      source: current ? "server" : "unknown",
      stale: staleError !== null,
      fetchedAt,
      policy: current,
      error: staleError,
    };
  };

  return {
    getPolicy: load,
    getView,

    async save(incoming) {
      const normalized = normalizeReactorDesktopPolicy(incoming);
      const nextFetchedAt = new Date().toISOString();
      await mkdir(dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.tmp`;
      await writeFile(
        tempPath,
        `${JSON.stringify({ version: 1, fetchedAt: nextFetchedAt, policy: normalized }, null, 2)}\n`,
        "utf8",
      );
      // 同目录 rename 原子：CLI 侧读到的要么是旧策略、要么是新策略，不会读到半截 JSON。
      await rename(tempPath, filePath);
      policy = normalized;
      fetchedAt = nextFetchedAt;
      staleError = null;
    },

    async markStale(error) {
      staleError = error;
      return getView();
    },

    async clear() {
      policy = null;
      fetchedAt = null;
      staleError = null;
      try {
        await rm(filePath, { force: true });
      } catch (error) {
        // 删不掉只影响"登出后仍被限制"，必须可见但不必抛出（登出主流程不能被它打断）。
        options.logger?.warn("[policy] 策略缓存清理失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
