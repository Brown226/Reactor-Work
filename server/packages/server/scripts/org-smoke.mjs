/**
 * 组织 + 权限点端到端冒烟（U-1 部门 CRUD + U-2 权限点扫描）。
 *   起 identity(独立端口 8803, authMode=local) → 部门建/改/移动/环检测/删除保护 →
 *   权限点扫描（幂等）/角色矩阵/越权。
 *
 * 前置：docker compose up -d pg；server 已 build。
 * 用法：node packages/server/scripts/org-smoke.mjs（仓库根执行）
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cleanupAdminAudit } from "./lib/audit-cleanup.mjs";
import { useSmokeDb } from "./lib/smoke-db.mjs";

try {
  // 必须给出**绝对路径**：裸 `loadEnvFile()` 取的是 cwd 的 .env，而 pnpm 跑 npm script 时
  // cwd 是 packages/server（那里没有 .env，.env 在 server 根）。写成裸调用会让脚本在
  // `pnpm --filter @reactor/server smoke:x` 下回落到 55432（compose 映射在 15432），
  // 表现成 ECONNREFUSED 或静默 SKIP —— 与同目录 admin/t34/audit 等脚本的口径保持一致。
  process.loadEnvFile?.(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* ignore */
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PORT = Number(process.env.REACTOR_ORG_SMOKE_PORT ?? 8803);
const BASE = `http://127.0.0.1:${PORT}`;

// 本次运行起点：收尾时按时间窗清理服务端自记的 admin_action 审计行（见 lib/audit-cleanup.mjs）
const STARTED_AT = new Date();

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail ?? ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}
const get = (p, t) => req("GET", p, undefined, t);
const post = (p, b, t) => req("POST", p, b, t);
const patch = (p, b, t) => req("PATCH", p, b, t);
const del = (p, t) => req("DELETE", p, undefined, t);
const login = (u, p) => post("/auth/login", { username: u, password: p });

/** 在部门树里按路径找节点 */
function findByPath(nodes, path) {
  for (const node of nodes) {
    if (node.path === path) return node;
    const hit = findByPath(node.children ?? [], path);
    if (hit) return hit;
  }
  return null;
}

async function main() {
  // ★ 必须最先执行：切到独立冒烟库（每次重建），真实库不受影响（见 lib/smoke-db.mjs 头注）
  await useSmokeDb();
  const child = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "identity-entry.js")], {
    cwd: ROOT,
    env: { ...process.env, REACTOR_IDENTITY_PORT: String(PORT), REACTOR_AUTH_MODE: "local" },
    stdio: "ignore",
  });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    const r = await login("admin", process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123").catch(() => null);
    if (r && r.status === 200) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  if (!ready) {
    console.error("✗ identity 未在 20s 内就绪（PG 起了吗？）");
    child.kill();
    process.exit(1);
  }

  const cleanup = [];
  try {
    console.log("== 组织 + 权限点冒烟 ==");
    const adminTok = (await login("admin", process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123")).json?.accessToken;
    const userTok = (await login("user", process.env.REACTOR_TEST_USER_PWD ?? "User@123")).json?.accessToken;
    check("admin/user 双登录", Boolean(adminTok) && Boolean(userTok));

    // ---- U-1 部门 CRUD ----
    console.log("· U-1 部门 CRUD");
    const root = await post("/depts", { parentId: null, name: "冒烟分公司" }, adminTok);
    check("建顶层部门 200", root.status === 200 && root.json?.dept?.path === "冒烟分公司" && root.json?.dept?.depth === 1, JSON.stringify(root.json));
    const rootId = root.json?.dept?.id;
    cleanup.push(rootId);

    const child = await post("/depts", { parentId: rootId, name: "冒烟部门A" }, adminTok);
    check(
      "建子部门 path/depth 正确",
      child.status === 200 && child.json?.dept?.path === "冒烟分公司/冒烟部门A" && child.json?.dept?.depth === 2,
      JSON.stringify(child.json),
    );
    const childId = child.json?.dept?.id;
    cleanup.push(childId);

    const dup = await post("/depts", { parentId: rootId, name: "冒烟部门A" }, adminTok);
    check("同级重名 400", dup.status === 400, JSON.stringify(dup.json));
    const badName = await post("/depts", { parentId: null, name: "   " }, adminTok);
    check("空名称 400", badName.status === 400);

    const renamed = await patch(`/depts/${childId}`, { name: "冒烟部门B" }, adminTok);
    check("改名后 path 更新", renamed.status === 200 && renamed.json?.dept?.path === "冒烟分公司/冒烟部门B", JSON.stringify(renamed.json));

    // 三级：A 下再建 B，验证移动时整棵子树路径重写
    const grand = await post("/depts", { parentId: childId, name: "冒烟小组" }, adminTok);
    const grandId = grand.json?.dept?.id;
    cleanup.push(grandId);
    const moved = await patch(`/depts/${childId}`, { parentId: null }, adminTok);
    check(
      "移到顶层：子树 path 一并重写",
      moved.status === 200 && moved.json?.dept?.path === "冒烟部门B" && moved.json?.dept?.depth === 1,
      JSON.stringify(moved.json),
    );
    const tree1 = await get("/depts/tree", adminTok);
    check(
      "子树后代路径同步（冒烟部门B/冒烟小组）",
      Boolean(findByPath(tree1.json?.tree ?? [], "冒烟部门B/冒烟小组")),
      JSON.stringify(tree1.json?.tree?.map((n) => n.path)),
    );

    const cycle = await patch(`/depts/${childId}`, { parentId: grandId }, adminTok);
    check("移动到自身下级被拒 400", cycle.status === 400, JSON.stringify(cycle.json));
    const toSelf = await patch(`/depts/${childId}`, { parentId: childId }, adminTok);
    check("移动到自身被拒 400", toSelf.status === 400);

    const delWithChild = await del(`/depts/${childId}`, adminTok);
    check("有下级时删除被拒 400", delWithChild.status === 400, JSON.stringify(delWithChild.json));

    const member = await post(
      "/users",
      { uid: "dept-member", name: "部门成员", password: "Member@123", role: "user", departmentId: grandId },
      adminTok,
    );
    check("前置：建部门成员 201", member.status === 201, JSON.stringify(member.json));
    const memberId = member.json?.user?.id;
    const delWithUser = await del(`/depts/${grandId}`, adminTok);
    check("有成员时删除被拒 400", delWithUser.status === 400, JSON.stringify(delWithUser.json));

    if (memberId) await del(`/users/${memberId}`, adminTok).catch(() => undefined);
    // 该用户需先停用/删除：/users 没有 DELETE，用 disable 后 move 出部门
    if (memberId) await patch(`/users/${memberId}`, { departmentId: null, status: "disabled" }, adminTok);
    check("清理成员后可删除部门", (await del(`/depts/${grandId}`, adminTok)).status === 200);
    check("删除子部门", (await del(`/depts/${childId}`, adminTok)).status === 200);
    check("删除顶层部门", (await del(`/depts/${rootId}`, adminTok)).status === 200);

    const forbidden = await post("/depts", { parentId: null, name: "越权部门" }, userTok);
    check("普通用户建部门 403", forbidden.status === 403);

    // ---- U-2 权限点 ----
    console.log("· U-2 权限点扫描");
    const scan1 = await post("/admin/permissions/scan", {}, adminTok);
    const total = scan1.json?.result?.total ?? 0;
    check("扫描出权限点", scan1.status === 200 && total > 20, `total=${total}`);
    const codes = (scan1.json?.permissions ?? []).map((p) => p.code);
    check("含身份/用户/组织/管理台权限码", ["auth:logout:create", "users:read", "depts:create", "admin:skills:read"].every((code) => codes.includes(code)), codes.slice(0, 12).join(","));
    check("公开路由不纳入（/auth/login）", !codes.some((code) => code.startsWith("auth:login")));

    const scan2 = await post("/admin/permissions/scan", {}, adminTok);
    check("重复扫描幂等（added=0 removed=0）", scan2.json?.result?.added === 0 && scan2.json?.result?.removed === 0, JSON.stringify(scan2.json?.result));

    const roles = scan2.json?.roles ?? [];
    const adminRole = roles.find((r) => r.key === "platform_admin");
    const userRole = roles.find((r) => r.key === "user");
    check("平台管理员拥有全部权限点", (adminRole?.permissions ?? []).length === codes.length);
    check("普通用户权限显著更少", (userRole?.permissions ?? []).length > 0 && (userRole?.permissions ?? []).length < codes.length, `user=${(userRole?.permissions ?? []).length}/${codes.length}`);
    check("普通用户不含组织写权限", !(userRole?.permissions ?? []).includes("depts:create"));

    const forbiddenScan = await post("/admin/permissions/scan", {}, userTok);
    check("普通用户扫描 403", forbiddenScan.status === 403);
  } finally {
    child.kill();
    // 负向用例（user 角色打 /admin/permissions/scan → 403）会留痕，收尾清掉，避免污染真实审计表
    await cleanupAdminAudit({ since: STARTED_AT });
  }

  console.log(failed === 0 ? "\nORG SMOKE PASS" : `\nORG SMOKE FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
