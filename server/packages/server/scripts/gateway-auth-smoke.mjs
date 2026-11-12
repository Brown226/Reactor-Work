/**
 * B2 网关鉴权冒烟：身份令牌（aud=gateway）优先 + dev token 兼容开关。
 *
 * 覆盖：
 *   1) dev token → 200，x-reactor-auth=dev（兼容 M0）
 *   2) 身份 access 令牌**直连网关 → 401**（audience 隔离，防跨面重放）
 *   3) refresh 令牌 → 401
 *   4) POST /auth/gateway-token 换取网关令牌（返回主体）
 *   5) 网关令牌 → 200，x-reactor-auth=user + x-reactor-subject=admin（归属到人）
 *   6) 篡改签名 / 垃圾值 / 空令牌 → 401
 *   7) 过期网关令牌 → 401（TTL=1s 的身份实例换取后等待）
 *   8) REACTOR_GATEWAY_ALLOW_DEV_TOKEN=false 的网关：dev → 401，身份令牌 → 200
 *   9) /v1/models 与 /v1/chat/completions 同一套规则
 *  10) /health 暴露鉴权方式
 *
 * 前置：docker compose up -d pg；server 已 build；根 .env 含 REACTOR_JWT_SECRET。
 * 用法：node packages/server/scripts/gateway-auth-smoke.mjs
 *
 * 说明：网关子进程用**临时工作目录**启动，避免读到根 .env（否则会接上真实管理台数据域、
 * 把请求打到真实上游）；所有上游调用都打到本脚本内的 mock，不消耗模型额度。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAdminAudit } from "./lib/audit-cleanup.mjs";
import { useSmokeDb } from "./lib/smoke-db.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 靠外部环境 */
}

const JWT_SECRET = process.env.REACTOR_JWT_SECRET ?? "reactor-dev-jwt-secret-change-me";
const ADMIN_PWD = process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123";
const DEV_TOKEN = `auth-smoke-dev-${Math.random().toString(36).slice(2, 10)}`;
const ID_PORT = Number(process.env.REACTOR_AUTH_IDENTITY_PORT ?? 8806);
const ID_SHORT_PORT = ID_PORT + 1;
const GW_PORT = Number(process.env.REACTOR_AUTH_GATEWAY_PORT ?? 18910);

// 本次运行起点：收尾时按时间窗清理服务端自记的 admin_action 审计行（见 lib/audit-cleanup.mjs）
// 本脚本实测不产生审计行（它不碰 /admin/*），接上清理属防御性冗余：
// 以后若有人在此脚本里加深身份管理接口的用例，就不会重新开始污染真实审计表。
const STARTED_AT = new Date();

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail ?? ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** mock 上游：任何请求都 200，避免打到真实模型 */
function makeMock() {
  const state = { hits: [] };
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      state.hits.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/models")) {
        res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", context_length: 8192 }] }));
      } else {
        res.end(JSON.stringify({ id: "mock", type: "message", content: [{ type: "text", text: "ok" }] }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ state, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() })),
  );
}

const children = [];
const tmpDirs = [];

function spawnGateway(port, allowDevToken, cwd) {
  const child = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "index.js")], {
    cwd,
    env: {
      PATH: process.env.PATH,
      REACTOR_GATEWAY_HOST: "127.0.0.1",
      REACTOR_GATEWAY_PORT: String(port),
      REACTOR_DEV_TOKEN: DEV_TOKEN,
      REACTOR_JWT_SECRET: JWT_SECRET,
      REACTOR_GATEWAY_ALLOW_DEV_TOKEN: allowDevToken ? "true" : "false",
      REACTOR_UPSTREAM_BASE_URL: mockUrl,
      REACTOR_UPSTREAM_API_KEY: "sk-mock",
    },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

let mockUrl = "";

async function waitOk(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  return false;
}

const gwCall = async (port, path, token, body) => {
  const headers = { "content-type": "application/json" };
  if (token !== undefined) headers["x-api-key"] = token;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: path === "/v1/models" ? "GET" : "POST",
    headers,
    ...(path === "/v1/models" ? {} : { body: JSON.stringify(body ?? { model: "mock-model", messages: [] }) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, auth: res.headers.get("x-reactor-auth"), subject: res.headers.get("x-reactor-subject"), json, text };
};

async function main() {
  // ★ 必须最先执行：切到独立冒烟库（每次重建），真实库不受影响（见 lib/smoke-db.mjs 头注）
  await useSmokeDb();
  const mock = await makeMock();
  mockUrl = mock.url;

  // 身份服务：常规 TTL + 短 TTL（过期用例）
  const idEnv = (port, ttl) => ({
    ...process.env,
    REACTOR_IDENTITY_PORT: String(port),
    REACTOR_AUTH_MODE: "local",
    ...(ttl ? { REACTOR_GATEWAY_TOKEN_TTL_SECONDS: String(ttl) } : {}),
  });
  const identity = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "identity-entry.js")], {
    cwd: ROOT,
    env: idEnv(ID_PORT),
    stdio: "ignore",
  });
  children.push(identity);

  const login = async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: ADMIN_PWD }),
    });
    return res.ok ? res.json() : null;
  };

  // ★ 必须先等主实例就绪，**再**拉短 TTL 实例。
  // 冒烟库每次重建都是干净库 → identity 首启要做全量建表+种子；两个实例**并发**引导同一张
  // 空库时，`CREATE TABLE IF NOT EXISTS` 看不见对方未提交的表，后者撞 `pg_class` 唯一索引
  // （duplicate key on pg_class_relname_nsp_index）直接崩掉 —— 短实例从此不在，第 7 步静默假红。
  // 连真实库时建表全是空操作，所以这个雷在库隔离之前从未炸过（2026-09-19 定位）。
  let mainReady = null;
  for (let i = 0; i < 40 && !mainReady; i++) {
    mainReady = await login(ID_PORT).catch(() => null);
    if (!mainReady) await sleep(500);
  }

  const identityShort = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "identity-entry.js")], {
    cwd: ROOT,
    env: idEnv(ID_SHORT_PORT, 1),
    stdio: "ignore",
  });
  children.push(identityShort);

  // 网关用临时目录启动（不读根 .env，避免接上真实数据域）
  const gwCwd = mkdtempSync(join(tmpdir(), "gw-auth-"));
  tmpDirs.push(gwCwd);
  spawnGateway(GW_PORT, true, gwCwd);
  spawnGateway(GW_PORT + 1, false, gwCwd);

  const gwReady = await waitOk(`http://127.0.0.1:${GW_PORT}/health`);
  const gwReady2 = await waitOk(`http://127.0.0.1:${GW_PORT + 1}/health`);
  if (!mainReady || !gwReady || !gwReady2) {
    console.error(`✗ 就绪检查失败 identity=${Boolean(mainReady)} gw=${gwReady} gwStrict=${gwReady2}`);
    for (const c of children) {
      try {
        c.kill();
      } catch {
        /* ignore */
      }
    }
    process.exit(1);
  }
  console.log("== B2 网关鉴权冒烟 ==");

  const session = await login(ID_PORT);
  const access = session.accessToken;
  const refresh = session.refreshToken;

  // 1) dev token 兼容
  const devRes = await gwCall(GW_PORT, "/v1/messages", DEV_TOKEN);
  check("1 dev token 仍可用（兼容 M0）", devRes.status === 200 && devRes.auth === "dev", `status=${devRes.status} auth=${devRes.auth}`);

  // 2/3) audience 隔离
  const accessRes = await gwCall(GW_PORT, "/v1/messages", access);
  check("2 身份 access 令牌直连网关被拒（audience 隔离）", accessRes.status === 401, `status=${accessRes.status}`);
  const refreshRes = await gwCall(GW_PORT, "/v1/messages", refresh);
  check("3 refresh 令牌被拒", refreshRes.status === 401, `status=${refreshRes.status}`);

  // 4) 换取网关令牌
  const ex = await fetch(`http://127.0.0.1:${ID_PORT}/auth/gateway-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}` },
  });
  const exJson = ex.ok ? await ex.json() : null;
  check(
    "4 access 换取网关令牌（aud=gateway，含主体）",
    ex.status === 200 && exJson?.audience === "gateway" && exJson?.subject?.sub === "admin" && exJson?.subject?.role === "platform_admin",
    `${ex.status} ${JSON.stringify(exJson)?.slice(0, 160)}`,
  );
  const gwToken = exJson?.token;

  // 5) 网关令牌可用且归属到人
  const gwRes = await gwCall(GW_PORT, "/v1/messages", gwToken);
  check(
    "5 网关令牌可用且标记调用者（auth=user / subject=admin）",
    gwRes.status === 200 && gwRes.auth === "user" && gwRes.subject === "admin",
    `status=${gwRes.status} auth=${gwRes.auth} subject=${gwRes.subject}`,
  );

  // 6) 篡改 / 垃圾 / 空
  const tampered = `${gwToken.slice(0, -2)}${gwToken.slice(-2) === "aa" ? "bb" : "aa"}`;
  const tamperRes = await gwCall(GW_PORT, "/v1/messages", tampered);
  check("6a 篡改签名的令牌被拒", tamperRes.status === 401, `status=${tamperRes.status}`);
  const junkRes = await gwCall(GW_PORT, "/v1/messages", "not-a-token");
  check("6b 垃圾令牌被拒", junkRes.status === 401, `status=${junkRes.status}`);
  const noneRes = await gwCall(GW_PORT, "/v1/messages", undefined);
  check("6c 无令牌被拒", noneRes.status === 401, `status=${noneRes.status}`);

  // 7) 过期令牌（短 TTL 实例换取后等待）
  // ⚠ 短 TTL 实例与主实例**同时**拉起，但这里过去从未等过它的就绪 —— 一直靠"启动够快"隐式成立。
  //   冒烟库化后 identity 首启要做全量建表+种子，两个实例并发引导还会争 DDL 锁，
  //   走到这一步短实例可能尚未监听 → login 静默失败 → 断言无细节假红。必须显式轮询就绪。
  let shortSession = null;
  for (let i = 0; i < 40 && !shortSession; i++) {
    shortSession = await login(ID_SHORT_PORT).catch(() => null);
    if (!shortSession) await sleep(500);
  }
  let expiredOk = false;
  /** 诊断信息：这条断言曾是"静默假红"重灾区（login 失败/换 token 失败/先通失败/后拒失败，四种原因一种输出） */
  let expiredDetail = "shortSession=null";
  if (shortSession) {
    const ex2 = await fetch(`http://127.0.0.1:${ID_SHORT_PORT}/auth/gateway-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${shortSession.accessToken}` },
    });
    const ex2Json = ex2.ok ? await ex2.json() : null;
    const shortTok = ex2Json?.token ?? null;
    expiredDetail = `ex2=${ex2.status} tok=${shortTok ? "yes" : "no"}`;
    if (shortTok) {
      const fresh = await gwCall(GW_PORT, "/v1/messages", shortTok);
      await sleep(2200);
      const stale = await gwCall(GW_PORT, "/v1/messages", shortTok);
      expiredOk = fresh.status === 200 && stale.status === 401;
      expiredDetail = `fresh=${fresh.status} stale=${stale.status}`;
    }
  }
  check("7 过期网关令牌被拒（1s TTL 实例：先通后拒）", expiredOk, expiredDetail);

  // 8) 严格模式：dev 被拒、身份令牌放行
  const strictDev = await gwCall(GW_PORT + 1, "/v1/messages", DEV_TOKEN);
  const strictJwt = await gwCall(GW_PORT + 1, "/v1/messages", gwToken);
  check(
    "8 ALLOW_DEV_TOKEN=false：dev 被拒、身份令牌仍可用",
    strictDev.status === 401 && strictJwt.status === 200 && strictJwt.subject === "admin",
    `dev=${strictDev.status} jwt=${strictJwt.status}`,
  );

  // 9) 目录与另一协议同一套规则
  const modelsDev = await gwCall(GW_PORT, "/v1/models", DEV_TOKEN);
  const modelsJwt = await gwCall(GW_PORT, "/v1/models", gwToken);
  const modelsNone = await gwCall(GW_PORT, "/v1/models", undefined);
  check(
    "9a /v1/models 规则一致（dev 通 / 身份通 / 无令牌拒）",
    modelsDev.status === 200 && modelsJwt.status === 200 && modelsJwt.subject === "admin" && modelsNone.status === 401,
    `${modelsDev.status}/${modelsJwt.status}/${modelsNone.status}`,
  );
  const openaiJwt = await gwCall(GW_PORT, "/v1/chat/completions", gwToken);
  const openaiNone = await gwCall(GW_PORT, "/v1/chat/completions", undefined);
  check("9b /v1/chat/completions 规则一致", openaiJwt.status === 200 && openaiNone.status === 401, `${openaiJwt.status}/${openaiNone.status}`);

  // 10) /health 暴露鉴权方式
  const health = await (await fetch(`http://127.0.0.1:${GW_PORT}/health`)).json();
  const healthStrict = await (await fetch(`http://127.0.0.1:${GW_PORT + 1}/health`)).json();
  check(
    "10 /health 暴露鉴权方式（严格模式不含 dev-token）",
    String(health.auth).includes("gateway") &&
      String(health.auth).includes("dev-token") &&
      !String(healthStrict.auth).includes("dev-token"),
    `${health.auth} | ${healthStrict.auth}`,
  );

  // 401 提示语（可运维性）
  const hint = noneRes.json?.error?.hint ?? "";
  check("11 401 带可操作提示（如何换令牌）", String(hint).includes("gateway-token"), String(hint).slice(0, 80));
}

main()
  .catch((e) => {
    console.error(e);
    failed += 1;
  })
  .finally(async () => {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        /* ignore */
      }
    }
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    await cleanupAdminAudit({ since: STARTED_AT });
    console.log(failed === 0 ? "\nGATEWAY AUTH SMOKE PASS" : `\nGATEWAY AUTH SMOKE FAIL (${failed})`);
    process.exit(failed === 0 ? 0 : 1);
  });
