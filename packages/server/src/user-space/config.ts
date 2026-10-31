import { dirname, resolve } from "node:path";
import { resolveUserWorkspaceConfig } from "../user-workspace.js";

/**
 * 我的空间配置。每次直接读 env（纯内存）而不缓存：
 * 与 user-workspace 的 resolveUserWorkspaceConfig 口径保持一处来源，
 * 也避免测试里改 env 后要重启进程。
 */
export interface UserSpaceConfig {
  /** 每用户空间根（容器内默认 /data/users）。 */
  readonly workspaceRoot: string;
  /** 每用户配额，来自 REACTOR_WEB_USER_QUOTA_BYTES（默认 1GB）。 */
  readonly quotaBytes: number;
  /** 分享索引文件，固定放在空间根的同级（/data/users → /data/shares.json，方案 §4）。 */
  readonly sharesFile: string;
}

export function resolveUserSpaceConfig(): UserSpaceConfig {
  const workspace = resolveUserWorkspaceConfig();
  const workspaceRoot = resolve(workspace.root);
  return {
    workspaceRoot,
    quotaBytes: workspace.userQuotaBytes,
    sharesFile: resolve(dirname(workspaceRoot), "shares.json"),
  };
}
