// Reactor 管理台 · 反馈 / 需求受理服务（FBK）
// 契约对齐 packages/server/src/feedback/routes.ts（/admin/feedback/*，platform_admin 专用）。
//
// 类型与常量是**镜像**：admin 独立构建、不依赖主仓 @zcode/shared，
// 所以状态/类型/严重度三份枚举要与 packages/shared/src/feedback.ts 保持一致（改契约两处都要动）。

import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "./identity";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

/** 与客户端 FeedbackTicketStatus 一致（中文枚举，服务端原样存取）。 */
export const FEEDBACK_STATUSES = [
  "已提交",
  "信息不足",
  "已采纳",
  "答复关闭",
  "已归档",
  "已拒绝",
  "开发中",
  "已解决",
  "已上线",
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** 与客户端 FeedbackTicketType 一致（服务端 content.category）。 */
export const FEEDBACK_TYPES = [
  { value: "bug", label: "Bug 反馈" },
  { value: "usage", label: "使用问题" },
  { value: "feature", label: "功能建议" },
  { value: "performance", label: "性能问题" },
] as const;

export const FEEDBACK_SEVERITIES = ["P1-高", "P2-中", "P3-低"] as const;

export const feedbackTypeLabel = (value: string): string =>
  FEEDBACK_TYPES.find((item) => item.value === value)?.label ?? value;

export interface FeedbackTicketSummary {
  id: string;
  title: string;
  type: string;
  severity: string | null;
  module: string | null;
  status: string;
  unread: boolean;
  reporter_display: string | null;
  /** 提交者账号（企业 JWT 的 sub），用于区分同名的人。 */
  reporter_uid: string | null;
  /** 提交者部门（departments.path，root→leaf），为空 = 匿名提交。 */
  reporter_dept: string | null;
  device_mid: string | null;
  assignee_id: string | null;
  assignee_display: string | null;
  last_user_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeedbackAttachment {
  attachment_id: number;
  file_name: string;
  /** log / image / other —— 与客户端 FeedbackAttachmentKind 一致 */
  kind: string;
  size: number;
  content_type?: string;
  /** 管理面下载地址（带 Bearer 才有效，走 http.download）。 */
  download_url: string;
  created_at: string;
}

export interface FeedbackMessage {
  id: number;
  message_id: string;
  sender_type: string;
  author_user_id: string | null;
  author_display_name: string | null;
  body: string;
  is_staff: boolean;
  created_at: string;
}

export interface FeedbackEvent {
  id: number;
  type: string;
  summary: string;
  actor_display_name: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface FeedbackTicketDetail extends FeedbackTicketSummary {
  description: string;
  contact: string | null;
  environment: Record<string, unknown> | null;
  locale: string | null;
  source: string | null;
  messages: FeedbackMessage[];
  events: FeedbackEvent[];
  attachments: FeedbackAttachment[];
}

export interface FeedbackListResult {
  tickets: FeedbackTicketSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface FeedbackListParams {
  status?: string;
  type?: string;
  severity?: string;
  q?: string;
  unread?: boolean;
  limit?: number;
  offset?: number;
}

export const feedbackApi = {
  list: (params: FeedbackListParams = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.type) query.set("type", params.type);
    if (params.severity) query.set("severity", params.severity);
    if (params.q?.trim()) query.set("q", params.q.trim());
    if (params.unread) query.set("unread", "1");
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return http.get<FeedbackListResult>(`/admin/feedback/tickets${suffix}`, AUTH);
  },
  /** 打开详情会把工单 unread 置为 false（服务端语义，前端不用自己熄红点）。 */
  get: (id: string) =>
    http.get<{ ticket: FeedbackTicketDetail }>(`/admin/feedback/tickets/${encodeURIComponent(id)}`, AUTH),
  patch: (
    id: string,
    body: { status?: string; severity?: string | null; assignee_id?: string | null; assignee_display?: string | null },
  ) =>
    http.patch<{ ticket: FeedbackTicketSummary }>(
      `/admin/feedback/tickets/${encodeURIComponent(id)}`,
      body,
      AUTH,
    ),
  reply: (id: string, body: string) =>
    http.post<{ message: FeedbackMessage }>(
      `/admin/feedback/tickets/${encodeURIComponent(id)}/messages`,
      { body },
      AUTH,
    ),
  /** 附件下载（截图/日志）：走带鉴权的 blob 下载，避免 <a href> 带不了 Bearer。 */
  downloadAttachment: (ticketId: string, attachmentId: number) =>
    http.download(
      `/admin/feedback/tickets/${encodeURIComponent(ticketId)}/attachments/${attachmentId}/download`,
    ),
};
