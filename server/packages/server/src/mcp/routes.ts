/**
 * 托管 MCP 路由（治理平面 P0，spec 见 docs/未完成-MCP治理平面-spec-v1.md）。
 *
 * **两个工厂、三种挂载点**：
 *  - `createMcpRoutes`（本文件上方）：管理面 `/admin/mcp/servers*`（仅 platform_admin，
 *    adminAudit 兜底 + 富审计，红线：**密钥值绝不入快照**）+ relay-token 签发（需 access，
 *    挂 authed 后复用其 Bearer）。
 *  - `createMcpRelayRoutes`（文件末尾）：relay 数据面 JSON-RPC/SSE/DELETE —— **挂公开段**
 *    （authed 之前，与 updates/feedback 公开面同一机制）。原因：authed 组会把 relay 短期令牌
 *    当 access 验（audience 不同）→ 一律 401；relay 自带 aud=mcp-relay 鉴权，挂公开段让
 *    长期 access 令牌不进转发链。
 *
 * relay 纪律（spec §1/§6）：
 *  - 注入上游的请求头**白名单**透传（accept/content-type/mcp-session-id 等），其余一律丢弃；
 *  - 逐调用再判：服务停用 / 工具 block / 工具 problem → JSON-RPC error denied；
 *    tools/list 结果同步过滤 block/problem 工具（双保险：端侧注册期已过滤）；
 *  - 上游错误原样转发（状态码 + JSON-RPC error 体），不吞错、不回落、不重试；
 *  - 每次 tools/call 落一条 `tool_call` 审计（只记元数据，不含参数与输出正文）。
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { TokenClaims } from "../identity/auth.js";
import type { Role } from "../identity/users.js";
import type { IdentityDb } from "../identity/db.js";
import { insertAuditBatch, recordAdminAction, resolveActorForClaims } from "../audit/repo.js";
import { markAdminAudited } from "../audit/adminAudit.js";
import { openSecret, sealSecret } from "../common/secrets-crypto.js";
import {
  buildSnapshot,
  normalizeToolPolicy,
  type McpToolPolicy,
} from "./catalog.js";
import { probeMcpServer } from "./probe.js";
import { MCP_RELAY_TOKEN_TTL_SECONDS, signMcpRelayToken, verifyMcpRelayToken } from "./relay-token.js";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  getMcpServerByName,
  listMcpServers,
  MCP_SERVER_NAME_PATTERN,
  patchMcpServer,
  putToolPolicy,
  saveSnapshot,
  type McpServerPublic,
  type McpServerRecord,
} from "./repo.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 422 | 500, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

export interface McpRoutesOptions {
  /** AES 主密钥（identity 启动批 loadSecretKey 的结果；null = 明文降级，同 gateway 先例） */
  secretKey: Buffer | null;
  /** 与 access/gateway 令牌同源的 JWT 签名密钥（aud 隔离） */
  jwtSecret: string;
  /** relay 短期令牌 TTL（秒），缺省 24h */
  relayTokenTtlSeconds?: number;
}

/** 保留请求头：转发语义由服务端控制，不允许管理员配置、也不透传给上游。 */
const RESERVED_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "origin",
  "referer",
  "cookie",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

/** 端侧 → relay 透传白名单：其余一律丢弃（尤其 relay JWT 不能到达上游）。 */
const FORWARD_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

/** 上游 → 端侧响应透传白名单（hop-by-hop 与压缩头不透传——fetch 已解压）。 */
const FORWARD_RESPONSE_HEADERS = new Set(["content-type", "mcp-session-id", "mcp-protocol-version"]);

const HEADER_VALUE_MAX = 4096;
const MAX_CUSTOM_HEADERS = 10;

export function createMcpRoutes(db: IdentityDb, opts: McpRoutesOptions) {
  const app = new Hono<AppEnv>();
  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("claims")?.role !== "platform_admin") return err(c, 403, "仅平台管理员可管理 MCP 服务");
    await next();
  };
  app.use("/admin/mcp", requireAdmin);
  app.use("/admin/mcp/*", requireAdmin);

  // ===== 管理面：注册表 CRUD =====

  app.get("/admin/mcp/servers", async (c) => {
    return c.json({ servers: await listMcpServers(db) });
  });

  app.post("/admin/mcp/servers", async (c) => {
    const claims = c.get("claims");
    const body = (await c.req.json().catch(() => null)) as McpServerUpsertBody | null;
    if (!body) return err(c, 400, "请求体非法");
    const invalid = validateUpsertBody(body);
    if (invalid) return err(c, 400, invalid);
    const name = body.name.trim();
    if (await getMcpServerByName(db, name)) return err(c, 409, "同名服务已存在（服务名即工具名前缀，全局唯一）");
    if (body.auth === "shared") {
      const headerProblem = validateHeaderCount(body.headers ?? {});
      if (headerProblem) return err(c, 400, headerProblem);
    }
    const sealedMap =
      body.auth === "shared"
        ? sealHeaderMap(body.headers ?? {}, opts.secretKey)
        : { sealed: {} as Record<string, string>, display: [] as Array<{ name: string; last4: string }> };
    if (typeof sealedMap === "string") return err(c, 400, sealedMap);
    // fail-fast：登记必须先连一次拉到工具清单，连不上什么都不保存（spec §4，不留半成品）
    const upstreamHeaders = openHeaderMap(sealedMap.sealed, opts.secretKey);
    if (typeof upstreamHeaders === "string") return err(c, 422, upstreamHeaders);
    const probe = await probeMcpServer({ url: body.url.trim(), type: body.type, headers: upstreamHeaders });
    if (!probe.ok) return err(c, 422, probe.error ?? "探测失败");

    const { snapshot, policy } = buildSnapshot(probe.tools ?? [], [], {}, true);
    const record = await createMcpServer(db, {
      name,
      displayName: (body.displayName ?? "").trim(),
      type: body.type,
      url: body.url.trim(),
      auth: body.auth,
      headersCiphertext: sealedMap.sealed,
      headerNames: sealedMap.display,
      toolsSnapshot: snapshot,
      toolPolicy: policy,
      createdBy: claims.sub,
    });
    await recordAdminAudit(c, db, claims, "mcp.create", `mcp_server:${record.id}`, `登记托管 MCP「${record.name}」（${snapshot.length} 个工具）`);
    return c.json({ server: toAdminView(record) }, 201);
  });

  app.patch("/admin/mcp/servers/:id", async (c) => {
    const claims = c.get("claims");
    const id = c.req.param("id");
    const existing = await getMcpServer(db, id);
    if (!existing) return err(c, 404, "服务不存在");
    const body = (await c.req.json().catch(() => null)) as (Partial<McpServerUpsertBody> & { enabled?: boolean }) | null;
    if (!body) return err(c, 400, "请求体非法");
    if (body.url !== undefined) {
      const urlProblem = validateUrl(body.url);
      if (urlProblem) return err(c, 400, urlProblem);
    }
    if (body.type !== undefined && body.type !== "http" && body.type !== "sse") return err(c, 400, "type 非法");
    if (body.auth !== undefined && body.auth !== "none" && body.auth !== "shared") return err(c, 400, "auth 非法");

    // headers 掩码语义：回传 "********" 的名 = 保持原值（沿用旧密文），其余新值重新封存
    let sealedMap: { sealed: Record<string, string>; display: Array<{ name: string; last4: string }> } | null = null;
    if (body.headers !== undefined) {
      const merged = mergeHeaderMapWithMask(
        body.auth === "none" ? {} : body.headers ?? {},
        existing.headersCiphertext,
        existing.headerNames,
        opts.secretKey,
      );
      if (typeof merged === "string") return err(c, 400, merged);
      sealedMap = merged;
    }

    const willChangeConnect =
      (body.url !== undefined && body.url.trim() !== existing.url) ||
      (body.type !== undefined && body.type !== existing.type) ||
      (body.auth !== undefined && body.auth !== existing.auth) ||
      sealedMap !== null;
    if (willChangeConnect) {
      // 连接相关字段变化必须重新 probe（fail-fast）；成功则同步快照（语义同手动同步）
      const upstreamHeaders = openHeaderMap((sealedMap?.sealed ?? existing.headersCiphertext), opts.secretKey);
      if (typeof upstreamHeaders === "string") return err(c, 422, upstreamHeaders);
      const probe = await probeMcpServer({
        url: (body.url ?? existing.url).trim(),
        type: body.type ?? existing.type,
        headers: upstreamHeaders,
      });
      if (!probe.ok) return err(c, 422, probe.error ?? "探测失败");
      const { snapshot, policy } = buildSnapshot(probe.tools ?? [], existing.toolsSnapshot, existing.toolPolicy, false);
      const patched = await patchMcpServer(db, id, {
        displayName: body.displayName?.trim(),
        type: body.type,
        url: body.url?.trim(),
        auth: body.auth,
        ...(sealedMap !== null ? { headersCiphertext: sealedMap.sealed, headerNames: sealedMap.display } : {}),
        enabled: body.enabled,
        updatedBy: claims.sub,
      });
      if (!patched) return err(c, 404, "服务不存在");
      await saveSnapshot(db, id, snapshot, policy, null);
      await recordAdminAudit(c, db, claims, "mcp.update", `mcp_server:${id}`, `修改托管 MCP「${existing.name}」（重探 ${snapshot.length} 个工具）`, {
        changed: { before: toAdminView(existing), after: toAdminView(patched) },
      });
      const fresh = await getMcpServer(db, id);
      return c.json({ server: toAdminView(fresh ?? patched) });
    }
    const patched = await patchMcpServer(db, id, {
      displayName: body.displayName?.trim(),
      enabled: body.enabled,
      updatedBy: claims.sub,
    });
    if (!patched) return err(c, 404, "服务不存在");
    await recordAdminAudit(c, db, claims, "mcp.update", `mcp_server:${id}`, `修改托管 MCP「${existing.name}」`, {
      changed: { before: toAdminView(existing), after: toAdminView(patched) },
    });
    return c.json({ server: toAdminView(patched) });
  });

  app.delete("/admin/mcp/servers/:id", async (c) => {
    const claims = c.get("claims");
    const id = c.req.param("id");
    const existing = await getMcpServer(db, id);
    if (!existing) return err(c, 404, "服务不存在");
    await deleteMcpServer(db, id);
    // 删除审计存全量字段（凭据只有 header 名与末四位，绝不存密文/明文）
    await recordAdminAudit(c, db, claims, "mcp.delete", `mcp_server:${id}`, `删除托管 MCP「${existing.name}」`, {
      deleted: { ...toAdminView(existing) },
    });
    return c.json({ ok: true });
  });

  app.post("/admin/mcp/servers/:id/sync", async (c) => {
    const claims = c.get("claims");
    const id = c.req.param("id");
    const existing = await getMcpServer(db, id);
    if (!existing) return err(c, 404, "服务不存在");
    const upstreamHeaders = openHeaderMap(existing.headersCiphertext, opts.secretKey);
    if (typeof upstreamHeaders === "string") {
      await saveSnapshot(db, id, existing.toolsSnapshot, existing.toolPolicy, upstreamHeaders);
      return c.json({ ok: false, error: upstreamHeaders });
    }
    const probe = await probeMcpServer({ url: existing.url, type: existing.type, headers: upstreamHeaders });
    if (!probe.ok) {
      // 手动同步失败：保旧快照只记 sync_error，正在用的会话不受影响（spec §4）
      await saveSnapshot(db, id, existing.toolsSnapshot, existing.toolPolicy, probe.error ?? "同步失败");
      await recordAdminAudit(c, db, claims, "mcp.sync", `mcp_server:${id}`, `同步托管 MCP「${existing.name}」失败`, {
        outcome: "error",
        errorCode: "sync_failed",
      });
      return c.json({ ok: false, error: probe.error ?? "同步失败" });
    }
    const { snapshot, policy } = buildSnapshot(probe.tools ?? [], existing.toolsSnapshot, existing.toolPolicy, false);
    await saveSnapshot(db, id, snapshot, policy, null);
    await recordAdminAudit(c, db, claims, "mcp.sync", `mcp_server:${id}`, `同步托管 MCP「${existing.name}」成功（${snapshot.length} 个工具）`);
    return c.json({
      ok: true,
      toolCount: snapshot.length,
      problemCount: snapshot.filter((tool) => tool.problem).length,
      newCount: snapshot.filter((tool) => tool.isNew).length,
    });
  });

  app.put("/admin/mcp/servers/:id/tool-policy", async (c) => {
    const claims = c.get("claims");
    const id = c.req.param("id");
    const existing = await getMcpServer(db, id);
    if (!existing) return err(c, 404, "服务不存在");
    const body = (await c.req.json().catch(() => null)) as { policy?: Record<string, unknown> } | null;
    if (!body || typeof body.policy !== "object" || body.policy === null) return err(c, 400, "请求体非法");
    const knownNames = new Set(existing.toolsSnapshot.map((tool) => tool.name));
    const policy: Record<string, McpToolPolicy> = {};
    for (const [name, value] of Object.entries(body.policy)) {
      if (!knownNames.has(name)) return err(c, 400, `工具「${name}」不在当前快照中，请先同步`);
      policy[name] = normalizeToolPolicy(value);
    }
    const patched = await putToolPolicy(db, id, policy, claims.sub);
    if (!patched) return err(c, 404, "服务不存在");
    await recordAdminAudit(c, db, claims, "mcp.set_tool_policy", `mcp_server:${id}`, `更新托管 MCP「${existing.name}」的工具策略（${Object.keys(policy).length} 项）`, {
      changed: { toolPolicy: { before: existing.toolPolicy, after: policy } },
    });
    return c.json({ server: toAdminView(patched) });
  });

  app.post("/admin/mcp/servers/:id/probe", async (c) => {
    const id = c.req.param("id");
    const existing = await getMcpServer(db, id);
    if (!existing) return err(c, 404, "服务不存在");
    const upstreamHeaders = openHeaderMap(existing.headersCiphertext, opts.secretKey);
    if (typeof upstreamHeaders === "string") return c.json({ ok: false, error: upstreamHeaders });
    const probe = await probeMcpServer({ url: existing.url, type: existing.type, headers: upstreamHeaders });
    return c.json({
      ok: probe.ok,
      ...(probe.ok ? { toolCount: probe.tools?.length ?? 0, latencyMs: probe.latencyMs } : { error: probe.error }),
    });
  });

  // ===== 用户面：relay 令牌 + 转发 =====

  app.post("/desktop/mcp/relay-token", async (c) => {
    const claims = c.get("claims");
    const ttl = opts.relayTokenTtlSeconds ?? MCP_RELAY_TOKEN_TTL_SECONDS;
    const token = await signMcpRelayToken(opts.jwtSecret, { sub: claims.sub, name: claims.name }, ttl);
    return c.json({ token, audience: "mcp-relay", expiresIn: ttl });
  });

  return app;
}

/**
 * relay 数据面（JSON-RPC / SSE / 会话关闭）——**独立工厂、挂公开段**。
 *
 * 为什么不能和上面共用一个挂载点：authed 组的 Bearer 中间件会把 relay 短期令牌当
 * access 令牌验（audience 不同）→ 一律 401（冒烟实测）。relay 自带 aud=mcp-relay 的
 * 短期令牌鉴权，挂公开段反而更安全——长期 access 令牌不进入转发链，不会被透传上游。
 * 与 updates/feedback 公开面同一挂载机制（identity/routes.ts 公开段，authed 之前）。
 */
export function createMcpRelayRoutes(db: IdentityDb, opts: McpRoutesOptions) {
  const app = new Hono<AppEnv>();

  app.post("/desktop/mcp-relay/:id", async (c) => {
    const relay = await authenticateRelay(c, opts);
    if (!relay) return relayDenied(c);
    const target = await getMcpServer(db, c.req.param("id"));
    if (!target) return err(c, 404, "托管服务不存在");
    if (!target.enabled) return err(c, 403, "该托管服务已停用");

    const body = (await c.req.json().catch(() => null)) as McpJsonRpcRequest | McpJsonRpcRequest[] | null;
    if (!body) return err(c, 400, "JSON-RPC 请求体非法");
    const denied = checkJsonRpc(target, body);
    if (denied) {
      await auditRelayToolCall(db, relay, target, { toolName: denied.toolName, reason: denied.reason, outcome: "denied" });
      return c.json(denied.response, denied.httpStatus);
    }

    const upstream = await forwardJsonRpc(target, c, body, opts);
    // tools/list 结果过滤 block/problem 工具（双保险：端侧注册期已过滤）。
    // ⚠ 必须**原地**改 result.tools：respond 闭包持有的是 forwardJsonRpc 解析出的
    // 同一个 json 对象引用，重新赋值 upstream.json 不会进入响应（冒烟实测踩过）。
    const isBatch = Array.isArray(body);
    const listResult = upstream.json?.result as { tools?: unknown } | undefined;
    if (!isBatch && body.method === "tools/list" && upstream.ok && listResult && Array.isArray(listResult.tools)) {
      listResult.tools = (listResult.tools as Array<Record<string, unknown>>).filter(
        (tool) => denyReasonForTool(target, tool?.name) === null,
      );
    }
    if (isBatch) {
      for (const request of body) {
        if (request.method === "tools/call") {
          await auditRelayToolCall(db, relay, target, describeCall(request, upstream.ok ? "ok" : "error"));
        }
      }
    } else if (body.method === "tools/call") {
      await auditRelayToolCall(db, relay, target, describeCall(body, upstream.ok ? "ok" : "error"));
    }
    return upstream.respond(c);
  });

  app.get("/desktop/mcp-relay/:id", async (c) => {
    const relay = await authenticateRelay(c, opts);
    if (!relay) return relayDenied(c);
    const target = await getMcpServer(db, c.req.param("id"));
    if (!target) return err(c, 404, "托管服务不存在");
    if (!target.enabled) return err(c, 403, "该托管服务已停用");
    return forwardRaw(target, c, opts, "GET");
  });

  app.delete("/desktop/mcp-relay/:id", async (c) => {
    const relay = await authenticateRelay(c, opts);
    if (!relay) return relayDenied(c);
    const target = await getMcpServer(db, c.req.param("id"));
    if (!target) return err(c, 404, "托管服务不存在");
    return forwardRaw(target, c, opts, "DELETE");
  });

  return app;
}

// ===== 内部实现 =====

interface McpJsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}

interface RelayIdentity {
  sub: string;
  name: string;
}

async function authenticateRelay(c: Ctx, opts: McpRoutesOptions): Promise<RelayIdentity | null> {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) return null;
  return verifyMcpRelayToken(opts.jwtSecret, token);
}

/** relay 鉴权失败统一 401（不暗示服务存在与否）。 */
function relayDenied(c: Ctx): Response {
  return c.json({ error: { code: "401", message: "relay 令牌缺失或已过期" } }, 401);
}

/** 逐请求检查（批量请求逐条判，任一命中 denied 即整批拒绝——写操作宁可多拒）。 */
function checkJsonRpc(
  target: McpServerRecord,
  body: McpJsonRpcRequest | McpJsonRpcRequest[],
): { toolName?: string; reason: string; response: Record<string, unknown>; httpStatus: 403 } | null {
  const requests = Array.isArray(body) ? body : [body];
  for (const request of requests) {
    if (request.method !== "tools/call") continue;
    const toolName = request.params?.name;
    const reason = denyReasonForTool(target, toolName);
    if (reason) {
      return {
        ...(typeof toolName === "string" ? { toolName } : {}),
        reason,
        response: { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32003, message: reason } },
        httpStatus: 403 as const,
      };
    }
  }
  return null;
}

/** 三档再判：problem 与 block 拒绝；ask/allow 由端侧审批闸负责，relay 不重复拦截。 */
function denyReasonForTool(target: McpServerRecord, toolName: unknown): string | null {
  if (typeof toolName !== "string" || !toolName) return "工具名缺失";
  const entry = target.toolsSnapshot.find((tool) => tool.name === toolName);
  if (entry?.problem) return `工具「${toolName}」参数结构不合格，已被停用`;
  const verdict = target.toolPolicy[toolName] ?? "ask";
  if (verdict === "block") return `工具「${toolName}」已被企业管理员禁用`;
  return null;
}

function describeCall(
  request: McpJsonRpcRequest,
  outcome: "ok" | "error",
): { toolName?: string; outcome: "ok" | "error" } {
  const toolName = typeof request.params?.name === "string" ? request.params.name : undefined;
  return { ...(toolName ? { toolName } : {}), outcome };
}

/** relay 工具调用审计：只记元数据（服务名/工具名/结果），不含参数与输出正文。 */
async function auditRelayToolCall(
  db: IdentityDb,
  relay: RelayIdentity,
  target: McpServerRecord,
  info: { toolName?: string; reason?: string; outcome: "ok" | "error" | "denied" },
): Promise<void> {
  const claims: TokenClaims = { sub: relay.sub, name: relay.name, role: "user" as Role, deptId: null };
  const actor = await resolveActorForClaims(db, claims);
  await insertAuditBatch(db, actor, [
    {
      eventId: `mcp-relay-${randomUUID()}`,
      ts: new Date().toISOString(),
      action: "tool_call",
      toolName: info.toolName ? `mcp__${target.name}__${info.toolName}` : `mcp__${target.name}__*`,
      target: `managed-mcp:${target.id}`,
      outcome: info.outcome,
      ...(info.reason ? { errorCode: "mcp_denied", summary: info.reason } : { summary: `托管 MCP「${target.name}」工具调用` }),
    },
  ]).catch((error: unknown) => {
    console.warn("[mcp] 记录 relay 审计失败（不影响转发）:", error);
  });
}

interface ForwardOutcome {
  ok: boolean;
  json?: Record<string, unknown>;
  respond: (c: Ctx) => Response;
}

/** JSON-RPC 转发：白名单头 + 注入共享凭据；错误原样转发。 */
async function forwardJsonRpc(
  target: McpServerRecord,
  c: Ctx,
  body: unknown,
  opts: McpRoutesOptions,
): Promise<ForwardOutcome> {
  const upstreamHeaders = buildUpstreamHeaders(target, c, opts);
  const accept = c.req.header("accept") ?? "application/json, text/event-stream";
  let response: Response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      headers: { ...upstreamHeaders, accept },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = `上游不可达：${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, respond: (ctx) => ctx.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, 502) };
  }
  const contentType = response.headers.get("content-type") ?? "";
  const sessionHeader = response.headers.get("mcp-session-id");
  if (contentType.includes("text/event-stream")) {
    // SSE：流式透传（长连接推流，body 直接交给响应）
    return {
      ok: response.ok,
      respond: () => {
        const headers = new Headers({ "content-type": contentType });
        if (sessionHeader) headers.set("mcp-session-id", sessionHeader);
        return new Response(response.body, { status: response.status, headers });
      },
    };
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return {
    ok: response.ok,
    ...(json ? { json } : {}),
    respond: () => {
      const headers = new Headers();
      if (sessionHeader) headers.set("mcp-session-id", sessionHeader);
      if (json) return new Response(JSON.stringify(json), { status: response.status, headers });
      return new Response(null, { status: response.status, headers });
    },
  };
}

/** GET/DELETE 原样转发（SSE 建流与会话关闭）。 */
async function forwardRaw(
  target: McpServerRecord,
  c: Ctx,
  opts: McpRoutesOptions,
  method: "GET" | "DELETE",
): Promise<Response> {
  const upstreamHeaders = buildUpstreamHeaders(target, c, opts);
  let response: Response;
  try {
    response = await fetch(target.url, { method, headers: upstreamHeaders });
  } catch (error) {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: `上游不可达：${error instanceof Error ? error.message : String(error)}` } },
      502,
    );
  }
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (FORWARD_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** 上游请求头：白名单透传 + 注入解密后的共享凭据（密文只在本进程内存解出）。 */
function buildUpstreamHeaders(target: McpServerRecord, c: Ctx, opts: McpRoutesOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value) headers[name] = value;
  }
  if (target.auth === "shared") {
    const opened = openHeaderMap(target.headersCiphertext, opts.secretKey);
    if (typeof opened !== "string") Object.assign(headers, opened);
    // 解密失败：不注入也不中止——让上游以 401/403 原样反馈，错误语义一致
  }
  return headers;
}

// ===== 校验与封存 =====

interface McpServerUpsertBody {
  name: string;
  displayName?: string;
  type: "http" | "sse";
  url: string;
  auth: "none" | "shared";
  headers?: Record<string, string>;
  enabled?: boolean;
}

function validateUpsertBody(body: McpServerUpsertBody): string | null {
  if (!body.name || !MCP_SERVER_NAME_PATTERN.test(body.name.trim())) {
    return "服务名不合法：小写字母开头，仅小写字母/数字/短横线，1–24 字符，不含下划线";
  }
  if (body.type !== "http" && body.type !== "sse") return "type 非法（http / sse）";
  const urlProblem = validateUrl(body.url);
  if (urlProblem) return urlProblem;
  if (body.auth !== "none" && body.auth !== "shared") return "auth 非法（none / shared）";
  return null;
}

function validateUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return "url 必填";
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "url 不是合法地址";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "url 仅支持 http/https";
  // 凭据只许放请求头（spec §4）：带查询参数容易把 token 写进 URL，被日志/引用泄露
  if (parsed.search) return "url 不允许携带查询参数（凭据请放在共享凭据请求头里）";
  return null;
}

function validateHeaderCount(headers: Record<string, string>): string | null {
  if (Object.keys(headers).length > MAX_CUSTOM_HEADERS) return `自定义请求头最多 ${MAX_CUSTOM_HEADERS} 个`;
  return null;
}

interface SealedHeaderMap {
  sealed: Record<string, string>;
  display: Array<{ name: string; last4: string }>;
}

/** 校验单个 header 名与值；返回错误文案（null = 通过）。 */
function validateHeaderEntry(rawName: string, value: unknown): string | null {
  const name = rawName.trim();
  const lowered = name.toLowerCase();
  if (!/^[a-z0-9-]+$/.test(lowered)) return `请求头「${rawName}」含非法字符`;
  if (RESERVED_HEADER_NAMES.has(lowered)) return `请求头「${name}」由服务端控制，不允许配置`;
  if (typeof value !== "string" || !value.trim()) return `请求头「${name}」的值不能为空`;
  if (value.length > HEADER_VALUE_MAX || /[\x00-\x1f\x7f]/.test(value)) {
    return `请求头「${name}」的值超长或含控制字符`;
  }
  return null;
}

/** 校验并封存 header（key 为 null 时明文降级，与 gateway secrets 先例一致）；last4 取自明文。 */
function sealHeaderMap(headers: Record<string, string>, key: Buffer | null): SealedHeaderMap | string {
  const countProblem = validateHeaderCount(headers);
  if (countProblem) return countProblem;
  const sealed: Record<string, string> = {};
  const display: Array<{ name: string; last4: string }> = [];
  for (const [rawName, value] of Object.entries(headers)) {
    const problem = validateHeaderEntry(rawName, value);
    if (problem) return problem;
    const name = rawName.trim();
    sealed[name] = key ? sealSecret(value, key) : value;
    display.push({ name, last4: value.slice(-4) });
  }
  return { sealed, display };
}

/** PATCH 掩码合并：值为 "********" 的名沿用旧密文与其既有 last4（绝不把掩码当真值写库）。 */
function mergeHeaderMapWithMask(
  incoming: Record<string, string>,
  existingSealed: Record<string, string>,
  existingDisplay: Array<{ name: string; last4: string }>,
  key: Buffer | null,
): SealedHeaderMap | string {
  const countProblem = validateHeaderCount(incoming);
  if (countProblem) return countProblem;
  const priorDisplay = new Map(existingDisplay.map((entry) => [entry.name, entry.last4]));
  const sealed: Record<string, string> = {};
  const display: Array<{ name: string; last4: string }> = [];
  for (const [rawName, value] of Object.entries(incoming)) {
    const problem = validateHeaderEntry(rawName, value === "********" ? "placeholder-not-empty" : value);
    if (problem) return problem;
    const name = rawName.trim();
    if (value === "********") {
      const prior = existingSealed[name];
      if (!prior) return `请求头「${name}」此前未配置过，不能按「不修改」处理`;
      sealed[name] = prior;
      display.push({ name, last4: priorDisplay.get(name) ?? "****" });
      continue;
    }
    if (typeof value !== "string" || !value.trim()) return `请求头「${name}」的值不能为空`;
    sealed[name] = key ? sealSecret(value, key) : value;
    display.push({ name, last4: value.slice(-4) });
  }
  return { sealed, display };
}

function openHeaderMap(sealed: Record<string, string>, key: Buffer | null): Record<string, string> | string {
  if (Object.keys(sealed).length === 0) return {};
  try {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(sealed)) {
      out[name] = openSecret(value, key);
    }
    return out;
  } catch (error) {
    return `共享凭据解密失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

function toAdminView(record: McpServerRecord): McpServerPublic {
  return {
    id: record.id,
    name: record.name,
    displayName: record.displayName,
    type: record.type,
    url: record.url,
    auth: record.auth,
    headerNames: record.headerNames,
    enabled: record.enabled,
    toolsSnapshot: record.toolsSnapshot,
    toolPolicy: record.toolPolicy,
    syncedAt: record.syncedAt,
    syncError: record.syncError,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    updatedAt: record.updatedAt,
  };
}

async function recordAdminAudit(
  c: Ctx,
  db: IdentityDb,
  claims: TokenClaims,
  op: string,
  target: string,
  summary: string,
  details?: Record<string, unknown>,
): Promise<void> {
  markAdminAudited(c);
  const actor = await resolveActorForClaims(db, claims);
  await recordAdminAction(db, actor, {
    op,
    target,
    summary,
    outcome: "ok",
    ...(details ? { details } : {}),
  }).catch((error: unknown) => {
    console.warn("[mcp] 记录管理审计失败（不影响操作）:", error);
  });
}
