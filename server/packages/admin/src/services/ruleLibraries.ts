// Reactor 管理台 · 规范库服务（RUL）
// 契约对齐 packages/server/src/rule-libraries/routes.ts（/admin/rule-libraries/*，platform_admin 专用）。
//
// 两层资源：库（rule_library）+ 库里的条文/审点条目（rule_library_item）。
// 消费面（/v1/rule-libraries）只下发 **published** 库的**启用中**条目 —— 草稿库还在编辑，
// 端侧拿到半成品会让「同一文件 + 同一库 = 同一结论」这条纪律失效，所以状态切换是有语义的。

import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "./identity";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

export type RuleLibraryStatus = "draft" | "published" | "archived";
export type RuleSeverity = "error" | "warning" | "info";
export type RuleMandatory = "mandatory" | "guidance";

export const RULE_LIBRARY_STATUS_LABELS: Record<RuleLibraryStatus, string> = {
  draft: "草稿",
  published: "已发布",
  archived: "已归档",
};

export const RULE_SEVERITY_LABELS: Record<RuleSeverity, string> = {
  error: "严重",
  warning: "警告",
  info: "提示",
};

export const RULE_MANDATORY_LABELS: Record<RuleMandatory, string> = {
  mandatory: "强制性",
  guidance: "推荐性",
};

export interface AdminRuleLibrary {
  id: number;
  name: string;
  description: string | null;
  sourceFileName: string | null;
  status: RuleLibraryStatus;
  standardNo: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  enabledItemCount: number;
}

export interface AdminRuleItem {
  id: number;
  libraryId: number;
  ruleCode: string | null;
  ruleName: string | null;
  category: string | null;
  clauseText: string | null;
  checkPrompt: string | null;
  severity: RuleSeverity;
  mandatory: RuleMandatory;
  sourceLocation: string | null;
  clauseHash: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuleItemInput {
  ruleCode?: string | null;
  ruleName?: string | null;
  category?: string | null;
  clauseText?: string | null;
  checkPrompt?: string | null;
  severity?: RuleSeverity;
  mandatory?: RuleMandatory;
  sourceLocation?: string | null;
  enabled?: boolean;
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

export const ruleLibrariesApi = {
  list: (query: { search?: string; status?: RuleLibraryStatus | ""; sortOrder?: "asc" | "desc" } = {}) =>
    http.get<{ items: AdminRuleLibrary[]; total: number }>(
      `/admin/rule-libraries${qs({ ...query, status: query.status })}`,
      AUTH,
    ),

  get: (id: number) => http.get<AdminRuleLibrary>(`/admin/rule-libraries/${id}`, AUTH),

  create: (input: {
    name: string;
    description?: string | null;
    sourceFileName?: string | null;
    status?: RuleLibraryStatus;
    standardNo?: string | null;
  }) => http.post<AdminRuleLibrary>("/admin/rule-libraries", input, AUTH),

  patch: (
    id: number,
    patch: Partial<{
      name: string;
      description: string | null;
      status: RuleLibraryStatus;
      standardNo: string | null;
    }>,
  ) => http.patch<AdminRuleLibrary>(`/admin/rule-libraries/${id}`, patch, AUTH),

  remove: (id: number) =>
    http.delete<{ deleted: number; deletedItems: number }>(`/admin/rule-libraries/${id}`, AUTH),

  items: (
    id: number,
    query: {
      page?: number;
      pageSize?: number;
      search?: string;
      category?: string;
      enabled?: boolean;
      sortField?: string;
      sortOrder?: "asc" | "desc";
    } = {},
  ) =>
    http.get<{ items: AdminRuleItem[]; total: number; page: number; pageSize: number }>(
      `/admin/rule-libraries/${id}/items${qs(query)}`,
      AUTH,
    ),

  itemCategories: (id: number) =>
    http.get<{ items: { value: string; count: number }[] }>(
      `/admin/rule-libraries/${id}/items/categories`,
      AUTH,
    ),

  createItem: (id: number, input: RuleItemInput) =>
    http.post<AdminRuleItem | null>(`/admin/rule-libraries/${id}/items`, input, AUTH),

  patchItem: (id: number, itemId: number, patch: RuleItemInput) =>
    http.patch<AdminRuleItem>(`/admin/rule-libraries/${id}/items/${itemId}`, patch, AUTH),

  removeItem: (id: number, itemId: number) =>
    http.delete<{ deleted: number }>(`/admin/rule-libraries/${id}/items/${itemId}`, AUTH),

  bulkRemoveItems: (id: number, ids: number[]) =>
    http.post<{ deleted: number }>(`/admin/rule-libraries/${id}/items/bulk-delete`, { ids }, AUTH),

  clearItems: (id: number) =>
    http.delete<{ cleared: number }>(`/admin/rule-libraries/${id}/items`, AUTH),

  /** 批量导入条文。幂等：同一库内条文内容相同者跳过（服务端按条文算 clauseHash）。 */
  importItems: (id: number, items: RuleItemInput[]) =>
    http.post<{ received: number; inserted: number; skipped: number }>(
      `/admin/rule-libraries/${id}/items/import`,
      { items },
      AUTH,
    ),
};
