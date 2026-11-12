/**
 * M0-E1/E2 端到端冒烟：
 *   起网关（随机端口）→ 生成 Pi models.json（指向网关）→ 起 sidecar →
 *   new_session → prompt(真实模型 deepseek-v4-flash-0731) → 流式 session_event →
 *   JSONL 落盘 → list_sessions / get_entries 返回真实内容 → shutdown。
 *
 * 前置：server 与 sidecar 均已 build（dist 存在）；.env 含 REACTOR_UPSTREAM_API_KEY。
 * 用法：node packages/server/scripts/e2e-smoke.mjs
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const GATEWAY_ENTRY = join(ROOT, "packages", "server", "dist", "index.js");
const SIDECAR_ENTRY = join(ROOT, "packages", "sidecar", "dist", "index.js");
const UPSTREAM_KEY = process.env.REACTOR_UPSTREAM_API_KEY;
const UPSTREAM_BASE = process.env.REACTOR_UPSTREAM_BASE_URL ?? "https://tokenrhythm.studio/v1";

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

if (!UPSTREAM_KEY) {
  console.error("REACTOR_UPSTREAM_API_KEY 未配置（.env）");
  process.exit(1);
}

const port = 18000 + Math.floor(Math.random() * 5000);
const devToken = `e2e-${Math.random().toString(36).slice(2, 12)}`;
const agentDir = mkdtempSync(join(tmpdir(), "reactor-e2e-"));
const workspace = mkdtempSync(join(tmpdir(), "reactor-e2e-ws-"));

const children = [];
function cleanup() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function waitForHealth(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  return false;
}

function rpcClient(child, outLines) {
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (l) => outLines.push(l));
  const pending = new Map();
  rl.on("line", (l) => {
    try {
      const f = JSON.parse(l);
      if (f && typeof f.id !== "undefined" && pending.has(f.id)) {
        pending.get(f.id)(f);
        pending.delete(f.id);
      }
    } catch {
      /* skip */
    }
  });
  let nextId = 1;
  return {
    call(method, params, timeoutMs = 120000) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting ${method}`));
        }, timeoutMs);
        pending.set(id, (frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
  };
}

async function main() {
  console.log(`[e2e] gateway port=${port} model=deepseek-v4-flash-0731`);
  try {
    // 1) 起网关
    const gw = spawn(process.execPath, [GATEWAY_ENTRY], {
      env: {
        ...process.env,
        REACTOR_GATEWAY_HOST: "127.0.0.1",
        REACTOR_GATEWAY_PORT: String(port),
        REACTOR_DEV_TOKEN: devToken,
        REACTOR_UPSTREAM_BASE_URL: UPSTREAM_BASE,
        REACTOR_UPSTREAM_API_KEY: UPSTREAM_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(gw);
    gw.stderr.on("data", (d) => process.stderr.write("[gateway] " + d));
    const gwReady = await waitForHealth(`http://127.0.0.1:${port}/health`);
    check("网关启动 /health", gwReady);

    // 2) 生成 Pi settings.json（默认模型指向网关 provider）；provider 由 sidecar 的 gateway extension 注册
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "tokenrhythm", defaultModel: "deepseek-v4-flash-0731" }, null, 2) + "\n",
    );

    // 3) 起 sidecar（网关地址/令牌经 env 注入）
    const sc = spawn(process.execPath, [SIDECAR_ENTRY], {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        REACTOR_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`,
        REACTOR_GATEWAY_TOKEN: devToken,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(sc);
    sc.stderr.on("data", (d) => process.stderr.write("[sidecar] " + d));
    const outLines = [];
    const rpc = rpcClient(sc, outLines);
    await sleep(400);

    // 4) new_session
    const created = await rpc.call("new_session", { new_session: { cwd: workspace, type: "code", name: "e2e" } });
    check("new_session", Boolean(created?.result?.sessionId), JSON.stringify(created?.result));
    const sessionId = created?.result?.sessionId;

    // 5) get_state：确认模型已指向网关 provider
    const state = await rpc.call("get_state", { get_state: { sessionId } });
    check("get_state 模型已配置", state?.result?.model?.provider === "tokenrhythm", JSON.stringify(state?.result?.model));

    // 6) prompt 真实模型（流式事件收集）
    const eventTypes = [];
    const eventPump = setInterval(() => {
      for (const line of outLines) {
        if (!line.includes('"session_event"')) continue;
        try {
          const f = JSON.parse(line);
          const t = f?.params?.data?.type;
          if (t && !eventTypes.includes(t)) eventTypes.push(t);
        } catch {
          /* skip */
        }
      }
    }, 50);
    const promptRes = await rpc.call("prompt", { prompt: { sessionId, prompt: "只回复两个字：ok" } });
    check("prompt preflight 通过（accepted）", promptRes?.result?.accepted === true, JSON.stringify(promptRes?.error));
    // 等待 agent_end（最多 90s）
    const settled = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 90000) {
        if (eventTypes.includes("agent_end")) return true;
        if (eventTypes.includes("message_end") && eventTypes.includes("agent_settled")) return true;
        await sleep(300);
      }
      return false;
    })();
    clearInterval(eventPump);
    check("收到流式事件并结束（agent_end/message_end）", settled, eventTypes.join(","));
    console.log(`  ℹ 事件类型: ${eventTypes.join(",")}`);

    // 7) 落盘后 list_sessions / get_entries（真实内容）
    await sleep(800);
    const listed = await rpc.call("list_sessions", {});
    const sessions = listed?.result?.sessions ?? [];
    check("list_sessions 含新会话（已落盘）", sessions.some((s) => s.id === sessionId), `count=${sessions.length}`);
    const entries = await rpc.call("get_entries", { get_entries: { sessionId } });
    const entryList = entries?.result?.entries ?? [];
    check("get_entries 返回真实条目（含消息）", entryList.some((e) => e.type === "message"), `count=${entryList.length}`);

    // 8) shutdown 优雅退出
    await rpc.call("shutdown", { shutdown: { reason: "e2e" } });
    check("sidecar shutdown 退出", true);

    console.log(failed === 0 ? "\nE2E SMOKE PASS" : `\nE2E SMOKE FAIL (${failed})`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error("[e2e] FAIL", err);
    process.exit(1);
  } finally {
    cleanup();
  }
}

main();
