// Reactor 管理台 · 标准规范清单服务（STD）
// 契约对齐 packages/server/src/standards/routes.ts（/admin/standards/*，platform_admin 专用）。
//
// 语义：标准清单是**治理数据**（核电设计院的标准库），一次导入后以分页编辑为主；
// 审查消费端走 /v1/standards/index（只读全量索引），与本服务无关，不要在这里加写入。

import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "./identity";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

/** 规范串真源在服务端 standards/repo.ts；管理台只做展示标签，不放第二套编码。 */
export type StandardStatus = "current" | "upcoming" | "abolished" | "unknown";

export const STANDARD_STATUS_LABELS: Record<StandardStatus, string> = {
  current: "现行",
  upcoming: "即将实施",
  abolished: "已废止",
  unknown: "未标注",
};

export interface AdminStandard {
  id: number;
  standardNo: string;
  standardName: string;
  status: StandardStatus;
  category: string | null;
  publishDate: string | null;
  implementDate: string | null;
  abolishDate: string | null;
  replaceInfo: string | null;
  ident: string | null;
  updatedAt: string;
}

export interface StandardListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: StandardStatus | "";
  category?: string;
  sortField?: string;
  sortOrder?: "asc" | "desc";
}

export interface StandardListResult {
  items: AdminStandard[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StandardImportItem {
  standardNo: string;
  standardName: string;
  status?: string;
  category?: string | null;
  publishDate?: string | null;
  implementDate?: string | null;
  abolishDate?: string | null;
  replaceInfo?: string | null;
}

/** 值为 undefined/空串的参数直接不拼 —— 服务端对缺参走各自的默认值。 */
function qs(params: Record<string, string | number | undefined | null | boolean>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const standardsApi = {
  list: (query: StandardListQuery = {}) =>
    http.get<StandardListResult>(`/admin/standards${qs({ ...query, status: query.status })}`, AUTH),

  categories: () => http.get<{ items: { value: string; count: number }[] }>("/admin/standards/categories", AUTH),

  get: (id: number) => http.get<AdminStandard>(`/admin/standards/${id}`, AUTH),

  patch: (id: number, patch: Partial<StandardImportItem>) =>
    http.patch<AdminStandard>(`/admin/standards/${id}`, patch, AUTH),

  remove: (id: number) => http.delete<{ deleted: number }>(`/admin/standards/${id}`, AUTH),

  bulkDelete: (ids: number[]) =>
    http.post<{ deleted: number }>("/admin/standards/bulk-delete", { ids }, AUTH),

  clear: () => http.delete<{ cleared: number }>("/admin/standards", AUTH),

  /** 批量导入（JSON）。幂等：重复导入只补缺失行，不会越灌越多。 */
  import: (items: StandardImportItem[]) =>
    http.post<{ received: number; inserted: number; skipped: number }>(
      "/admin/standards/import",
      { items },
      AUTH,
    ),
};
