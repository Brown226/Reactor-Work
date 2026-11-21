// Reactor 管理台 · 托管 MCP 服务（治理平面 P0）
// 契约对齐 packages/server/src/mcp/routes.ts（/admin/mcp/servers*，platform_admin 专用）。
//
// 语义：托管服务是企业下发给全体桌面端的 MCP —— 凭据（共享请求头）只存服务端（AES 封存），
// 端侧一律经 relay 调用；本页管理的三档策略（允许/需确认/禁用）随 /desktop/policy 下发端侧强制。
// 任何接口都不回凭据明文，只回 header 名 + 值末四位（headerNames）。

import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "./identity";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

/** 三档策略词表（与端侧 ReactorManagedMcpToolPolicy 同口径）。 */
export type McpToolPolicy = "allow" | "ask" | "block";

export interface McpToolSnapshotEntry {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  inputSchema?: unknown;
  /** 参数结构不合格的原因（有值 = 不给模型、relay 拒执行） */
  problem?: string;
  /** 同步新增且管理员尚未固化策略的标记 */
  isNew?: boolean;
}

export interface AdminMcpServer {
  id: string;
  name: string;
  displayName: string;
  type: "http" | "sse";
  url: string;
  auth: "none" | "shared";
  /** 只有名字与值末四位，永远没有明文 */
  headerNames: Array<{ name: string; last4: string }>;
  enabled: boolean;
  toolsSnapshot: McpToolSnapshotEntry[];
  toolPolicy: Record<string, McpToolPolicy>;
  syncedAt: string | null;
  syncError: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface McpServerInput {
  name: string;
  displayName?: string;
  type: "http" | "sse";
  url: string;
  auth: "none" | "shared";
  /** 明文提交；服务端封存。PATCH 时不变的值传 "********"（掩码语义） */
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** 探测/同步类接口走「恒 200 + ok 布尔 + 已脱敏 error」口径（与连通测试一致）。 */
export interface McpProbeResult {
  ok: boolean;
  toolCount?: number;
  latencyMs?: number;
  error?: string;
}

export interface McpSyncResult {
  ok: boolean;
  toolCount?: number;
  problemCount?: number;
  newCount?: number;
  error?: string;
}

export const mcpApi = {
  list: () => http.get<{ servers: AdminMcpServer[] }>("/admin/mcp/servers", AUTH),

  create: (input: McpServerInput) => http.post<{ server: AdminMcpServer }>("/admin/mcp/servers", input, AUTH),

  patch: (id: string, patch: Partial<McpServerInput>) =>
    http.patch<{ server: AdminMcpServer }>(`/admin/mcp/servers/${id}`, patch, AUTH),

  remove: (id: string) => http.delete<{ ok: boolean }>(`/admin/mcp/servers/${id}`, AUTH),

  /** 手动同步快照：失败恒 200 + ok:false + 保旧快照（正在用的会话不受影响）。 */
  sync: (id: string) => http.post<McpSyncResult>(`/admin/mcp/servers/${id}/sync`, undefined, AUTH),

  /** 整体替换三档策略表（只允许快照里已有的工具名）。 */
  setToolPolicy: (id: string, policy: Record<string, McpToolPolicy>) =>
    http.put<{ server: AdminMcpServer }>(`/admin/mcp/servers/${id}/tool-policy`, { policy }, AUTH),

  /** 连通测试（已保存的服务，用存储的凭据）。 */
  probe: (id: string) => http.post<McpProbeResult>(`/admin/mcp/servers/${id}/probe`, undefined, AUTH),
};

// ===== 页面纯函数（导出供探针钉断言，仿 ModelsAndProviders 的「探针直钉」手法） =====

export type McpServerStatus = "disabled" | "sync-error" | "ok";

/** 状态点优先级：停用 > 连接异常（syncError）> 正常。 */
export function serverStatus(row: AdminMcpServer): McpServerStatus {
  if (!row.enabled) return "disabled";
  if (row.syncError) return "sync-error";
  return "ok";
}

/** 快照里还没被策略固化（isNew 且没有显式条目）的工具数。 */
export function pendingNewCount(row: AdminMcpServer): number {
  return row.toolsSnapshot.filter((tool) => tool.isNew === true && row.toolPolicy[tool.name] === undefined).length;
}

/** 参数结构不合格（problem）的工具数。 */
export function problemCount(row: AdminMcpServer): number {
  return row.toolsSnapshot.filter((tool) => Boolean(tool.problem)).length;
}

/** 三档默认值：不在策略表内的工具按 ask（与服务端 relay、端侧闸同一兜底）。 */
export function policyOf(row: AdminMcpServer, toolName: string): McpToolPolicy {
  return row.toolPolicy[toolName] ?? "ask";
}

/** 按 MCP 注解把工具分成「只读 / 写入」两组（只读组=readOnlyHint===true，其余并入写入组）。 */
export function groupTools(tools: McpToolSnapshotEntry[]): {
  readOnly: McpToolSnapshotEntry[];
  writing: McpToolSnapshotEntry[];
} {
  const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
  const writing = tools.filter((tool) => tool.annotations?.readOnlyHint !== true);
  return { readOnly, writing };
}

/** 展示名：displayName 优先，缺省回落服务名。 */
export function serverLabel(row: AdminMcpServer): string {
  return row.displayName || row.name;
}
