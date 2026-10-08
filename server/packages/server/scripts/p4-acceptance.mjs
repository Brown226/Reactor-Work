/**
 * P4 真机验收（服务端链路半边）—— 对运行中的 Docker 身份服务直发 HTTP，逐步断言并打印实测输出。
 * 对应 docs/未完成-服务端接线-P4-用量上报与策略.md §16 的 A/B/C 清单中**服务端可验证的部分**；
 * 桌面/CLI 进程内行为（A1/A3/A5、B7–B9、C10–C11 运行时、D12–D13）不在本脚本范围，见验收记录。
 *
 * 安全性：只用测试账号 admin；只写带会话标记（P4_ACC_MARKER）的审计事件，结束时打印 DELETE 清理命令；
 * 策略先读原值、结束必还原（finally 保证）。**不读写任何凭据文件**。
 *
 * 用法：pnpm --filter @reactor/server acceptance:p4   （需 docker compose up -d 且 identity 在 :8791）
 */

const BASE = process.env["REACTOR_IDENTITY_URL"] ?? "http://127.0.0.1:8791";
const GATEWAY = process.env["REACTOR_GATEWAY_URL"] ?? "http://127.0.0.1:8790";
const USER = process.env["REACTOR_TEST_ADMIN_USER"] ?? "admin";
const PWD = process.env["REACTOR_TEST_ADMIN_PWD"] ?? "Admin@123";
const MARKER = `p4-acc-${Date.now()}`;

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}
function note(line) {
  console.log(`  ℹ ${line}`);
}

async function req(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（如 CSV）保留在 text */
  }
  return { status: res.status, json, text };
}

/** 与端侧 buildBehaviorAuditEvent / buildModelCallAuditEvent 同形的 4 类事件（洞②上行形状）。 */
function buildEvents(ts) {
  return [
    {
      eventId: `${MARKER}-1`,
      ts,
      sessionId: MARKER,
      action: "model_call",
      outcome: "ok",
      durationMs: 2345,
      summary: "glm-4.6",
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        totalTokens: 1500,
        model: "glm-4.6",
        provider: "reactor",
      },
    },
    {
      eventId: `${MARKER}-2`,
      ts,
      sessionId: MARKER,
      action: "tool_call",
      outcome: "ok",
      toolName: "Edit",
      target: `${MARKER}-call-1`,
      durationMs: 812,
      summary: "Edit",
    },
    {
      eventId: `${MARKER}-3`,
      ts,
      sessionId: MARKER,
      action: "approval",
      outcome: "ok",
      approvalDecision: "allow",
      toolName: "Bash",
      target: `${MARKER}-call-2`,
      summary: "Bash",
    },
    {
      eventId: `${MARKER}-4`,
      ts,
      sessionId: MARKER,
      action: "policy_block",
      outcome: "denied",
      errorCode: "policy.commandBlacklist",
      toolName: "Bash",
      target: `${MARKER}-call-3`,
      summary: "policy.commandBlacklist",
    },
  ];
}

async function main() {
  console.log(`· P4 真机验收（服务端半边）  base=${BASE}  marker=${MARKER}`);

  /* ── 1. 登录（A 清单前提） ─────────────────────────────── */
  console.log("· 登录与令牌链路");
  const badLogin = await req("/auth/login", { method: "POST", body: { username: USER, password: "wrong" } });
  check("错误密码 → 401/400 拒绝", badLogin.status === 401 || badLogin.status === 400, badLogin.status);
  const login = await req("/auth/login", { method: "POST", body: { username: USER, password: PWD } });
  check(`登录成功（${USER}）`, login.status === 200, { status: login.status, body: login.json });
  const access = login.json?.accessToken;
  const refresh = login.json?.refreshToken;
  check("access + refresh 令牌返回", Boolean(access && refresh));
  check("登录用户为 platform_admin", login.json?.user?.role === "platform_admin", login.json?.user);
  if (!access) throw new Error("无法登录，中止");

  const gt = await req("/auth/gateway-token", { method: "POST", token: access });
  check("换发网关令牌（aud=gateway）", gt.status === 200 && Boolean(gt.json?.token), gt);
  const models = await fetch(`${GATEWAY}/v1/models`, {
    headers: { authorization: `Bearer ${gt.json?.token ?? ""}` },
  });
  const modelsBody = await models.json().catch(() => null);
  check(
    "网关 /v1/models 持网关令牌可访问",
    models.status === 200 && Array.isArray(modelsBody?.data),
    { status: models.status, body: modelsBody },
  );

  /* ── 2. 四类事件上报（A2 服务端半边 + 洞②形状实测） ────── */
  console.log("· 审计上报四型事件（model_call / tool_call / approval / policy_block）");
  const events = buildEvents(new Date().toISOString());
  const batch1 = await req("/desktop/audit/batch", { method: "POST", token: access, body: { events } });
  check(
    "首批上报 accepted=4 / duplicates=0 / rejected 空",
    batch1.status === 200 &&
      batch1.json?.accepted === 4 &&
      batch1.json?.duplicates === 0 &&
      (batch1.json?.rejected?.length ?? 0) === 0,
    batch1.json,
  );

  const forged = await req("/desktop/audit/batch", {
    method: "POST",
    token: access,
    body: { events: [events[0]], uid: "other-user" },
  });
  check("请求体带 uid → 400（归属不可伪造）", forged.status === 400, forged);

  const anon = await req("/desktop/audit/batch", { method: "POST", body: { events: [events[0]] } });
  check("无令牌上报 → 401", anon.status === 401, anon.status);

  /* ── 3. 回读与筛选（A2 服务端半边） ────────────────────── */
  console.log("· 回读 /desktop/audit");
  const readAll = await req(
    `/desktop/audit?sessionId=${MARKER}&from=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3600e3).toISOString())}&limit=50`,
    { token: access },
  );
  check("按 sessionId 回读 total=4", readAll.json?.total === 4, readAll.json);
  const rows = readAll.json?.events ?? [];
  const pick = (action) => rows.find((r) => (r.action ?? r[0]?.action) === action);
  const field = (row, camel, snake) => row?.[camel] ?? row?.[snake];

  const mc = pick("model_call");
  check("model_call 记录 uid 由服务端补", Boolean(mc) && field(mc, "uid", "uid") === USER, mc);
  check(
    "model_call usage 分项入库（usage.totalTokens=1500）",
    Number(mc?.usage?.totalTokens ?? mc?.usage?.total_tokens ?? NaN) === 1500,
    mc?.usage,
  );
  const tc = pick("tool_call");
  check("tool_call 记录 toolName/target 入库", field(tc, "toolName", "tool_name") === "Edit" && Boolean(field(tc, "target", "target")), tc);
  const ap = pick("approval");
  check("approval 记录 approvalDecision=allow", field(ap, "approvalDecision", "approval_decision") === "allow", ap);
  const pb = pick("policy_block");
  check(
    "policy_block 记录 errorCode=policy.commandBlacklist",
    field(pb, "errorCode", "error_code") === "policy.commandBlacklist",
    pb,
  );
  check(
    "红线：记录不含正文类键（prompt/content）",
    rows.every((r) => !("prompt" in r) && !("content" in r)),
  );

  for (const action of ["model_call", "tool_call", "approval", "policy_block"]) {
    const filtered = await req(`/desktop/audit?sessionId=${MARKER}&action=${action}&limit=10`, { token: access });
    check(`action=${action} 筛选 → total=1`, filtered.json?.total === 1, filtered.json);
  }

  /* ── 4. 幂等重放（A3 服务端半边） ──────────────────────── */
  console.log("· 幂等重放");
  const batch2 = await req("/desktop/audit/batch", { method: "POST", token: access, body: { events } });
  check(
    "同 eventId 重放 → accepted=0 / duplicates=4",
    batch2.status === 200 && batch2.json?.accepted === 0 && batch2.json?.duplicates === 4,
    batch2.json,
  );
  const recount = await req(`/desktop/audit?sessionId=${MARKER}&limit=50`, { token: access });
  check("重放后总数仍为 4（不重复入库）", recount.json?.total === 4, recount.json?.total);

  /* ── 5. 用量聚合（A1 服务端半边） ──────────────────────── */
  console.log("· 用量聚合");
  const summary = await req("/desktop/usage/summary?groupBy=model", { token: access });
  check(
    "GET /desktop/usage/summary 返回 totals 且含本批 1500 token",
    summary.status === 200 && Number(summary.json?.totals?.totalTokens ?? 0) >= 1500,
    summary.json,
  );
  const stats = await req(`/desktop/audit?sessionId=${MARKER}&stats=1&limit=1`, { token: access });
  check("stats=1 返回报表统计对象", Boolean(stats.json?.stats), stats.json?.stats);

  /* ── 6. 策略下发（B6/C10/C11 服务端半边） ──────────────── */
  console.log("· 组织策略下发");
  const before = await req("/desktop/policy", { token: access });
  const original = before.json?.policy;
  check("GET /desktop/policy 返回当前策略", Boolean(original), before.json);
  try {
    const put = await req("/desktop/policy", {
      method: "PUT",
      token: access,
      body: {
        defaultApprovalMode: "edit",
        commandBlacklist: ["rm -rf"],
        egressAllowlist: ["example.com"],
        quota: original?.quota ?? { monthlyTokenLimit: null, alertThresholds: [80, 100] },
      },
    });
    check("管理员 PUT 策略 → 200 且回显", put.status === 200 && put.json?.policy?.defaultApprovalMode === "edit", put.json);
    const after = await req("/desktop/policy", { token: access });
    check(
      "回读一致：defaultApprovalMode=edit / 黑名单 [rm -rf] / 白名单 [example.com]",
      after.json?.policy?.defaultApprovalMode === "edit" &&
        JSON.stringify(after.json?.policy?.commandBlacklist) === JSON.stringify(["rm -rf"]) &&
        JSON.stringify(after.json?.policy?.egressAllowlist) === JSON.stringify(["example.com"]),
      after.json?.policy,
    );

    const empty = await req("/desktop/policy", {
      method: "PUT",
      token: access,
      body: {
        defaultApprovalMode: "edit",
        commandBlacklist: [],
        egressAllowlist: [],
        quota: original?.quota ?? { monthlyTokenLimit: null, alertThresholds: [80, 100] },
      },
    });
    check("空黑名单可写（B9 服务端半边：存空数组）", empty.status === 200 && JSON.stringify(empty.json?.policy?.commandBlacklist) === "[]", empty.json);
  } finally {
    // 还原原策略（去只读字段）
    if (original) {
      const { updatedAt: _u, updatedBy: _b, ...writable } = original;
      const restore = await req("/desktop/policy", { method: "PUT", token: access, body: writable });
      note(`策略已还原（PUT ${restore.status}）`);
    }
  }

  /* ── 7. 登出与令牌吊销（A4 服务端半边） ────────────────── */
  console.log("· 登出与令牌吊销");
  const logout = await req("/auth/logout", { method: "POST", token: access });
  check("POST /auth/logout → ok", logout.status === 200 && logout.json?.ok === true, logout);
  const refreshAfter = await req("/auth/refresh", { method: "POST", body: { refreshToken: refresh } });
  check("登出后 refresh → 401（refresh 已吊销）", refreshAfter.status === 401, refreshAfter);
  note("access 为无状态 JWT（登出不吊销、到 exp 失效）——「不发上报」的关口在客户端不发起请求（A4 客户端半边，本脚本无法验证）");

  console.log(`\n${failed === 0 ? "服务端半边验收全部通过 ✓" : `${failed} 项失败 ✗`}（通过 ${passed}）`);
  console.log(`清理命令（审计测试事件 ${MARKER}）：`);
  console.log(
    `docker exec reactor-desktop-pg psql -U reactor -d reactor -c "DELETE FROM audit_event WHERE session_id='${MARKER}';"`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("验收脚本异常:", err);
  process.exit(1);
});
