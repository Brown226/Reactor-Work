// Reactor 管理台 · 术语白名单服务（TRM）
// 契约对齐 packages/server/src/terminology/routes.ts（/admin/terminology/*，platform_admin 专用）。
//
// 语义：白名单是审查的**执行前提** —— 端侧把它拉成内存 Set，校对结果命中即丢弃（防专业词误报）。
// 所以内置词条（isBuiltin）不可删除：删掉会让校对整段失效，服务端会拒绝并回话 skippedBuiltin。

import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "./identity";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

export interface AdminTerm {
  id: number;
  term: string;
  category: string;
  /** 库里是逗号分隔单列；接口原样返回字符串，写入时接受数组或字符串。 */
  aliases: string | null;
  isBuiltin: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// 用 type 而不是 interface：`qs()` 的入参带索引签名，而 interface 拿不到隐式索引签名，
// 直接传会报 "Index signature for type 'string' is missing"（同 services/standards.ts 的写法）。
export type TermListQuery = {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: string;
  sortField?: string;
  sortOrder?: "asc" | "desc";
};

export interface TermListResult {
  items: AdminTerm[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TermInput {
  term: string;
  category?: string;
  aliases?: string | string[] | null;
}

function qs(params: Record<string, string | number | undefined | null | boolean>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** 逗号分隔字符串 → 数组：管理台展示别名标签时用。 */
export function splitAliases(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export const terminologyApi = {
  list: (query: TermListQuery = {}) =>
    http.get<TermListResult>(`/admin/terminology${qs(query)}`, AUTH),

  categories: () =>
    http.get<{ items: { value: string; count: number }[]; defaults: string[] }>(
      "/admin/terminology/categories",
      AUTH,
    ),

  create: (input: TermInput) => http.post<AdminTerm>("/admin/terminology", input, AUTH),

  patch: (id: number, patch: Partial<TermInput>) =>
    http.patch<AdminTerm>(`/admin/terminology/${id}`, patch, AUTH),

  remove: (id: number) =>
    http.delete<{ deleted: number; skippedBuiltin: number }>(`/admin/terminology/${id}`, AUTH),

  bulkDelete: (ids: number[]) =>
    http.post<{ deleted: number; skippedBuiltin: number }>(
      "/admin/terminology/bulk-delete",
      { ids },
      AUTH,
    ),

  /** 批量导入（JSON）。幂等：(术语, 分类) 已存在即跳过。 */
  import: (items: TermInput[]) =>
    http.post<{ received: number; inserted: number; skipped: number }>(
      "/admin/terminology/import",
      { items },
      AUTH,
    ),
};
