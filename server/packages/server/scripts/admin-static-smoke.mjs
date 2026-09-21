/**
 * 管理台 SPA 静态托管冒烟（部署项）：服务端在 /console 下托管 packages/admin/dist。
 *
 * 覆盖：
 *  1) /console/ → 200 text/html（index.html）
 *  2) /console/<前端路由> → 200 text/html（SPA history 回退）
 *  3) /console/assets/<真实产物> → 200 且 content-type 正确
 *  4) /console/assets/<不存在>.js → 404（**不**回退成 HTML，避免把缺资源伪装成页面）
 *  5) 路径穿越尝试不泄露仓库文件（.env 等）
 *  6) API 与前端路由不冲突：/admin/models 仍是 JSON（曾把 SPA 挂在 /admin 造成冲突）
 *
 * 前置：docker compose up -d pg；已 build server 与 admin（无 admin/dist 时自动 SKIP）。
 * 用法：node packages/server/scripts/admin-static-smoke.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { useSmokeDb } from "./lib/smoke-db.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 靠外部环境 */
}

const PORT = Number(process.env.REACTOR_ADMIN_STATIC_PORT ?? 8808);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_DIST = join(ROOT, "packages", "admin", "dist");
const ADMIN_PWD = process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123";

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail ?? ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
const cleanup = () => {
  try {
    child?.kill();
  } catch {
    /* ignore */
  }
};

async function main() {
  if (!existsSync(join(ADMIN_DIST, "index.html"))) {
    console.log(`SKIP: 管理台产物不存在（${ADMIN_DIST}）—— 先跑 pnpm --filter @reactor/admin build`);
    process.exit(0);
  }

  // ★ 必须最先执行：切到独立冒烟库（每次重建），真实库不受影响（见 lib/smoke-db.mjs 头注）
  await useSmokeDb();
  child = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "identity-entry.js")], {
    cwd: ROOT,
    env: { ...process.env, REACTOR_IDENTITY_PORT: String(PORT), REACTOR_AUTH_MODE: "local" },
    stdio: "ignore",
  });

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    try {
      ready = (await fetch(`${BASE}/console/`)).ok;
    } catch {
      /* retry */
    }
    if (!ready) await sleep(500);
  }
  if (!ready) {
    console.error("✗ identity 未就绪（PG 起了吗？）");
    cleanup();
    process.exit(1);
  }
  console.log("== 管理台静态托管冒烟 ==");

  const asset = readdirSync(join(ADMIN_DIST, "assets")).find((f) => f.endsWith(".js"));

  // 1) 入口
  const root = await fetch(`${BASE}/console/`);
  const rootType = root.headers.get("content-type") ?? "";
  const rootBody = await root.text();
  check("1 /console/ 返回 index.html", root.status === 200 && rootType.includes("text/html") && rootBody.includes("<div id=\"root\">"), `${root.status} ${rootType}`);

  // 2) SPA 回退（前端路由）
  const spa = await fetch(`${BASE}/console/models`);
  check(
    "2 /console/<前端路由> 回退到 index.html",
    spa.status === 200 && (spa.headers.get("content-type") ?? "").includes("text/html"),
    `status=${spa.status}`,
  );

  // 3) 真实资源
  const js = await fetch(`${BASE}/console/assets/${asset}`);
  const jsType = js.headers.get("content-type") ?? "";
  check("3 /console/assets/*.js 提供真实产物", js.status === 200 && jsType.includes("javascript"), `${js.status} ${jsType}`);

  // 4) 缺失资源 → 404（不回退 HTML）
  const missing = await fetch(`${BASE}/console/assets/does-not-exist.js`);
  check(
    "4 缺失资源返回 404（不被 SPA 回退伪装）",
    missing.status === 404,
    `status=${missing.status} type=${missing.headers.get("content-type")}`,
  );

  // 5) 路径穿越
  const traversals = ["/console/../.env", "/console/%2e%2e%2f.env", "/console/..%2f..%2f.env", "/console/assets/../../../../.env"];
  let leaked = false;
  const detail = [];
  for (const p of traversals) {
    const res = await fetch(`${BASE}${p}`, { redirect: "manual" });
    const text = res.status === 200 ? await res.text() : "";
    if (/REACTOR_JWT_SECRET|REACTOR_UPSTREAM_API_KEY/.test(text)) leaked = true;
    detail.push(`${p}→${res.status}`);
  }
  check("5 路径穿越不泄露仓库文件", !leaked, detail.join(" "));

  // 6) 与 API 不冲突
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: ADMIN_PWD }),
  });
  const token = login.ok ? (await login.json()).accessToken : null;
  const api = await fetch(`${BASE}/admin/models`, { headers: { authorization: `Bearer ${token}` } });
  const apiType = api.headers.get("content-type") ?? "";
  check(
    "6 /admin/models 仍是 JSON（未被 SPA 吃掉）",
    api.status === 200 && apiType.includes("application/json"),
    `status=${api.status} type=${apiType}`,
  );

  cleanup();
  console.log(failed === 0 ? "\nADMIN STATIC SMOKE PASS" : `\nADMIN STATIC SMOKE FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
