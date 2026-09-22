/**
 * 反馈 / 需求（FBK）—— **PG + 两个路由面探针**（前置：PG 可达；连不上打印 SKIP 并以 0 退出）。
 *
 * ## 守什么（都是"静态检查看不出来"的那类）
 *
 * ① **建表幂等**：无迁移框架，靠 `IF NOT EXISTS`，连跑两次不能抛。
 * ② **提交面真的公开**：不注入任何 claims、不带 Authorization 也能建单 ——
 *    Reactor 用户只有企业账号、没有官方 zcodejwttoken，这一条挂了就是"上报全部 401"。
 * ③ **wire 格式**：响应必须是客户端 `FeedbackHttpClient` 认的那套
 *    （`ticket_id` / `content.category` / `messages[].sender_type`），字段名对不上 =
 *    管理台有数据但客户端列表全是 bug、状态全坍缩成"已提交"。
 * ④ **附件走字节直传**：`PUT /api/v1/feedback/ticket/:id/attachment` 落盘 + sha256 入库，
 *    中文文件名经 percent-encode 传输后原样还原；用户侧与管理面都能把字节原样下载回来。
 *    OSS 直传凭证端点仍回 400 + `attachments_unsupported`（只有官方后端有那套 OSS）。
 * ⑤ **管理面鉴权**：非 platform_admin → 403；未注入 claims → 401。
 * ⑥ **流转写事件**：改状态要落 `status_changed` 事件，管理台时间线才答得了"谁改的什么"。
 * ⑧ **提交者身份**：姓名/部门只认企业 JWT 的 claims，客户端自报的 reporter 一律不采信。
 * ⑦ **红点语义**：用户补充消息 → unread=true；管理台打开详情 → unread=false。
 *
 * 用法：`pnpm --filter @reactor/server smoke:feedback`
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { fileURLToPath } from "node:url";

import type { TokenClaims } from "../src/identity/auth.js";
import { closeIdentityDb, createIdentityDb, ensureSchema, type IdentityDb } from "../src/identity/db.js";
import { ensureAuditSchema } from "../src/audit/schema.js";
// 冒烟库隔离（真实库不受影响）：见 lib/smoke-db.mjs 头注
import { useSmokeDb } from "./lib/smoke-db.mjs";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
}

// 与 e2e-smoke.mjs 同口径：先吃 **server 根**的 .env（REACTOR_DB_URL 在那里，
// compose 的 env_file 也指向它）。注意 cwd 是 packages/server，不指定路径会加载不到，
// 表现成"退回 55432 → PG 不可达"，而 compose 里的 PG 映射在 15432。
// 必须 fileURLToPath：仓库路径含中文，URL.pathname 既带前导斜杠又是百分号编码，直接喂会 stat 不到。
try {
  // 三级 `..`：base 是本文件（packages/server/scripts/），两级只会到 packages/。
  process.loadEnvFile?.(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 没有 .env 就按环境变量与默认值走 */
}

const dbUrl = () =>
  process.env["REACTOR_DB_URL"]?.trim() ||
  process.env["REACTOR_DATABASE_URL"]?.trim() ||
  "postgres://reactor:reactor@127.0.0.1:15432/reactor";

async function main(): Promise<void> {
  // ★ 附件落盘目录是 routes.ts 的**模块级常量**：必须在动态 import routes 之前设好，
  //   否则会写进真实目录（同 updates-smoke 对 REACTOR_UPDATE_FILE_DIR 的处理）。
  const attachmentDir = mkdtempSync(join(tmpdir(), "reactor-feedback-smoke-"));
  process.env["REACTOR_FEEDBACK_FILE_DIR"] = attachmentDir;

  // ★ 必须最先执行：切到独立冒烟库（每次重建），真实库不受影响
  try {
    await useSmokeDb();
  } catch (err) {
    console.log(`SKIP: 冒烟库准备失败（PG 不可达？）: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }

  let db: IdentityDb;
  try {
    db = createIdentityDb(dbUrl());
    await db.pool.query("SELECT 1");
  } catch (err) {
    console.log(`SKIP: PG 不可达（${dbUrl()}）: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }

  try {
    const { ensureFeedbackSchema } = await import("../src/feedback/schema.js");
    const { createFeedbackAdminRoutes, createFeedbackPublicRoutes, FEEDBACK_TICKET_PATH, FEEDBACK_ATTACHMENT_CREDENTIAL_PATH } = await import(
      "../src/feedback/routes.js"
    );

    /* ── ① 建表幂等 ──────────────────────────────────────────────────── */
    console.log("· 建表");
    // 基础身份表必须先在：管理面写审计要 resolveActorForClaims → 查 users 表，
    // 空库上只建 feedback 表会让 PATCH 直接 500（冒烟真实踩过）。
    await ensureSchema(db);
    // 管理面的 PATCH / 回复都会写审计；缺 audit 表时请求仍成功，但审计静默丢
    // （recordAdminAction 内部吞错只打日志）—— 冒烟要把这条也守出来。
    await ensureAuditSchema(db);
    await ensureFeedbackSchema(db);
    await ensureFeedbackSchema(db); // 幂等：第二次不应报错
    check("建表幂等（连跑两次不抛）", true);

    // 提交者身份要落到 departments.path：先造一个部门，后面断言"姓名/部门来自令牌"
    const deptRow = await db.pool.query<{ id: number }>(
      "INSERT INTO departments (parent_id, name, path, depth) VALUES (NULL, '冒烟部门', '冒烟部门', 1) RETURNING id",
    );
    const probeDeptId = deptRow.rows[0]!.id;

    /* ── 路由装配：管理面注入 claims，提交面刻意**完全不注入** ─────────── */
    const admin = new Hono<{ Variables: { claims: TokenClaims } }>();
    let currentClaims: TokenClaims | null = { sub: "probe-admin", name: "探针管理员", role: "platform_admin" };
    admin.use("*", async (c, next) => {
      if (!currentClaims) {
        return c.json({ error: { code: "unauthorized", message: "未登录" } }, 401);
      }
      c.set("claims", currentClaims);
      await next();
    });
    admin.route("/", createFeedbackAdminRoutes(db));

    // 可选身份：只有带对令牌才解析出 claims（真实链路里是 identity 的 verifyAccess）。
    const ENTERPRISE_TOKEN = "probe-enterprise-token";
    const pub = new Hono();
    pub.route(
      "/",
      createFeedbackPublicRoutes(db, {
        verifyOptionalToken: async (token) =>
          token === ENTERPRISE_TOKEN
            ? { sub: "tian.keda", name: "田科达", role: "user", deptId: probeDeptId }
            : null,
      }),
    );

    type Requestable = { request: (input: string, init?: RequestInit) => Promise<Response> };
    const adminApp: Requestable = admin;
    const publicApp: Requestable = pub;

    const json = (app: Requestable, path: string, method: string, body: unknown) =>
      app.request(path, {
        method,
        headers: { "content-type": "application/json", "x-device-mid": "probe-device-mid" },
        body: JSON.stringify(body),
      });

    /* ── ② 提交面：无 claims、无 Authorization 也能建单 ────────────────── */
    console.log("· 客户端提交面（公开）");
    const created = await json(publicApp, FEEDBACK_TICKET_PATH, "POST", {
      title: "冒烟：点击发送后无响应",
      device_mid: "probe-device-mid",
      content: {
        description: "复现步骤：1) 打开会话 2) 点击发送\n期望：正常发出",
        category: "bug",
        function: "UI布局 / 交互",
        severity: "P2-中",
      },
      contact: "test@example.com",
      environment: { app_version: "9.9.9", platform: "windows-x64", os_arch: "x64" },
    });
    const createdBody = (await created.json()) as {
      ticket_id?: string;
      status?: string;
      content?: { category?: string };
      created_at?: string;
      messages?: unknown[];
    };
    check(
      "匿名提交 → 201 且返回 ticket_id/status/content",
      created.status === 201 && typeof createdBody.ticket_id === "string" && createdBody.status === "已提交",
      { status: created.status, body: createdBody },
    );
    const ticketId = createdBody.ticket_id ?? "";
    check(
      "wire 格式：content.category 原样回带（否则客户端全显示成 bug）",
      createdBody.content?.category === "bug",
      createdBody.content,
    );
    check("新建工单 messages 为空数组", Array.isArray(createdBody.messages) && createdBody.messages!.length === 0);

    /* ── ③ 提交者身份：姓名与部门必须来自令牌，不采信客户端自报 ────────── */
    const authedCreate = await publicApp.request(FEEDBACK_TICKET_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-mid": "probe-device-mid",
        authorization: `Bearer ${ENTERPRISE_TOKEN}`,
      },
      body: JSON.stringify({
        title: "带身份提交的工单",
        device_mid: "probe-device-mid",
        content: { description: "从登录态提交，应带上姓名与部门", category: "usage" },
        // 这些字段客户端可以乱写；服务端必须忽略它们，只认令牌 claims
        reporter: { display_name: "我是冒充的" },
        environment: { user_name: "也是冒充的" },
      }),
    });
    const authedBody = (await authedCreate.json()) as { ticket_id?: string };
    check("带企业令牌提交 → 201", authedCreate.status === 201, authedCreate.status);
    const identityRow = await db.pool.query<{
      reporter_display: string | null;
      reporter_uid: string | null;
      reporter_dept: string | null;
    }>(
      "SELECT reporter_display, reporter_uid, reporter_dept FROM feedback_ticket WHERE id = $1",
      [authedBody.ticket_id ?? ""],
    );
    const identity = identityRow.rows[0];
    check("报告人姓名取自令牌 claims.name（不信客户端自报）", identity?.reporter_display === "田科达", identity);
    check("报告人账号取自令牌 sub", identity?.reporter_uid === "tian.keda", identity);
    check("部门取 departments.path", identity?.reporter_dept === "冒烟部门", identity);

    const anonRow = await db.pool.query<{ reporter_display: string | null; reporter_dept: string | null }>(
      "SELECT reporter_display, reporter_dept FROM feedback_ticket WHERE id = $1",
      [ticketId],
    );
    check(
      "匿名提交的报告人/部门留空",
      anonRow.rows[0]?.reporter_display === null && anonRow.rows[0]?.reporter_dept === null,
      anonRow.rows[0],
    );

    /* ── ④ 校验：缺字段 / 非法枚举 ───────────────────────────────────── */
    const noTitle = await json(publicApp, FEEDBACK_TICKET_PATH, "POST", {
      title: "  ",
      content: { description: "x", category: "bug" },
    });
    check("缺标题 → 400", noTitle.status === 400, noTitle.status);
    const badType = await json(publicApp, FEEDBACK_TICKET_PATH, "POST", {
      title: "t",
      content: { description: "d", category: "not-a-type" },
    });
    check("非法 type → 400", badType.status === 400, badType.status);

    /* ── ⑤ 附件凭证：旧客户端的兼容位，明确拒绝 + 标记 ────────────────── */
    const upload = await json(publicApp, FEEDBACK_ATTACHMENT_CREDENTIAL_PATH, "POST", {
      ticket_id: ticketId,
      file_name: "log.zip",
      size: 1024,
    });
    const uploadBody = (await upload.json()) as { code?: number; msg?: string };
    check("附件凭证 → 400（旧客户端走 PUT 直传，见 ⑤b）", upload.status === 400, upload.status);
    check(
      "错误信息带 attachments_unsupported 标记（客户端靠它降级）",
      typeof uploadBody.msg === "string" && uploadBody.msg.includes("attachments_unsupported"),
      uploadBody,
    );

    /* ── ⑤b 附件字节直传：PUT 落盘 + 中文名 + 两面下载 ─────────────────── */
    console.log("· 附件字节直传");
    const payload = Buffer.from("REACTOR-FEEDBACK-ATTACHMENT-PAYLOAD");
    const putRes = await publicApp.request(
      `${FEEDBACK_TICKET_PATH}/${ticketId}/attachment?kind=image`,
      {
        method: "PUT",
        headers: {
          "x-file-name": encodeURIComponent("截图-问题.png"),
          "content-type": "image/png",
        },
        body: payload,
      },
    );
    const putBody = (await putRes.json()) as {
      attachment_id?: number;
      size?: number;
      sha256?: string;
    };
    check("PUT 附件 → 201", putRes.status === 201, putRes.status);
    check(
      "大小与 sha256 与本地一致",
      putBody.size === payload.length &&
        putBody.sha256 === createHash("sha256").update(payload).digest("hex"),
      putBody,
    );
    const storedRow = await db.pool.query<{ file_name: string; stored_name: string }>(
      "SELECT file_name, stored_name FROM feedback_attachment WHERE id = $1",
      [putBody.attachment_id ?? 0],
    );
    check(
      // x-file-name 是 percent-encode 过的（HTTP 头是 latin1），落库必须还原成中文原名
      "中文文件名无损还原",
      storedRow.rows[0]?.file_name === "截图-问题.png",
      storedRow.rows[0],
    );
    check(
      "磁盘名是 uuid（不含原名）",
      Boolean(storedRow.rows[0]?.stored_name) && !storedRow.rows[0]!.stored_name.includes("截图"),
      storedRow.rows[0]?.stored_name,
    );
    const publicDownload = await publicApp.request(
      `${FEEDBACK_TICKET_PATH}/${ticketId}/attachments/${putBody.attachment_id}`,
    );
    const publicBytes = Buffer.from(await publicDownload.arrayBuffer());
    check(
      "用户侧下载 200 且字节一致",
      publicDownload.status === 200 && publicBytes.equals(payload),
      publicDownload.status,
    );
    const adminDownload = await adminApp.request(
      `/admin/feedback/tickets/${ticketId}/attachments/${putBody.attachment_id}/download`,
    );
    const adminBytes = Buffer.from(await adminDownload.arrayBuffer());
    check(
      "管理面下载 200 且字节一致",
      adminDownload.status === 200 && adminBytes.equals(payload),
      adminDownload.status,
    );
    const badExtension = await publicApp.request(
      `${FEEDBACK_TICKET_PATH}/${ticketId}/attachment?kind=other`,
      { method: "PUT", headers: { "x-file-name": "evil.exe" }, body: "x" },
    );
    check("非白名单后缀 → 400", badExtension.status === 400, badExtension.status);
    const detailWithAttachment = await adminApp.request(
      `/admin/feedback/tickets/${ticketId}`,
    );
    const detailAttachmentBody = (await detailWithAttachment.json()) as {
      ticket?: { attachments?: unknown[] };
    };
    check(
      "详情返回附件列表（管理台据此渲染下载）",
      (detailAttachmentBody.ticket?.attachments ?? []).length >= 1,
      detailAttachmentBody.ticket?.attachments?.length,
    );

    /* ── ⑥ 用户补充消息 → unread 点亮 ────────────────────────────────── */
    const replied = await json(publicApp, `${FEEDBACK_TICKET_PATH}/${ticketId}/message`, "POST", {
      content: { text: "补充：只在深色主题下复现" },
    });
    check("用户补充消息 → 200", replied.status === 200, replied.status);
    const repliedBody = (await replied.json()) as { message_id?: string; sender_type?: string };
    check(
      "消息回执带 message_id 且 sender_type=user",
      Boolean(repliedBody.message_id) && repliedBody.sender_type === "user",
      repliedBody,
    );
    const unreadRow = await db.pool.query<{ unread: boolean }>(
      "SELECT unread FROM feedback_ticket WHERE id = $1",
      [ticketId],
    );
    check("用户补充后 unread=true", unreadRow.rows[0]?.unread === true, unreadRow.rows[0]);

    /* ── ⑦ 管理面鉴权 ────────────────────────────────────────────────── */
    console.log("· 管理面鉴权");
    currentClaims = { sub: "probe-user", name: "探针用户", role: "user" };
    const denied = await json(adminApp, "/admin/feedback/tickets", "GET", undefined);
    check("非 platform_admin 列表 → 403", denied.status === 403, denied.status);
    currentClaims = null;
    const anonymous = await adminApp.request("/admin/feedback/tickets");
    check("无 claims → 401", anonymous.status === 401, anonymous.status);
    currentClaims = { sub: "probe-admin", name: "探针管理员", role: "platform_admin" };

    /* ── ⑧ 管理台列表 / 详情 / 流转 / 回复 ────────────────────────────── */
    console.log("· 管理台受理");
    const list = await adminApp.request(`/admin/feedback/tickets?q=${encodeURIComponent("发送")}`);
    const listBody = (await list.json()) as {
      tickets?: Array<{ id: string; title: string; type: string; unread: boolean }>;
      total?: number;
      statuses?: string[];
      types?: string[];
    };
    check("列表能按关键字查到刚建的单", (listBody.tickets ?? []).some((t) => t.id === ticketId), listBody.total);
    check("列表下发状态/类型枚举（前端下拉直接用）", (listBody.statuses ?? []).length === 9, listBody.statuses);

    const detailRes = await adminApp.request(`/admin/feedback/tickets/${ticketId}`);
    const detailBody = (await detailRes.json()) as {
      ticket?: {
        unread: boolean;
        messages?: Array<{ sender_type: string; body: string }>;
        events?: Array<{ type: string }>;
        environment?: Record<string, unknown> | null;
      };
    };
    check(
      "详情含那条用户消息（此时只有 1 条，管理员回复还没发）",
      (detailBody.ticket?.messages ?? []).length === 1 &&
        detailBody.ticket?.messages?.[0]?.sender_type === "user",
      detailBody.ticket?.messages,
    );
    check(
      "详情把 unread 熄掉（打开即已读）",
      detailBody.ticket?.unread === false,
      detailBody.ticket?.unread,
    );
    check("建单事件在时间线里", (detailBody.ticket?.events ?? []).some((e) => e.type === "created"));

    const patch = await json(adminApp, `/admin/feedback/tickets/${ticketId}`, "PATCH", {
      status: "开发中",
    });
    const patchBody = (await patch.json()) as { ticket?: { status?: string } };
    check("流转状态 → 200 且返回新状态", patch.status === 200 && patchBody.ticket?.status === "开发中", patchBody);

    const eventsAfter = await db.pool.query<{ type: string; summary: string }>(
      "SELECT type, summary FROM feedback_event WHERE ticket_id = $1 ORDER BY id",
      [ticketId],
    );
    check(
      "流转写了 status_changed 事件（带 from → to）",
      eventsAfter.rows.some((e) => e.type === "status_changed" && e.summary.includes("→")),
      eventsAfter.rows,
    );

    const badStatus = await json(adminApp, `/admin/feedback/tickets/${ticketId}`, "PATCH", {
      status: "不存在的状态",
    });
    check("非法状态 → 400", badStatus.status === 400, badStatus.status);

    const staffReply = await json(adminApp, `/admin/feedback/tickets/${ticketId}/messages`, "POST", {
      body: "已复现，开发中",
    });
    const staffBody = (await staffReply.json()) as { message?: { sender_type?: string } };
    check("管理员回复 → 200 且 sender_type=staff", staffReply.status === 200 && staffBody.message?.sender_type === "staff", staffBody);

    const unreadAfterStaff = await db.pool.query<{ unread: boolean }>(
      "SELECT unread FROM feedback_ticket WHERE id = $1",
      [ticketId],
    );
    check("管理员回复不重亮点（unread 仍 false）", unreadAfterStaff.rows[0]?.unread === false, unreadAfterStaff.rows[0]);

    const clientDetail = await publicApp.request(`${FEEDBACK_TICKET_PATH}/${ticketId}`);
    const clientDetailBody = (await clientDetail.json()) as {
      messages?: Array<{ sender_type: string }>;
    };
    check(
      "客户端详情里能看出谁是客服（sender_type=staff）",
      (clientDetailBody.messages ?? []).some((m) => m.sender_type === "staff"),
      clientDetailBody.messages?.map((m) => m.sender_type),
    );
    check(
      "管理员回复后客户端看到两条消息",
      (clientDetailBody.messages ?? []).length === 2,
      clientDetailBody.messages?.length,
    );

    const missing = await publicApp.request(`${FEEDBACK_TICKET_PATH}/does-not-exist`);
    check("查不存在的单 → 404", missing.status === 404, missing.status);
  } finally {
    await closeIdentityDb(db).catch(() => undefined);
    rmSync(attachmentDir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("冒烟异常:", err);
  process.exit(1);
});
