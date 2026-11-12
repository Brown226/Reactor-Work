/**
 * 反馈 / 需求数据域（FBK）SQL 层。
 *
 * 分纪律同其余域：这里只有 SQL 与行映射，HTTP 语义（状态码/鉴权/审计）在 routes.ts。
 *
 * 两个必须记住的口径：
 *  - 工单 id 是 TEXT uuid（客户端 ticket_id 直接用它）；
 *  - `last_user_activity_at` 与 `unread` 是**用户侧动作**的产物：用户补充消息 → 记活动时间并
 *    `unread = true`；管理台读一次详情或改状态 → `unread = false`。不维护它列表就没法标新。
 */
import { randomUUID } from "node:crypto";

import type { IdentityDb } from "../identity/db.js";

export interface FeedbackTicketRow {
  id: string;
  title: string;
  description: string;
  type: string;
  severity: string | null;
  module: string | null;
  status: string;
  contact: string | null;
  environment: Record<string, unknown> | null;
  reporterDisplay: string | null;
  reporterUid: string | null;
  reporterDept: string | null;
  deviceMid: string | null;
  assigneeId: string | null;
  assigneeDisplay: string | null;
  unread: boolean;
  lastUserActivityAt: Date | null;
  locale: string | null;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RawTicketRow {
  id: string;
  title: string;
  description: string;
  type: string;
  severity: string | null;
  module: string | null;
  status: string;
  contact: string | null;
  environment: Record<string, unknown> | null;
  reporter_display: string | null;
  reporter_uid: string | null;
  reporter_dept: string | null;
  device_mid: string | null;
  assignee_id: string | null;
  assignee_display: string | null;
  unread: boolean;
  last_user_activity_at: Date | null;
  locale: string | null;
  source: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface FeedbackCommentRow {
  id: number;
  ticketId: string;
  messageId: string;
  senderType: string;
  authorUserId: string | null;
  authorDisplayName: string | null;
  body: string;
  createdAt: Date;
}

interface RawCommentRow {
  id: string | number;
  ticket_id: string;
  message_id: string;
  sender_type: string;
  author_user_id: string | null;
  author_display_name: string | null;
  body: string;
  created_at: Date;
}

export interface FeedbackEventRow {
  id: number;
  ticketId: string;
  type: string;
  summary: string;
  actorDisplayName: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

interface RawEventRow {
  id: string | number;
  ticket_id: string;
  type: string;
  summary: string;
  actor_display_name: string | null;
  payload: Record<string, unknown> | null;
  created_at: Date;
}

const TICKET_COLUMNS = [
  "id",
  "title",
  "description",
  "type",
  "severity",
  "module",
  "status",
  "contact",
  "environment",
  "reporter_display",
  "reporter_uid",
  "reporter_dept",
  "device_mid",
  "assignee_id",
  "assignee_display",
  "unread",
  "last_user_activity_at",
  "locale",
  "source",
  "created_at",
  "updated_at",
].join(", ");

const COMMENT_COLUMNS = [
  "id",
  "ticket_id",
  "message_id",
  "sender_type",
  "author_user_id",
  "author_display_name",
  "body",
  "created_at",
].join(", ");

const EVENT_COLUMNS = [
  "id",
  "ticket_id",
  "type",
  "summary",
  "actor_display_name",
  "payload",
  "created_at",
].join(", ");

function mapTicket(raw: RawTicketRow): FeedbackTicketRow {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    type: raw.type,
    severity: raw.severity,
    module: raw.module,
    status: raw.status,
    contact: raw.contact,
    environment: raw.environment ?? null,
    reporterDisplay: raw.reporter_display,
    reporterUid: raw.reporter_uid,
    reporterDept: raw.reporter_dept,
    deviceMid: raw.device_mid,
    assigneeId: raw.assignee_id,
    assigneeDisplay: raw.assignee_display,
    unread: raw.unread,
    lastUserActivityAt: raw.last_user_activity_at,
    locale: raw.locale,
    source: raw.source,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function mapComment(raw: RawCommentRow): FeedbackCommentRow {
  return {
    id: Number(raw.id),
    ticketId: raw.ticket_id,
    messageId: raw.message_id,
    senderType: raw.sender_type,
    authorUserId: raw.author_user_id,
    authorDisplayName: raw.author_display_name,
    body: raw.body,
    createdAt: raw.created_at,
  };
}

function mapEvent(raw: RawEventRow): FeedbackEventRow {
  return {
    id: Number(raw.id),
    ticketId: raw.ticket_id,
    type: raw.type,
    summary: raw.summary,
    actorDisplayName: raw.actor_display_name,
    payload: raw.payload,
    createdAt: raw.created_at,
  };
}

export interface CreateFeedbackTicketInput {
  title: string;
  description: string;
  type: string;
  severity?: string | null;
  module?: string | null;
  contact?: string | null;
  environment?: Record<string, unknown> | null;
  reporterDisplay?: string | null;
  reporterUid?: string | null;
  reporterDept?: string | null;
  deviceMid?: string | null;
  locale?: string | null;
  source?: string | null;
  status?: string;
}

export async function createFeedbackTicket(
  db: IdentityDb,
  input: CreateFeedbackTicketInput,
): Promise<FeedbackTicketRow> {
  const id = randomUUID();
  const { rows } = await db.pool.query<RawTicketRow>(
    `INSERT INTO feedback_ticket
       (id, title, description, type, severity, module, status, contact, environment,
        reporter_display, reporter_uid, reporter_dept, device_mid, locale, source,
        last_user_activity_at, unread)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, now(), false)
     RETURNING ${TICKET_COLUMNS}`,
    [
      id,
      input.title,
      input.description,
      input.type,
      input.severity ?? null,
      input.module ?? null,
      input.status ?? "已提交",
      input.contact ?? null,
      input.environment ? JSON.stringify(input.environment) : null,
      input.reporterDisplay ?? null,
      input.reporterUid ?? null,
      input.reporterDept ?? null,
      input.deviceMid ?? null,
      input.locale ?? null,
      input.source ?? null,
    ],
  );
  const ticket = rows[0]!;
  // 建单本身也是一条事件：管理台时间线要能回答"这张单是谁什么时候提的"。
  await appendFeedbackEvent(db, id, {
    type: "created",
    summary: "工单已提交",
    actorDisplayName: input.reporterDisplay ?? null,
  });
  return mapTicket(ticket);
}

export interface ListFeedbackTicketFilter {
  status?: string;
  type?: string;
  severity?: string;
  /** 关键字：标题 + 正文模糊匹配 */
  q?: string;
  deviceMid?: string;
  unreadOnly?: boolean;
  limit: number;
  offset: number;
}

export async function listFeedbackTickets(
  db: IdentityDb,
  filter: ListFeedbackTicketFilter,
): Promise<{ tickets: FeedbackTicketRow[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace("?", `$${params.length}`));
  };
  if (filter.status) push("status = ?", filter.status);
  if (filter.type) push("type = ?", filter.type);
  if (filter.severity) push("severity = ?", filter.severity);
  if (filter.deviceMid) push("device_mid = ?", filter.deviceMid);
  if (filter.unreadOnly) conditions.push("unread = true");
  if (filter.q) {
    params.push(`%${filter.q}%`);
    conditions.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const totalResult = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM feedback_ticket ${where}`,
    params,
  );
  const { rows } = await db.pool.query<RawTicketRow>(
    `SELECT ${TICKET_COLUMNS} FROM feedback_ticket ${where}
      ORDER BY last_user_activity_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filter.limit, filter.offset],
  );
  return { tickets: rows.map(mapTicket), total: Number(totalResult.rows[0]?.count ?? 0) };
}

export async function getFeedbackTicket(db: IdentityDb, id: string): Promise<FeedbackTicketRow | null> {
  const { rows } = await db.pool.query<RawTicketRow>(
    `SELECT ${TICKET_COLUMNS} FROM feedback_ticket WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapTicket(rows[0]) : null;
}

export async function listFeedbackComments(
  db: IdentityDb,
  ticketId: string,
): Promise<FeedbackCommentRow[]> {
  const { rows } = await db.pool.query<RawCommentRow>(
    `SELECT ${COMMENT_COLUMNS} FROM feedback_comment WHERE ticket_id = $1 ORDER BY created_at, id`,
    [ticketId],
  );
  return rows.map(mapComment);
}

export async function listFeedbackEvents(
  db: IdentityDb,
  ticketId: string,
): Promise<FeedbackEventRow[]> {
  const { rows } = await db.pool.query<RawEventRow>(
    `SELECT ${EVENT_COLUMNS} FROM feedback_event WHERE ticket_id = $1 ORDER BY created_at, id`,
    [ticketId],
  );
  return rows.map(mapEvent);
}

export interface AppendFeedbackMessageInput {
  ticketId: string;
  body: string;
  senderType: "user" | "staff";
  authorUserId?: string | null;
  authorDisplayName?: string | null;
}

export async function appendFeedbackMessage(
  db: IdentityDb,
  input: AppendFeedbackMessageInput,
): Promise<FeedbackCommentRow> {
  const messageId = randomUUID();
  const { rows } = await db.pool.query<RawCommentRow>(
    `INSERT INTO feedback_comment
       (ticket_id, message_id, sender_type, author_user_id, author_display_name, body)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COMMENT_COLUMNS}`,
    [
      input.ticketId,
      messageId,
      input.senderType,
      input.authorUserId ?? null,
      input.authorDisplayName ?? null,
      input.body,
    ],
  );
  return mapComment(rows[0]!);
}

export interface AppendFeedbackEventInput {
  ticketId: string;
  type: string;
  summary: string;
  actorDisplayName?: string | null;
  payload?: Record<string, unknown> | null;
}

export async function appendFeedbackEvent(
  db: IdentityDb,
  ticketId: string,
  input: Omit<AppendFeedbackEventInput, "ticketId">,
): Promise<FeedbackEventRow> {
  const { rows } = await db.pool.query<RawEventRow>(
    `INSERT INTO feedback_event (ticket_id, type, summary, actor_display_name, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING ${EVENT_COLUMNS}`,
    [
      ticketId,
      input.type,
      input.summary,
      input.actorDisplayName ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
    ],
  );
  return mapEvent(rows[0]!);
}

export interface PatchFeedbackTicketInput {
  status?: string;
  severity?: string | null;
  assigneeId?: string | null;
  assigneeDisplay?: string | null;
}

/**
 * 流转工单。返回改前/改后两份，供路由层写事件与审计（只给改后的话，
 * 时间线上"从 X 改成 Y"就无从谈起）。
 */
export async function patchFeedbackTicket(
  db: IdentityDb,
  id: string,
  patch: PatchFeedbackTicketInput,
): Promise<{ before: FeedbackTicketRow | null; after: FeedbackTicketRow | null }> {
  const before = await getFeedbackTicket(db, id);
  if (!before) return { before: null, after: null };

  const fields: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown) => {
    params.push(value);
    fields.push(sql.replace("?", `$${params.length}`));
  };
  if (patch.status !== undefined) push("status = ?", patch.status);
  if (patch.severity !== undefined) push("severity = ?", patch.severity);
  if (patch.assigneeId !== undefined) push("assignee_id = ?", patch.assigneeId);
  if (patch.assigneeDisplay !== undefined) push("assignee_display = ?", patch.assigneeDisplay);
  if (fields.length === 0) return { before, after: before };

  params.push(id);
  const { rows } = await db.pool.query<RawTicketRow>(
    `UPDATE feedback_ticket SET ${fields.join(", ")}, updated_at = now() WHERE id = $${params.length}
     RETURNING ${TICKET_COLUMNS}`,
    params,
  );
  return { before, after: rows[0] ? mapTicket(rows[0]) : null };
}

/** 管理台读过详情 → 熄红点；用户补充消息 → 重新点亮。 */
export async function setFeedbackTicketUnread(
  db: IdentityDb,
  id: string,
  unread: boolean,
  options: { touchActivity?: boolean } = {},
): Promise<void> {
  await db.pool.query(
    `UPDATE feedback_ticket
        SET unread = $2,
            last_user_activity_at = CASE WHEN $3::boolean THEN now() ELSE last_user_activity_at END,
            updated_at = now()
      WHERE id = $1`,
    [id, unread, options.touchActivity ?? false],
  );
}

// ============================================================================
// 附件（截图 / 诊断日志）——字节落磁盘，表里只存寻址与校验和
// ============================================================================

export interface FeedbackAttachmentRow {
  id: number;
  ticketId: string;
  messageId: string | null;
  kind: string;
  fileName: string;
  storedName: string;
  sizeBytes: number;
  sha256: string;
  contentType: string | null;
  createdAt: Date;
}

interface RawAttachmentRow {
  id: string | number;
  ticket_id: string;
  message_id: string | null;
  kind: string;
  file_name: string;
  stored_name: string;
  size_bytes: string | number;
  sha256: string;
  content_type: string | null;
  created_at: Date;
}

const ATTACHMENT_COLUMNS = [
  "id",
  "ticket_id",
  "message_id",
  "kind",
  "file_name",
  "stored_name",
  "size_bytes",
  "sha256",
  "content_type",
  "created_at",
].join(", ");

function mapAttachment(raw: RawAttachmentRow): FeedbackAttachmentRow {
  return {
    id: Number(raw.id),
    ticketId: raw.ticket_id,
    messageId: raw.message_id,
    kind: raw.kind,
    fileName: raw.file_name,
    storedName: raw.stored_name,
    // BIGINT 默认回字符串，不转数字会让管理台把 1048576 显示成 "1048576" 字符串比较
    sizeBytes: Number(raw.size_bytes),
    sha256: raw.sha256,
    contentType: raw.content_type,
    createdAt: raw.created_at,
  };
}

export interface CreateFeedbackAttachmentInput {
  ticketId: string;
  messageId?: string | null;
  kind: string;
  fileName: string;
  storedName: string;
  sizeBytes: number;
  sha256: string;
  contentType?: string | null;
}

export async function createFeedbackAttachment(
  db: IdentityDb,
  input: CreateFeedbackAttachmentInput,
): Promise<FeedbackAttachmentRow> {
  const { rows } = await db.pool.query<RawAttachmentRow>(
    `INSERT INTO feedback_attachment
       (ticket_id, message_id, kind, file_name, stored_name, size_bytes, sha256, content_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ATTACHMENT_COLUMNS}`,
    [
      input.ticketId,
      input.messageId ?? null,
      input.kind,
      input.fileName,
      input.storedName,
      input.sizeBytes,
      input.sha256,
      input.contentType ?? null,
    ],
  );
  return mapAttachment(rows[0]!);
}

export async function listFeedbackAttachments(
  db: IdentityDb,
  ticketId: string,
): Promise<FeedbackAttachmentRow[]> {
  const { rows } = await db.pool.query<RawAttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM feedback_attachment WHERE ticket_id = $1 ORDER BY created_at, id`,
    [ticketId],
  );
  return rows.map(mapAttachment);
}

export async function getFeedbackAttachment(
  db: IdentityDb,
  ticketId: string,
  attachmentId: number,
): Promise<FeedbackAttachmentRow | null> {
  const { rows } = await db.pool.query<RawAttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM feedback_attachment WHERE ticket_id = $1 AND id = $2`,
    [ticketId, attachmentId],
  );
  return rows[0] ? mapAttachment(rows[0]) : null;
}
