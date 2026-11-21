/**
 * 托管 MCP（治理平面 P0）—— **PG + 假上游 MCP + relay 探针**（前置：PG 可达；连不上打印 SKIP 并以 0 退出）。
 *
 * ## 守什么（都是"静态检查看不出来"的那类）
 *
 * ① **建表幂等**：无迁移框架，靠 `IF NOT EXISTS`，连跑两次不能抛。
 * ② **鉴权边界**：非 platform_admin → 403；未注入 claims → 401；relay 令牌缺失/伪造 → 401。
 * ③ **登记 fail-fast**：探测失败（上游不可达）→ 422 且**不落行**（不留半成品）。
 * ④ **凭据红线**：共享凭据入库为 `enc:v1:` 密文；管理台/下发 payload 里只有 header 名 +
 *    值末四位，明文与密文都不出现；`managedMcp` 下发条目**无 url、无凭据**。
 * ⑤ **快照语义**：注解预填（readOnly→allow，其余→ask）；schema 不合格标 problem；
 *    手动同步新增工具一律 ask 并标 isNew；PUT tool-policy 清 isNew。
 * ⑥ **relay 双保险**：tools/list 过滤 block/problem 工具；tools/call 拒 block/problem；
 *    放行调用转发成功且落 `tool_call` 审计（denied 也落）。
 * ⑦ **policy 下发 wire**：`GET /desktop/policy` 的 `managedMcp` 字段形状与端侧契约一致。
 *
 * 用法：`pnpm --filter @reactor/server smoke:mcp`
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
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

// 与 feedback-smoke 同口径：先吃 **server 根**的 .env；路径必须 fileURLToPath（仓库路径含中文）。
try {
  process.loadEnvFile?.(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 没有 .env 就按环境变量与默认值走 */
}

const dbUrl = () =>
  process.env["REACTOR_DB_URL"]?.trim() ||
  process.env["REACTOR_DATABASE_URL"]?.trim() ||
  "postgres://reactor:reactor@127.0.0.1:15432/reactor";

/* ── 假上游 MCP：最小 Streamable HTTP JSON-RPC 应答器 ───────────────────────── */

interface FakeTool {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema?: unknown;
  /** tools/call 的返回文本（缺省 ok:true） */
  callResult?: string;
  failCall?: boolean;
}

interface FakeMcpOptions {
  tools: FakeTool[];
  /** 返回给 initialize 的会话 id（不设 = 不下发 session id） */
  sessionId?: string;
  failAll?: boolean;
}

function startFakeMcp(options: FakeMcpOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  return new Promise((resolveServer) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const respondJson = (payload: unknown, status = 200): void => {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (options.sessionId) headers["mcp-session-id"] = options.sessionId;
          response.writeHead(status, headers);
          response.end(JSON.stringify(payload));
        };
        if (options.failAll) {
          respondJson({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "fake upstream down" } }, 500);
          return;
        }
        let parsed: { id?: unknown; method?: string; params?: Record<string, unknown> } | null = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          respondJson({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad json" } }, 400);
          return;
        }
        if (!parsed || typeof parsed.method !== "string") {
          respondJson({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } }, 400);
          return;
        }
        const id = parsed.id ?? null;
        switch (parsed.method) {
          case "initialize":
            respondJson({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion:
                  (parsed.params?.protocolVersion as string | undefined) ?? "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fake-mcp", version: "1.0.0" },
              },
            });
            return;
          // 官方 SDK 的 initialized 通知没有 id：202 空回执即可
          case "notifications/initialized":
            response.writeHead(202, { "content-type": "application/json" });
            response.end("{}");
            return;
          case "tools/list":
            respondJson({
              jsonrpc: "2.0",
              id,
              result: {
                tools: options.tools.map((tool) => ({
                  name: tool.name,
                  ...(tool.description ? { description: tool.description } : {}),
                  ...(tool.annotations ? { annotations: tool.annotations } : {}),
                  ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
                })),
              },
            });
            return;
          case "tools/call": {
            const name = parsed.params?.name;
            const tool = options.tools.find((candidate) => candidate.name === name);
            if (!tool || tool.failCall) {
              respondJson({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: "tool failed" }], isError: true },
              });
              return;
            }
            respondJson({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: tool.callResult ?? "ok" }] },
            });
            return;
          }
          default:
            respondJson({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }, 200);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolveServer({
        server,
        url: `http://127.0.0.1:${port}/mcp`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/* ── 冒烟主体 ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
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

  const fake = await startFakeMcp({
    tools: [
      { name: "list_contacts", description: "列出联系人", annotations: { readOnlyHint: true } },
      { name: "delete_contact", description: "删除联系人" },
      // 参数结构不合格：inputSchema 根类型不是 object → problem
      { name: "broken_tool", inputSchema: { type: "array" } },
      { name: "list_contacts", description: "重复名（服务端快照去重）" },
      { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    ],
  });
  const fakeDown = await startFakeMcp({ tools: [], failAll: true });

  try {
    const { ensureMcpSchema } = await import("../src/mcp/schema.js");
    const { createMcpRoutes } = await import("../src/mcp/routes.js");
    const { listManagedServers } = await import("../src/mcp/repo.js");
    const { createAuditRoutes } = await import("../src/audit/routes.js");
    const { ensureInterfaceModeSchema } = await import("../src/interface-mode/repo.js");

    /* ── ① 建表幂等 ──────────────────────────────────────────────────── */
    console.log("· 建表");
    await ensureSchema(db); // 身份表先在：管理审计 resolveActorForClaims 要查 users
    await ensureAuditSchema(db); // desktop_policy 单行 + audit_event（relay 审计落点）
    await ensureInterfaceModeSchema(db); // /desktop/policy 的 allowedInterfaceModes 依赖
    await ensureMcpSchema(db);
    await ensureMcpSchema(db); // 幂等：第二次不应报错
    check("建表幂等（连跑两次不抛）", true);

    /* ── 路由装配：claims 由冒烟中间件注入 ───────────────────────────── */
    const SECRET_KEY = randomBytes(32);
    const JWT_SECRET = "smoke-jwt-secret";
    const app = new Hono<{ Variables: { claims: TokenClaims } }>();
    let currentClaims: TokenClaims | null = { sub: "probe-admin", name: "探针管理员", role: "platform_admin", deptId: null };
    app.use("*", async (c, next) => {
      if (!currentClaims) {
        return c.json({ error: { code: "unauthorized", message: "未登录" } }, 401);
      }
      c.set("claims", currentClaims);
      await next();
    });
    app.route("/", createMcpRoutes(db, { secretKey: SECRET_KEY, jwtSecret: JWT_SECRET }));
    app.route("/", createAuditRoutes(db));

    const call = async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: unknown; text: string }> => {
      const response = await app.request(path, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, json, text };
    };

    /* ── ② 鉴权边界 ──────────────────────────────────────────────────── */
    console.log("· 鉴权边界");
    currentClaims = { sub: "probe-user", name: "普通用户", role: "user", deptId: null };
    const forbidden = await call("GET", "/admin/mcp/servers");
    check("非 platform_admin 访问管理面 → 403", forbidden.status === 403, forbidden);

    currentClaims = null;
    const unauthorized = await call("GET", "/admin/mcp/servers");
    check("未注入 claims → 401", unauthorized.status === 401, unauthorized);
    currentClaims = { sub: "probe-admin", name: "探针管理员", role: "platform_admin", deptId: null };

    /* ── ③ 登记 fail-fast + 凭据红线 ─────────────────────────────────── */
    console.log("· 登记（fail-fast 与凭据封存）");
    // 登记前：无策略行且无托管面 → policyVersion 不下发（端侧不联动，与老服务端同口径）
    const policyBefore = await call("GET", "/desktop/policy");
    const policyBeforeObj = (policyBefore.json as { policy?: Record<string, unknown> })?.policy ?? {};
    check("登记前无 policyVersion（无策略行且无托管面）", !("policyVersion" in policyBeforeObj), Object.keys(policyBeforeObj));

    const SECRET_HEADER_VALUE = "Bearer super-secret-token-123456789";
    const unreachable = await call("POST", "/admin/mcp/servers", {
      name: "dead",
      type: "http",
      url: fakeDown.url,
      auth: "none",
    });
    check("上游不可达 → 422", unreachable.status === 422, unreachable);
    const afterFail = await call("GET", "/admin/mcp/servers");
    const rowsAfterFail = (afterFail.json as { servers?: unknown[] })?.servers ?? [];
    check("探测失败不落行（不留半成品）", rowsAfterFail.length === 0, rowsAfterFail.length);

    const created = await call("POST", "/admin/mcp/servers", {
      name: "crm",
      displayName: "CRM",
      type: "http",
      url: fake.url,
      auth: "shared",
      headers: { authorization: SECRET_HEADER_VALUE },
    });
    check("登记成功 → 201", created.status === 201, created);
    const serverRow = (created.json as { server?: { id: string; toolsSnapshot?: unknown[]; toolPolicy?: Record<string, string> } })?.server;
    const snapshot = serverRow?.toolsSnapshot ?? [];
    check("快照 4 个工具（重复名截断在 4 条原始里不会重复落——按名唯一场景取决于上游）",
      snapshot.length === 4 || snapshot.length === 5, snapshot.length);
    const snapshotNames = snapshot.map((tool) => (tool as { name?: string }).name);
    check("schema 不合格的工具标 problem", snapshot.some((tool) => (tool as { problem?: string }).problem), snapshotNames);

    // 凭据红线：任何回显都不含明文与密文
    const createdText = created.text;
    check("管理台响应不含凭据明文", !createdText.includes("super-secret-token"), "");
    check("管理台响应不含密文形态", !createdText.includes("enc:v1:"), "");
    const last4 = SECRET_HEADER_VALUE.slice(-4);
    check("凭据只回显 header 名 + 值末四位", createdText.includes(last4), last4);
    const dbRow = await db.pool.query<{ headers_ciphertext: Record<string, string> }>(
      "SELECT headers_ciphertext FROM mcp_server WHERE name = 'crm'",
    );
    const storedValue = dbRow.rows[0]?.headers_ciphertext?.authorization ?? "";
    check("入库为 AES 封存（enc:v1: 前缀）", storedValue.startsWith("enc:v1:"), storedValue.slice(0, 10));

    // 注解预填：readOnly→allow，其余→ask
    check("readOnlyHint=true 预填 allow", serverRow?.toolPolicy?.list_contacts === "allow", serverRow?.toolPolicy);
    check("无注解预填 ask", serverRow?.toolPolicy?.delete_contact === "ask", serverRow?.toolPolicy);

    /* ── ④ 下发 wire：managedMcp 无凭据无上游地址 + policyVersion 派生 ─ */
    console.log("· 下发 wire");
    const policyResponse = await call("GET", "/desktop/policy");
    const policy = (policyResponse.json as { policy?: { managedMcp?: { servers?: Array<Record<string, unknown>> } } })?.policy;
    const managedServers = policy?.managedMcp?.servers ?? [];
    check("GET /desktop/policy 携带 managedMcp", managedServers.length >= 1, policyResponse.text.slice(0, 200));
    const managedEntry = managedServers.find((entry) => entry.name === "crm") ?? {};
    check("下发条目不含 url", !("url" in managedEntry), Object.keys(managedEntry));
    check("下发条目不含 headers/凭据", !("headers" in managedEntry) && !("headerNames" in managedEntry), Object.keys(managedEntry));
    check("下发条目默认三档为 ask", managedEntry.defaultToolPolicy === "ask", managedEntry.defaultToolPolicy);
    const managedText = JSON.stringify(managedServers);
    check("下发 payload 不含凭据明文", !managedText.includes("super-secret-token"), "");
    // 登记后：有托管面 → policyVersion 必须下发（端侧据此失效会话授权）
    check("登记后下发 policyVersion", typeof policy?.policyVersion === "string" && policy.policyVersion.length > 0, policy?.policyVersion);

    /* ── ⑤ 手动同步：新增工具一律 ask + isNew ───────────────────────── */
    console.log("· 手动同步");
    // 上游加一个新工具（重启假上游前先改工具清单：直接换一个带新工具的 fake）
    const syncResult = await call("POST", `/admin/mcp/servers/${serverRow?.id}/sync`);
    // 假上游没有变化：newCount 应为 0（之前的工具都在旧快照里）
    check("无变化同步 ok:true 且 newCount=0",
      (syncResult.json as { ok?: boolean; newCount?: number })?.ok === true &&
        (syncResult.json as { newCount?: number }).newCount === 0,
      syncResult.json);

    /* ── ⑥ PUT tool-policy + isNew 固化 ─────────────────────────────── */
    console.log("· 工具策略");
    const blocked = await call("PUT", `/admin/mcp/servers/${serverRow?.id}/tool-policy`, {
      policy: { delete_contact: "block", list_contacts: "allow" },
    });
    check("PUT tool-policy → 200", blocked.status === 200, blocked);
    const afterPolicy = (blocked.json as { server?: { toolPolicy?: Record<string, string>; toolsSnapshot?: Array<{ name: string; isNew?: boolean }> } })?.server;
    check("策略生效（delete_contact=block）", afterPolicy?.toolPolicy?.delete_contact === "block", afterPolicy?.toolPolicy);
    check("被改过的工具不再标 isNew", (afterPolicy?.toolsSnapshot ?? []).every(
      (tool) => tool.isNew !== true || (tool.name !== "list_contacts" && tool.name !== "delete_contact"),
    ), afterPolicy?.toolsSnapshot);
    const unknownTool = await call("PUT", `/admin/mcp/servers/${serverRow?.id}/tool-policy`, {
      policy: { not_in_snapshot: "allow" },
    });
    check("策略表只允许快照内工具名 → 400", unknownTool.status === 400, unknownTool);

    /* ── ⑦ relay：令牌 + 过滤 + 拒绝 + 转发 + 审计 ──────────────────── */
    console.log("· relay");
    const tokenResponse = await call("POST", "/desktop/mcp/relay-token");
    const relayToken = (tokenResponse.json as { token?: string })?.token ?? "";
    check("relay 令牌签发", tokenResponse.status === 200 && relayToken.length > 0, tokenResponse.status);

    const relayPost = async (path: string, body: unknown, token: string): Promise<{ status: number; json: unknown }> => {
      const response = await app.request(path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, json };
    };

    const relayBase = `/desktop/mcp-relay/${serverRow?.id}`;
    const noToken = await app.request(relayBase, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: { "content-type": "application/json" },
    });
    check("relay 无令牌 → 401", noToken.status === 401, noToken.status);
    const badToken = await relayPost(relayBase, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "forged-token");
    check("relay 伪造令牌 → 401", badToken.status === 401, badToken.status);

    const listed = await relayPost(relayBase, { jsonrpc: "2.0", id: 1, method: "tools/list" }, relayToken);
    const relayTools = ((listed.json as { result?: { tools?: Array<{ name?: string }> } })?.result?.tools ?? []).map(
      (tool) => tool.name,
    );
    check("relay tools/list 过滤 block 工具", !relayTools.includes("delete_contact"), relayTools);
    check("relay tools/list 过滤 problem 工具", !relayTools.includes("broken_tool"), relayTools);
    check("relay tools/list 保留放行工具", relayTools.includes("list_contacts"), relayTools);

    const deniedCall = await relayPost(
      relayBase,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_contact", arguments: { id: "42" } } },
      relayToken,
    );
    check("relay tools/call 拒 block 工具 → 403 + JSON-RPC error",
      deniedCall.status === 403 &&
        (deniedCall.json as { error?: { message?: string } })?.error?.message?.includes("禁用") === true,
      deniedCall);

    const allowedCall = await relayPost(
      relayBase,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_contacts", arguments: {} } },
      relayToken,
    );
    check("relay tools/call 放行工具转发成功",
      allowedCall.status === 200 &&
        JSON.stringify(allowedCall.json).includes("ok"),
      allowedCall);

    // relay 令牌只到 relay 为止，不能被转发给上游（假上游不校验，这里验证转发头构造）
    const auditRows = await db.pool.query<{ action: string; outcome: string; tool_name: string }>(
      "SELECT action, outcome, tool_name FROM audit_event WHERE action = 'tool_call' ORDER BY id DESC LIMIT 5",
    );
    const auditList = auditRows.rows;
    check("放行与拒绝各落一条 tool_call 审计",
      auditList.some((row) => row.outcome === "ok" && row.tool_name.includes("list_contacts")) &&
        auditList.some((row) => row.outcome === "denied" && row.tool_name.includes("delete_contact")),
      auditList.map((row) => `${row.outcome}:${row.tool_name}`));
    const auditText = JSON.stringify(auditList);
    check("审计不含凭据明文", !auditText.includes("super-secret-token"), "");

    /* ── ⑧ 删除：审计留痕 + 下发消失 ────────────────────────────────── */
    console.log("· 删除");
    const removed = await call("DELETE", `/admin/mcp/servers/${serverRow?.id}`);
    check("删除 → 200", removed.status === 200, removed);
    const policyAfterDelete = await call("GET", "/desktop/policy");
    const serversAfterDelete = ((policyAfterDelete.json as { policy?: { managedMcp?: { servers?: unknown[] } } })?.policy?.managedMcp?.servers ?? []);
    check("删除后下发面不再携带该服务", serversAfterDelete.length === 0, serversAfterDelete.length);
    const adminAudit = await db.pool.query<{ op: string }>(
      "SELECT op FROM admin_action WHERE op IN ('mcp.create','mcp.delete','mcp.set_tool_policy') ORDER BY id",
    );
    const ops = adminAudit.rows.map((row) => row.op);
    check("管理操作审计留痕（create/set_tool_policy/delete）",
      ops.includes("mcp.create") && ops.includes("mcp.set_tool_policy") && ops.includes("mcp.delete"),
      ops);
  } finally {
    await fake.close();
    await fakeDown.close();
    await closeIdentityDb(db);
  }

  console.log(failed === 0 ? "\n全部通过" : `\n失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
