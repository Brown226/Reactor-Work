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

  /**
   * Excel 导入预检（两段式第一步）：上传 xlsx，服务端解析 + 筛重后返回明细，**不写库**。
   * 确认入库仍走 `import(items)`，不为 Excel 另开写入路径（见 spec §4.2）。
   */
  importExcel: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return http.post<StandardImportPreview>("/admin/standards/import-excel", form, AUTH);
  },

  /** 下载导入模板（空表头 + 填写说明 sheet）。 */
  template: () => http.download("/admin/standards/template"),

  /** 导出当前筛选结果为 xlsx，列序与模板一致、状态为中文（改完可直接再导回）。 */
  exportExcel: (query: StandardListQuery = {}) =>
    http.download(`/admin/standards/export${qs({ ...query, status: query.status })}`),
};

/** Excel 导入预检结果（契约见 packages/server/src/standards/routes.ts 的 import-excel）。 */
export interface StandardImportPreview {
  /** Excel 数据行总数（不含表头与全空行）。 */
  received: number;
  /** 净化后可用行数（已做文件内去重）。 */
  valid: number;
  /** 去重后确定新增的条数，等于 items.length。 */
  willInsert: number;
  /** 重复条数（文件内重复 + 库中已存在）。 */
  willSkip: number;
  /** 无法解析的行，row 为 Excel 行号（含表头偏移）。 */
  invalid: Array<{ row: number; reason: string }>;
  /** 重复明细，服务端最多回 100 条；总数看 willSkip。 */
  duplicates: Array<{
    row: number;
    standardNo: string;
    standardName: string;
    source: "file" | "db";
  }>;
  /** 明细是否被截断（超过 100 条）。 */
  duplicatesTruncated: boolean;
  /** 去重后的待新增数据，确认入库时原样回传。 */
  items: StandardImportItem[];
}
