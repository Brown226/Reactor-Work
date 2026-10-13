/**
 * 界面模式权限（编程模式受众）端到端冒烟。
 *
 *   起 identity(独立端口, authMode=local) → 默认关闭（仅 admin 有 coding）→
 *   off/all/role/dept/user 五档受众逐档验证 `/desktop/policy` 的 allowedInterfaceModes →
 *   管理员恒全档 → 校验（空角色/空部门/空账号/非法 kind/不存在部门 400）→ 越权 403。
 *
 * 前置：docker compose up -d pg；server 已 build。
 * 用法：node packages/server/scripts/interface-mode-smoke.mjs（仓库根执行）
 *
 * 背景见 docs/未完成-编程模式权限-方案-v1.md。
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { useSmokeDb } from "./lib/smoke-db.mjs";

try {
  // 必须给绝对路径：pnpm 跑 npm script 时 cwd 是 packages/server（那里没有 .env，.env 在 server 根）。
  process.loadEnvFile?.(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* ignore */
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PORT = Number(process.env.REACTOR_INTERFACE_MODE_SMOKE_PORT ?? 8807);
const BASE = `http://127.0.0.1:${PORT}`;

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
const put = (p, b, t) => req("PUT", p, b, t);
const login = (u, p) => req("POST", "/auth/login", { username: u, password: p });

/** 取某 token 对应 viewer 的可用界面模式（= /desktop/policy 的 allowedInterfaceModes）。 */
async function modesFor(token) {
  const r = await get("/desktop/policy", token);
  return r.json?.policy?.allowedInterfaceModes ?? [];
}
const hasCoding = async (token) => (await modesFor(token)).includes("coding");

async function main() {
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

  try {
    console.log("== 界面模式权限冒烟 ==");
    const adminTok = (await login("admin", process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123")).json?.accessToken;
    const headTok = (await login("head", process.env.REACTOR_TEST_HEAD_PWD ?? "Head@123")).json?.accessToken;
    const userTok = (await login("user", process.env.REACTOR_TEST_USER_PWD ?? "User@123")).json?.accessToken;
    check("admin/head/user 三登录", Boolean(adminTok) && Boolean(headTok) && Boolean(userTok));

    // head 有部门（seed 里 headDeptPath），user/admin 无部门 —— 用于 dept 档。
    const users = await get("/users", adminTok);
    const headDeptId = (users.json?.users ?? []).find((u) => u.uid === "head")?.dept?.id ?? null;
    check("前置：head 有部门 id（供 dept 档验证）", Number.isInteger(headDeptId), headDeptId);

    // ===== 1. 默认关闭（白名单）：未配置受众时仅 admin 有 coding =====
    console.log("== 默认关闭 ==");
    const defaultAdmin = await modesFor(adminTok);
    check("默认：admin 恒全三档", JSON.stringify(defaultAdmin) === JSON.stringify(["office", "coding", "review"]), JSON.stringify(defaultAdmin));
    check("默认：user 无 coding", !(await hasCoding(userTok)));
    check("默认：head 无 coding", !(await hasCoding(headTok)));
    check("默认：user 仍含 office/review", JSON.stringify(await modesFor(userTok)) === JSON.stringify(["office", "review"]));

    // ===== 2. off 显式关闭 =====
    console.log("== off（显式不开放）==");
    check("PUT off 200", (await put("/admin/interface-mode-policy", { kind: "off" }, adminTok)).status === 200);
    check("off：user 无 coding", !(await hasCoding(userTok)));
    check("off：admin 仍全档", (await hasCoding(adminTok)));

    // ===== 3. all 全公司 =====
    console.log("== all（全公司）==");
    check("PUT all 200", (await put("/admin/interface-mode-policy", { kind: "all" }, adminTok)).status === 200);
    check("all：user 有 coding", await hasCoding(userTok));
    check("all：head 有 coding", await hasCoding(headTok));
    check("all：三档齐全", JSON.stringify(await modesFor(userTok)) === JSON.stringify(["office", "coding", "review"]));

    // ===== 4. role：仅 user 角色 =====
    console.log("== role（按角色）==");
    check("PUT role 200", (await put("/admin/interface-mode-policy", { kind: "role", roles: ["user"] }, adminTok)).status === 200);
    check("role=user：user 有 coding", await hasCoding(userTok));
    check("role=user：head（dept_head）无 coding", !(await hasCoding(headTok)));
    check("role=user：admin 恒全档", await hasCoding(adminTok));

    // ===== 5. dept：head 的部门 =====
    console.log("== dept（按部门，精确匹配）==");
    check("PUT dept 200", (await put("/admin/interface-mode-policy", { kind: "dept", deptIds: [headDeptId] }, adminTok)).status === 200);
    check("dept=head部门：head 有 coding", await hasCoding(headTok));
    check("dept=head部门：user（无部门）无 coding", !(await hasCoding(userTok)));

    // ===== 6. user：仅指定账号 =====
    console.log("== user（按账号）==");
    check("PUT user 200", (await put("/admin/interface-mode-policy", { kind: "user", uids: ["user"] }, adminTok)).status === 200);
    check("uids=[user]：user 有 coding", await hasCoding(userTok));
    check("uids=[user]：head 无 coding", !(await hasCoding(headTok)));

    // ===== 7. 回读管理面配置 =====
    const readBack = await get("/admin/interface-mode-policy", adminTok);
    check("管理面回读 kind=user", readBack.json?.policy?.kind === "user");
    check("管理面回读 uids=[user]", JSON.stringify(readBack.json?.policy?.uids) === '["user"]');

    // ===== 8. 校验 =====
    console.log("== 校验 ==");
    check("非法 kind 400", (await put("/admin/interface-mode-policy", { kind: "nope" }, adminTok)).status === 400);
    check("空角色 400", (await put("/admin/interface-mode-policy", { kind: "role", roles: [] }, adminTok)).status === 400);
    check("空部门 400", (await put("/admin/interface-mode-policy", { kind: "dept", deptIds: [] }, adminTok)).status === 400);
    check("空账号 400", (await put("/admin/interface-mode-policy", { kind: "user", uids: [] }, adminTok)).status === 400);
    check("不存在部门 400", (await put("/admin/interface-mode-policy", { kind: "dept", deptIds: [999999] }, adminTok)).status === 400);

    // ===== 9. 越权 =====
    console.log("== 越权 ==");
    check("普通用户 PUT 403", (await put("/admin/interface-mode-policy", { kind: "all" }, userTok)).status === 403);
    check("部门负责人 GET 403", (await get("/admin/interface-mode-policy", headTok)).status === 403);

    // 收尾：恢复默认（off），避免留下的配置影响后续（冒烟库每次重建，这步只是保持幂等语义清晰）
    await put("/admin/interface-mode-policy", { kind: "off" }, adminTok);
  } finally {
    child.kill();
  }

  console.log(failed === 0 ? "\nINTERFACE-MODE SMOKE PASS" : `\nINTERFACE-MODE SMOKE FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
