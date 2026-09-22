/**
 * 反馈 / 需求 HTTP 路由（FBK）：管理面 `/admin/feedback/*` + 客户端提交面 `/api/v1/feedback/*`。
 *
 * 为什么分两个工厂、挂在两处（改错一处不是 401 就是没人能受理）：
 *  - `createFeedbackAdminRoutes` 由 identity/server.ts 挂在 authed 组**之后**，复用 Bearer 中间件，
 *    这里只再校验 platform_admin；
 *  - `createFeedbackPublicRoutes` 必须挂在 authed 组**之前**（identity/routes.ts 的「公开」段）：
 *    Reactor 用户只有企业账号、**没有官方 zcodejwttoken**，客户端 `getAuthHeaders()` 拿不到可用
 *    令牌。放鉴权段会让本产品自己的用户全部 401 —— 上报根本进不来。所以这段**不强制 Bearer**：
 *    带了且能验过就用它填报告人展示名，验不过按匿名 + X-Device-Mid 记录。
 *
 * 客户端契约不是自定义的：wire 格式以 `packages/services/src/feedback/feedbackHttpClient.ts` 为准
 * （ticket_id / content / environment / messages 那套），它还要求 `X-Device-Mid` 头存在，
 * 且错误响应体带 `msg`（readResponseError 会把它当作用户可见消息）。
 *
 * 一期**不支持附件**：客户端上传附件走「OSS 直传凭证」（返回阿里云 policy/签名，字节直传 OSS），
 * 自建服务端没有这套对象存储。这里回 400 + `attachments_unsupported` 标记，
 * 客户端据此把"日志没传上去"降级成评论里的一条系统提示，而不是把已建好的工单报成提交失败。
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import { recordAdminAction, resolveActorForClaims } from "../audit/repo.js";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import {
  appendFeedbackEvent,
  appendFeedbackMessage,
  createFeedbackTicket,
  getFeedbackTicket,
  listFeedbackComments,
  listFeedbackEvents,
  listFeedbackTickets,
  patchFeedbackTicket,
  setFeedbackTicketUnread,
  type FeedbackCommentRow,
  type FeedbackEventRow,
  type FeedbackTicketRow,
} from "./repo.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 404 | 409, message: string): Response =>
  c.json({ error: { code: String(status), message }, msg: message }, status);

/** 与 packages/shared/src/feedback.ts 的 FeedbackTicketStatus 一一对应，改那边先改这里。 */
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

/** 与 FeedbackTicketType 一一对应（客户端 content.category）。 */
export const FEEDBACK_TYPES = ["bug", "usage", "feature", "performance"] as const;

/** 与 FeedbackTicketSeverity 一一对应（客户端 content.severity）。 */
export const FEEDBACK_SEVERITIES = ["P1-高", "P2-中", "P3-低"] as const;

const iso = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined;

function readPositiveInt(raw: unknown, fallback: number, max: number): number {
  const parsed = typeof raw === "number" ? Number.parseInt(String(raw), 10) : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/** 客户端 content 块（wire 格式）。 */
function serializeContent(ticket: FeedbackTicketRow) {
  return {
    description: ticket.description,
    category: ticket.type,
    function: ticket.module ?? undefined,
    severity: ticket.severity ?? undefined,
  };
}

/** 客户端详情响应：messages 是双向的，用 sender_type 区分谁说的。 */
function serializeMessages(messages: FeedbackCommentRow[]) {
  return messages.map((message) => ({
    message_id: message.messageId,
    ticket_id: message.ticketId,
    sender_type: message.senderType,
    author_display_name: message.authorDisplayName ?? undefined,
    content: { text: message.body },
    attachments: [],
    created_at: iso(message.createdAt),
  }));
}

function serializeTicketSummary(ticket: FeedbackTicketRow) {
  return {
    ticket_id: ticket.id,
    device_mid: ticket.deviceMid ?? undefined,
    title: ticket.title,
    status: ticket.status,
    created_at: iso(ticket.createdAt),
    updated_at: iso(ticket.updatedAt),
    // 列表项也带 content：客户端 mapTicketSummary 要靠 content.category/severity 还原类型与严重度，
    // 否则所有工单在用户侧都显示成 bug/无严重度。
    content: serializeContent(ticket),
  };
}

async function serializeTicketDetail(db: IdentityDb, ticket: FeedbackTicketRow) {
  const messages = await listFeedbackComments(db, ticket.id);
  return {
    ...serializeTicketSummary(ticket),
    environment: ticket.environment ?? undefined,
    reporter_display: ticket.reporterDisplay ?? undefined,
    messages: serializeMessages(messages),
    attachments: [],
  };
}

// ============================================================================
// 客户端提交面（公开段，Bearer 可选）
// ============================================================================

/**
 * 客户端面路径**必须带 `/api/v1` 前缀**：客户端把基址设成 `<origin>/api/v1` 再拼 `/feedback/...`，
 * 而 identity 这个 Hono 应用没有全局前缀（对比 updates 的 ELECTRON_MANIFEST_PATH 也是全路径）。
 * 少写前缀的后果不是 404 而是 **401**：路径不匹配任何公开路由，请求就落进后面 `authed.use("*")`
 * （实测踩过一次；冒烟也改成打这两个常量，避免再漏）。
 */
export const FEEDBACK_TICKET_PATH = "/api/v1/feedback/ticket";
export const FEEDBACK_ATTACHMENT_CREDENTIAL_PATH = "/api/v1/feedback/attachment/upload-credential";

export interface FeedbackPublicRouteDeps {
  /** 可选身份：带官方/企业令牌时验一下，验不过按匿名处理，不影响提交。 */
  verifyOptionalToken?: (token: string) => Promise<TokenClaims | null>;
}

export function createFeedbackPublicRoutes(
  db: IdentityDb,
  deps: FeedbackPublicRouteDeps = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /** 报告人：能验过令牌就用 claims，否则回退 body.reporter / 空。 */
  const resolveReporter = async (c: Ctx): Promise<TokenClaims | null> => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token || !deps.verifyOptionalToken) return null;
    try {
      return await deps.verifyOptionalToken(token);
    } catch {
      return null;
    }
  };

  app.post(FEEDBACK_TICKET_PATH, async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      title?: string;
      device_mid?: string;
      content?: { description?: string; category?: string; function?: string; severity?: string };
      contact?: string;
      environment?: Record<string, unknown>;
    } | null;
    if (!body) return err(c, 400, "请求体非法");

    const title = body.title?.trim();
    const description = body.content?.description?.trim();
    const type = body.content?.category;
    if (!title) return err(c, 400, "请填写标题");
    if (!description) return err(c, 400, "请填写问题描述");
    if (!type || !FEEDBACK_TYPES.includes(type as (typeof FEEDBACK_TYPES)[number])) {
      return err(c, 400, `type 需为 ${FEEDBACK_TYPES.join(" / ")} 之一`);
    }
    const severity = body.content?.severity?.trim();
    if (severity && !FEEDBACK_SEVERITIES.includes(severity as (typeof FEEDBACK_SEVERITIES)[number])) {
      return err(c, 400, `severity 需为 ${FEEDBACK_SEVERITIES.join(" / ")} 之一`);
    }

    const claims = await resolveReporter(c);
    // 客户端要求请求头带 X-Device-Mid，但 body.device_mid 才是提交时的权威值（两者同源）。
    const deviceMid = body.device_mid?.trim() || c.req.header("x-device-mid")?.trim() || null;

    const ticket = await createFeedbackTicket(db, {
      title,
      description,
      type,
      severity: severity ?? null,
      module: body.content?.function?.trim() || null,
      contact: body.contact?.trim() || null,
      environment: body.environment ?? null,
      reporterDisplay: claims?.name ?? claims?.sub ?? null,
      deviceMid,
      locale: c.req.header("accept-language") ?? null,
      source: typeof body.environment?.["source"] === "string"
        ? (body.environment["source"] as string)
        : null,
    });

    return c.json(await serializeTicketDetail(db, ticket), 201);
  });

  app.get(FEEDBACK_TICKET_PATH, async (c) => {
    const limit = readPositiveInt(c.req.query("limit"), 50, 200);
    const offset = readPositiveInt(c.req.query("offset"), 1, 100_000) - 1;
    // mine 只能按设备身份过滤：Reactor 没有"官方账号-工单"归属（见 docs/feedback-module.md §6）。
    const mine = c.req.query("mine");
    const deviceMid = mine === "1" || mine === "true" ? c.req.header("x-device-mid")?.trim() : undefined;
    const { tickets } = await listFeedbackTickets(db, {
      limit,
      offset,
      status: c.req.query("status") || undefined,
      type: c.req.query("type") || undefined,
      deviceMid: deviceMid || undefined,
    });
    return c.json({ items: tickets.map(serializeTicketSummary) });
  });

  app.get(`${FEEDBACK_TICKET_PATH}/:id`, async (c) => {
    const ticket = await getFeedbackTicket(db, c.req.param("id"));
    if (!ticket) return err(c, 404, "工单不存在");
    return c.json(await serializeTicketDetail(db, ticket));
  });

  app.post(`${FEEDBACK_TICKET_PATH}/:id/message`, async (c) => {
    const ticketId = c.req.param("id");
    const ticket = await getFeedbackTicket(db, ticketId);
    if (!ticket) return err(c, 404, "工单不存在");
    const body = (await c.req.json().catch(() => null)) as {
      content?: { text?: string };
    } | null;
    const text = body?.content?.text?.trim();
    if (!text) return err(c, 400, "消息内容不能为空");

    const claims = await resolveReporter(c);
    const message = await appendFeedbackMessage(db, {
      ticketId,
      body: text,
      senderType: "user",
      authorUserId: claims?.sub ?? null,
      authorDisplayName: claims?.name ?? claims?.sub ?? null,
    });
    // 用户补充即"有新动作"：管理台列表靠 unread 标红点。
    await setFeedbackTicketUnread(db, ticketId, true, { touchActivity: true });
    await appendFeedbackEvent(db, ticketId, {
      type: "user_replied",
      summary: "用户补充了反馈",
      actorDisplayName: claims?.name ?? claims?.sub ?? null,
      payload: { message_id: message.messageId },
    });

    return c.json({
      message_id: message.messageId,
      ticket_id: ticketId,
      sender_type: message.senderType,
      content: { text: message.body },
      attachments: [],
      created_at: iso(message.createdAt),
    });
  });

  /**
   * 附件上传凭证：一期不支持。回 400 + `msg`（客户端 readResponseError 会把它原样当错误文案），
   * 并带上 `attachments_unsupported` 标记，客户端据此把"日志没传上"降级成评论里的系统提示。
   */
  app.post(FEEDBACK_ATTACHMENT_CREDENTIAL_PATH, (c) => {
    const message =
      "attachments_unsupported：自建服务端一期暂不支持附件直传（未接入对象存储），工单正文与评论不受影响。";
    return c.json({ code: 4000, msg: message, detail: message }, 400);
  });

  return app;
}

// ============================================================================
// 管理面（authed 组内，仅 platform_admin）
// ============================================================================

export function createFeedbackAdminRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("claims")?.role !== "platform_admin") return err(c, 403, "仅平台管理员可操作");
    await next();
  };
  app.use("/admin/feedback", requireAdmin);
  app.use("/admin/feedback/*", requireAdmin);

  const audit = async (c: Ctx, entry: Parameters<typeof recordAdminAction>[2]): Promise<void> => {
    const claims = c.get("claims");
    if (!claims?.sub) return;
    await recordAdminAction(db, await resolveActorForClaims(db, claims), entry);
  };

  const actorName = (c: Ctx): string | null => {
    const claims = c.get("claims");
    return claims?.name ?? claims?.sub ?? null;
  };

  const serializeAdminSummary = (ticket: FeedbackTicketRow) => ({
    id: ticket.id,
    title: ticket.title,
    type: ticket.type,
    severity: ticket.severity,
    module: ticket.module,
    status: ticket.status,
    unread: ticket.unread,
    reporter_display: ticket.reporterDisplay,
    device_mid: ticket.deviceMid,
    assignee_id: ticket.assigneeId,
    assignee_display: ticket.assigneeDisplay,
    last_user_activity_at: iso(ticket.lastUserActivityAt),
    created_at: iso(ticket.createdAt),
    updated_at: iso(ticket.updatedAt),
  });

  const serializeAdminMessage = (message: FeedbackCommentRow) => ({
    id: message.id,
    message_id: message.messageId,
    sender_type: message.senderType,
    author_user_id: message.authorUserId,
    author_display_name: message.authorDisplayName,
    body: message.body,
    is_staff: message.senderType === "staff" || message.senderType === "admin",
    created_at: iso(message.createdAt),
  });

  const serializeAdminEvent = (event: FeedbackEventRow) => ({
    id: event.id,
    type: event.type,
    summary: event.summary,
    actor_display_name: event.actorDisplayName,
    payload: event.payload,
    created_at: iso(event.createdAt),
  });

  app.get("/admin/feedback/tickets", async (c) => {
    const limit = readPositiveInt(c.req.query("limit"), 50, 200);
    const offset = readPositiveInt(c.req.query("offset"), 1, 100_000) - 1;
    const { tickets, total } = await listFeedbackTickets(db, {
      limit,
      offset,
      status: c.req.query("status")?.trim() || undefined,
      type: c.req.query("type")?.trim() || undefined,
      severity: c.req.query("severity")?.trim() || undefined,
      q: c.req.query("q")?.trim() || undefined,
      unreadOnly: c.req.query("unread") === "1",
    });
    return c.json({
      tickets: tickets.map(serializeAdminSummary),
      total,
      limit,
      offset,
      // 前端下拉的可选项直接由服务端下发，避免两端各维护一份枚举。
      statuses: [...FEEDBACK_STATUSES],
      types: [...FEEDBACK_TYPES],
    });
  });

  app.get("/admin/feedback/tickets/:id", async (c) => {
    const ticket = await getFeedbackTicket(db, c.req.param("id"));
    if (!ticket) return err(c, 404, "工单不存在");
    const [messages, events] = await Promise.all([
      listFeedbackComments(db, ticket.id),
      listFeedbackEvents(db, ticket.id),
    ]);
    // 打开详情即视为已读；红点不熄会让受理人反复回来看同一张单。
    await setFeedbackTicketUnread(db, ticket.id, false);
    return c.json({
      ticket: {
        ...serializeAdminSummary(ticket),
        unread: false,
        description: ticket.description,
        contact: ticket.contact,
        environment: ticket.environment,
        locale: ticket.locale,
        source: ticket.source,
        messages: messages.map(serializeAdminMessage),
        events: events.map(serializeAdminEvent),
      },
    });
  });

  app.patch("/admin/feedback/tickets/:id", async (c) => {
    const ticketId = c.req.param("id");
    const existing = await getFeedbackTicket(db, ticketId);
    if (!existing) return err(c, 404, "工单不存在");

    const body = (await c.req.json().catch(() => null)) as {
      status?: string;
      severity?: string | null;
      assignee_id?: string | null;
      assignee_display?: string | null;
    } | null;
    if (!body) return err(c, 400, "请求体非法");
    if (
      body.status !== undefined &&
      !FEEDBACK_STATUSES.includes(body.status as (typeof FEEDBACK_STATUSES)[number])
    ) {
      return err(c, 400, `status 需为：${FEEDBACK_STATUSES.join(" / ")}`);
    }
    if (
      body.severity !== undefined &&
      body.severity !== null &&
      !FEEDBACK_SEVERITIES.includes(body.severity as (typeof FEEDBACK_SEVERITIES)[number])
    ) {
      return err(c, 400, `severity 需为：${FEEDBACK_SEVERITIES.join(" / ")}`);
    }
    if (body.status === undefined && body.severity === undefined && body.assignee_id === undefined) {
      return err(c, 400, "没有需要更新的字段");
    }

    const name = actorName(c);
    const { before, after } = await patchFeedbackTicket(db, ticketId, {
      status: body.status,
      severity: body.severity,
      assigneeId: body.assignee_id,
      assigneeDisplay: body.assignee_display,
    });
    if (!after) return err(c, 404, "工单不存在");

    // 事件逐字段写，时间线上才看得出"改了什么"；只写一条笼统的 updated 没有信息量。
    if (body.status !== undefined && before!.status !== after.status) {
      await appendFeedbackEvent(db, ticketId, {
        type: "status_changed",
        summary: `状态：${before!.status} → ${after.status}`,
        actorDisplayName: name,
        payload: { from: before!.status, to: after.status },
      });
    }
    if (
      body.assignee_id !== undefined &&
      (before!.assigneeId !== after.assigneeId || before!.assigneeDisplay !== after.assigneeDisplay)
    ) {
      await appendFeedbackEvent(db, ticketId, {
        type: "assignee_changed",
        summary: `负责人：${before!.assigneeDisplay ?? "未指派"} → ${after.assigneeDisplay ?? "未指派"}`,
        actorDisplayName: name,
        payload: { from: before!.assigneeDisplay, to: after.assigneeDisplay },
      });
    }
    if (body.severity !== undefined && before!.severity !== after.severity) {
      await appendFeedbackEvent(db, ticketId, {
        type: "status_changed",
        summary: `严重度：${before!.severity ?? "未定"} → ${after.severity ?? "未定"}`,
        actorDisplayName: name,
        payload: { field: "severity", from: before!.severity, to: after.severity },
      });
    }

    await audit(c, {
      op: "feedback.ticket.update",
      target: `feedback:${ticketId}`,
      summary: `更新工单「${after.title}」：${[body.status ? `状态=${body.status}` : null, body.severity ? `严重度=${body.severity}` : null, body.assignee_id !== undefined ? `负责人=${after.assigneeDisplay ?? "未指派"}` : null].filter(Boolean).join("、")}`,
    });

    return c.json({ ticket: serializeAdminSummary(after) });
  });

  app.post("/admin/feedback/tickets/:id/messages", async (c) => {
    const ticketId = c.req.param("id");
    const ticket = await getFeedbackTicket(db, ticketId);
    if (!ticket) return err(c, 404, "工单不存在");
    const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
    const text = body?.body?.trim();
    if (!text) return err(c, 400, "回复内容不能为空");

    const claims = c.get("claims");
    const name = actorName(c);
    const message = await appendFeedbackMessage(db, {
      ticketId,
      body: text,
      senderType: "staff",
      authorUserId: claims?.sub ?? null,
      authorDisplayName: name,
    });
    await appendFeedbackEvent(db, ticketId, {
      type: "staff_replied",
      summary: "客服已回复",
      actorDisplayName: name,
      payload: { message_id: message.messageId },
    });
    // 管理员回复不是"用户的新动作"，红点保持熄灭；只推进 updated_at。
    await setFeedbackTicketUnread(db, ticketId, false);

    await audit(c, {
      op: "feedback.ticket.reply",
      target: `feedback:${ticketId}`,
      summary: `回复工单「${ticket.title}」（${text.length} 字）`,
    });

    return c.json({ message: serializeAdminMessage(message) });
  });

  return app;
}
