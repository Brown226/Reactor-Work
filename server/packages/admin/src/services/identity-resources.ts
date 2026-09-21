// Reactor 管理台 · 用户 / 组织 / 同步 服务（T1-2）
// 按域拆分：页面一律走本层，不再直接拼 api 路径。401 续签回调统一注入。

import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "./identity";
import type { AdminUser, DeptNode, SyncDiffResult, SyncLog, SyncRunResult } from "../types";

const AUTH = {
  /** 401 → 尝试续签（client 内重试一次） */
  onUnauthorized: refreshAccess,
  /** 续签失败 → 清态（页面据此退回登录） */
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

/* ---------- 用户 ---------- */

export interface UserQuery {
  q?: string;
  status?: "" | "active" | "disabled";
  /**
   * 部门筛选，三态（与 `components/UsersTable.tsx` 的 `deptIds` 同义）：
   *   `undefined` = 不按部门收窄；`[]` = 命中空集；非空 = 只看这些部门（含下级时由前端算好子树 ids）。
   * 服务端会对部门负责人与自身范围求交 —— 参数只能收窄，不能放大。
   */
  deptIds?: number[];
}

export const usersApi = {
  list: (query: UserQuery = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.status) params.set("status", query.status);
    // 合并页「组织与用户」：左树选节点后右表只看该部门；勾「含下级」时前端传子树 ids（逗号分隔）。
    // ⚠ 判空用 `!== undefined` 而不是 `length > 0`：空数组必须**发出去**（`deptIds=`），
    //   服务端据此 fail-closed 成空集。少发这一个参数，就等于把「子树为空」放大成全量。
    if (query.deptIds !== undefined) params.set("deptIds", query.deptIds.join(","));
    const qs = params.toString();
    return http.get<{ users: AdminUser[]; total: number }>(`/users${qs ? `?${qs}` : ""}`, AUTH);
  },
  create: (body: { uid: string; name: string; email: string | null; role: string; departmentId: number | null; password: string }) =>
    http.post<void>("/users", body, AUTH),
  patch: (id: number, body: Record<string, unknown>) => http.patch<void>(`/users/${id}`, body, AUTH),
  disable: (id: number) => http.post<void>(`/users/${id}/disable`, undefined, AUTH),
};

/* ---------- 组织 ---------- */

export interface AdminDept {
  id: number;
  parentId: number | null;
  name: string;
  path: string;
  depth: number;
}

export const deptsApi = {
  tree: () => http.get<{ tree: DeptNode[] }>("/depts/tree", AUTH),
  /** U-1/U-5：部门建/改/移/删（仅平台管理员；结构变更不写回 AD） */
  create: (body: { parentId: number | null; name: string }) => http.post<{ dept: AdminDept }>("/depts", body, AUTH),
  patch: (id: number, body: { name?: string; parentId?: number | null }) =>
    http.patch<{ dept: AdminDept }>(`/depts/${id}`, body, AUTH),
  remove: (id: number) => http.delete<{ ok: boolean }>(`/depts/${id}`, AUTH),
};

/* ---------- 管理台菜单授权（T1-3：服务端下发可见导航 key） ---------- */

export const navApi = {
  keys: () => http.get<{ keys: string[] }>("/me/nav", AUTH),
};

/* ---------- LDAP 同步 ---------- */

export const syncApi = {
  preview: () => http.post<{ diff: SyncDiffResult }>("/auth/sync?preview=1", undefined, AUTH),
  run: () => http.post<{ result: SyncRunResult }>("/auth/sync", undefined, AUTH),
  logs: () => http.get<{ logs: SyncLog[] }>("/auth/sync/logs", AUTH),
};
