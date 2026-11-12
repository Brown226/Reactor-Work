/**
 * 端口分离冒烟（管理台 / 用户面隔离）。
 *
 * 直接对**运行中的** identity 发请求，断言：
 *   用户面（REACTOR_IDENTITY_PORT，默认 8791）：/、/console/、/admin/roles 全部 404；
 *   管理面（REACTOR_IDENTITY_ADMIN_PORT，默认 8792）：/ 302 → /console/、/console/ 200。
 *
 * 用法（先在 server/ 下把 identity 跑起来）：
 *   node packages/server/scripts/port-separation-smoke.mjs
 *   REACTOR_IDENTITY_URL=http://127.0.0.1:8791 \
 *   REACTOR_IDENTITY_ADMIN_URL=http://127.0.0.1:8792 \
 *     node packages/server/scripts/port-separation-smoke.mjs
 *
 * 退出码：0 全绿 / 1 有失败。
 */

const USER_BASE = process.env["REACTOR_IDENTITY_URL"] ?? "http://127.0.0.1:8791";
const ADMIN_BASE = process.env["REACTOR_IDENTITY_ADMIN_URL"] ?? "http://127.0.0.1:8792";

const results = [];

/** 发请求但**不自动跟随重定向**，这样才能断言 302 本身。 */
async function probe(base, path, init = {}) {
  const url = `${base}${path}`;
  try {
    const res = await fetch(url, { redirect: "manual", ...init });
    return { status: res.status, location: res.headers.get("location"), ok: true };
  } catch (e) {
    return { status: null, error: e instanceof Error ? e.message : String(e), ok: false };
  }
}

function expect(name, actual, want, extra = "") {
  const pass = actual === want;
  results.push({ name, pass, detail: `期望 ${want}，实际 ${actual}${extra ? `（${extra}）` : ""}` });
  console.log(`${pass ? "✅" : "❌"} ${name} → ${actual}${pass ? "" : `  ${extra}`}`);
}

async function main() {
  console.log(`用户面: ${USER_BASE}`);
  console.log(`管理面: ${ADMIN_BASE}\n`);

  // ---- 用户面：管理入口必须全 404 ----
  console.log("[用户面] 管理入口应被挡住");
  const uRoot = await probe(USER_BASE, "/");
  if (!uRoot.ok) {
    console.log(`❌ 用户面连不上：${uRoot.error}`);
    console.log("\n请先启动 identity（server/ 下 pnpm --filter @reactor/server dev:identity）");
    process.exit(1);
  }
  expect("用户面 GET /           → 404（不再 302 到管理台）", uRoot.status, 404);
  expect("用户面 GET / 无跳转头", uRoot.location, null, `location=${uRoot.location}`);

  const uConsole = await probe(USER_BASE, "/console/");
  expect("用户面 GET /console/    → 404", uConsole.status, 404);

  const uAdmin = await probe(USER_BASE, "/admin/roles");
  expect("用户面 GET /admin/roles → 404（无令牌也应 404 而非 401）", uAdmin.status, 404);

  const uAdminModels = await probe(USER_BASE, "/admin/models");
  expect("用户面 GET /admin/models→ 404", uAdminModels.status, 404);

  // ---- 用户面：业务面不能被误伤 ----
  console.log("\n[用户面] 业务面应正常（未登录 → 401，不是 404）");
  const uMe = await probe(USER_BASE, "/me");
  expect("用户面 GET /me          → 401（鉴权生效，未被 404 误伤）", uMe.status, 401);

  const uPolicy = await probe(USER_BASE, "/desktop/policy");
  expect("用户面 GET /desktop/policy → 401", uPolicy.status, 401);

  const uKb = await probe(USER_BASE, "/v1/kb/health");
  expect("用户面 GET /v1/kb/health   → 401", uKb.status, 401);

  // 登录接口必须还在（不存在账号也应是 4xx 业务错误，而不是 404 路由缺失）
  const uLogin = await probe(USER_BASE, "/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "__smoke_no_such_user__", password: "x" }),
  });
  expect("用户面 POST /auth/login → 非 404（路由存在）", uLogin.status !== 404, true, `实际 ${uLogin.status}`);

  // ---- 管理面：管理台必须能进 ----
  console.log("\n[管理面] 管理台应可访问");
  const aRoot = await probe(ADMIN_BASE, "/");
  if (!aRoot.ok) {
    console.log(`❌ 管理面连不上：${aRoot.error}`);
    console.log("  若 REACTOR_IDENTITY_ADMIN_PORT 与 REACTOR_IDENTITY_PORT 相同，则不启用分离（单端口旧行为）。");
    process.exit(1);
  }
  expect("管理面 GET /            → 302", aRoot.status, 302);
  expect("管理面 GET / 跳 /console/", aRoot.location, "/console/", `location=${aRoot.location}`);

  const aConsole = await probe(ADMIN_BASE, "/console/");
  expect("管理面 GET /console/    → 200", aConsole.status, 200);

  const aAdminNoAuth = await probe(ADMIN_BASE, "/admin/roles");
  expect("管理面 GET /admin/roles → 401（路由存在，仅缺令牌）", aAdminNoAuth.status, 401);

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length > 0) {
    console.log("失败项：");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("端口分离冒烟全绿。");
}

main().catch((e) => {
  console.error("冒烟脚本异常:", e);
  process.exit(1);
});
