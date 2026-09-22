/**
 * 第 1 批 · 身份底座端到端冒烟：
 *   起 identity(dist, 独立端口 8799) → 三角色登录(admin 本地/head/user) →
 *   LDAP 域账号登录(luct/123456, 校验中文名与部门) → 错密码 401 →
 *   /me 数据范围 → /users 角色隔离 → /depts/tree → sync(807) → refresh。
 *
 * 前置：docker compose up -d（reactor-ldap + reactor-pg）；.env 已配。
 * 用法：node packages/server/scripts/identity-smoke.mjs（仓库根执行）
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
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
const PORT = Number(process.env.REACTOR_SMOKE_PORT ?? 8799);
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

async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

async function get(path, token) {
  const res = await fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function login(username, password) {
  const r = await post("/auth/login", { username, password });
  return r;
}

async function main() {
  // ★ 必须最先执行：切到独立冒烟库（每次重建），真实库不受影响（见 lib/smoke-db.mjs 头注）
  await useSmokeDb();
  const child = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "identity-entry.js")], {
    cwd: ROOT,
    env: { ...process.env, REACTOR_IDENTITY_PORT: String(PORT), REACTOR_AUTH_MODE: "mixed" },
    stdio: "ignore",
  });
  // 等就绪：轮询 admin 登录
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
    console.error("✗ identity 未在 20s 内就绪");
    child.kill();
    process.exit(1);
  }
  console.log("== 冒烟开始 ==");

  const adminPwd = process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123";
  const headPwd = process.env.REACTOR_TEST_HEAD_PWD ?? "Head@123";
  const userPwd = process.env.REACTOR_TEST_USER_PWD ?? "User@123";

  // 1) admin 本地号登录 + 角色
  const adminLogin = await login("admin", adminPwd);
  check("admin 本地登录 200 且 platform_admin", adminLogin.status === 200 && adminLogin.json?.user?.role === "platform_admin");
  const adminTok = adminLogin.json?.accessToken;

  // 2) 错密码 401
  const bad = await login("luct", "wrong-password");
  check("错密码 401", bad.status === 401);

  // 2.5) 前置：LDAP 全量同步 —— 冒烟库每次重建都是**干净库**，域账号与组织树必须先同步进来，
  //  否则下面 luct 登录 / 部门树断言全红（原先它依赖真实库"恰好同步过"，在干净克隆上本来就会红）。
  const seedSync = await post("/auth/sync", {}, adminTok);
  check(
    "前置：LDAP 全量同步进冒烟库",
    seedSync.status === 200 && (seedSync.json?.result?.total ?? 0) > 0,
    seedSync.status === 200 ? `total=${seedSync.json?.result?.total}` : JSON.stringify(seedSync.json)?.slice(0, 160),
  );

  // 3) LDAP 域账号登录（真实中文名 + 部门自动供给）
  const luct = await login("luct", "123456");
  const lu = luct.json?.user;
  check(
    "luct(LDAP) 登录成功/姓名/部门",
    luct.status === 200 && lu?.name === "卢春田" && lu?.role === "user" && lu?.source === "ad" && lu?.dept?.path === "河北分公司/分公司领导",
  );

  // 4) head：数据范围=设计管理部子树
  const headLogin = await login("head", headPwd);
  check("head 登录 200 且 dept_head", headLogin.status === 200 && headLogin.json?.user?.role === "dept_head");
  const headTok = headLogin.json?.accessToken;
  const headUsers = await get("/users", headTok);
  const headDeptOk =
    headUsers.status === 200 &&
    headUsers.json?.total >= 1 &&
    headUsers.json.users.every((u) => !u.dept || u.dept.path.startsWith("河北分公司/设计管理部"));
  check("head 仅见本部门及以下用户", headDeptOk);
  const headTree = await get("/depts/tree", headTok);
  check("head 部门树=仅设计管理部", headTree.status === 200 && headTree.json?.tree?.[0]?.name === "设计管理部");

  // 5) user：只见本人 / 无组织权限
  const userLogin = await login("user", userPwd);
  const userTok = userLogin.json?.accessToken;
  const userUsers = await get("/users", userTok);
  check("user 仅见本人", userUsers.status === 200 && userUsers.json?.total === 1 && userUsers.json?.users?.[0]?.uid === "user");
  const userTree = await get("/depts/tree", userTok);
  check("user 访问部门树 403", userTree.status === 403);

  // 6) admin 全量组织树
  const tree = await get("/depts/tree", adminTok);
  const root = tree.json?.tree?.[0];
  check("admin 部门树=河北分公司(19 子部门)", tree.status === 200 && root?.name === "河北分公司" && root?.children?.length === 19);

  // 7) 再次全量同步（幂等：重跑结果应与前置同步一致）
  const sync = await post("/auth/sync", {}, adminTok);
  check("sync 重跑 total=807（幂等）", sync.status === 200 && sync.json?.result?.total === 807);

  // 8) refresh 续签
  const refresh = await post("/auth/refresh", { refreshToken: userLogin.json?.refreshToken });
  check("refresh 出新的 access", refresh.status === 200 && Boolean(refresh.json?.accessToken));

  child.kill();
  console.log(failed === 0 ? "\nIDENTITY SMOKE PASS" : `\nIDENTITY SMOKE FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
