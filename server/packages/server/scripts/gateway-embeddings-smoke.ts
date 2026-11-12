/**
 * 网关 embeddings / rerank 探针（KB-⑤）
 *
 * 为什么必须真发请求：「路由注册了、类型也对」但**实际打错上游路径 / 带上错鉴权头 /
 * 把未知模型放行**，纯静态检查一律看不出来。所以这里起一个 mock 上游，把网关当真实
 * HTTP 服务调用，逐条断言行为。
 *
 * 守四件事：
 *  ① **唯一出口与同一治理**（BRD M10-01）：无令牌 401；有令牌才转发；回执头标注上游与归属。
 *  ② **路径正确**：embeddings → `<base>/embeddings`，rerank → `<base>/rerank`
 *     （上游 baseUrl 自带 `/v1`，写错会变成 `/v1/v1/...` 或打到 chat 路径）。
 *  ③ **请求体不被改写**：原样透传（不归一字段 —— 归一在 sidecar 适配器做）。
 *  ④ **鉴权头用 Bearer**：embeddings/rerank 在各家都是 OpenAI 形态，
 *     用 anthropic 的 `x-api-key` 会被上游 401（这是最容易犯的复制粘贴错误）。
 *
 * 用法：`pnpm --filter @reactor/server exec tsx scripts/gateway-embeddings-smoke.ts`
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createGatewayApp } from "../src/gateway/index.js";
import { loadGatewayConfig } from "../src/gateway/config.js";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
}

interface Hit {
  path: string;
  method: string;
  auth?: string;
  apiKey?: string;
  contentType?: string;
  body: string;
}

const DEV_TOKEN = "kb5-smoke-token";

async function main(): Promise<void> {
  const hits: Hit[] = [];

  // mock 上游：记录每次请求（路径/鉴权头/原始体），按路径回不同形状
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({
        path: req.url ?? "",
        method: req.method ?? "",
        auth: req.headers.authorization,
        apiKey: req.headers["x-api-key"] as string | undefined,
        contentType: req.headers["content-type"] as string | undefined,
        body,
      });
      res.setHeader("content-type", "application/json");
      if ((req.url ?? "").includes("embeddings")) {
        res.end(JSON.stringify({ object: "list", model: "emb-1", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 7, total_tokens: 7 } }));
      } else if ((req.url ?? "").includes("rerank")) {
        res.end(JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: `unexpected path ${req.url}` } }));
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/v1`;

  const config = loadGatewayConfig({
    ...process.env,
    REACTOR_UPSTREAM_API_KEY: "upstream-secret-key",
    REACTOR_UPSTREAM_BASE_URL: base,
    REACTOR_DEV_TOKEN: DEV_TOKEN,
    REACTOR_GATEWAY_ALLOW_DEV_TOKEN: "true",
  } as NodeJS.ProcessEnv);
  const app = createGatewayApp(config, {});

  const post = (path: string, body: unknown, token?: string): Promise<Response> =>
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  try {
    // ── ① 鉴权与路由登记 ─────────────────────────────────────────────
    {
      const noToken = await post("/v1/embeddings", { model: "emb-1", input: "文本" });
      check("① 无令牌 → 401（与 chat 同一鉴权）", noToken.status === 401, noToken.status);
      check("① 401 不回显上游信息（未鉴权不泄露配置）", noToken.headers.get("x-reactor-upstream") === null, noToken.headers.get("x-reactor-upstream"));

      const badToken = await post("/v1/rerank", { model: "rr-1", query: "q", documents: ["a"] }, "wrong-token");
      check("① 错令牌 → 401", badToken.status === 401, badToken.status);
      check("① 未鉴权时**不打上游**（不消耗额度）", hits.length === 0, hits.length);
    }

    // ── ② embeddings 转发 ────────────────────────────────────────────
    {
      const res = await post("/v1/embeddings", { model: "emb-1", input: ["第一段", "第二段"] }, DEV_TOKEN);
      check("② 有令牌 → 200", res.status === 200, res.status);
      check("② ★上游路径是 /v1/embeddings（不是 /v1/v1 也不是 chat/completions）", hits[0]?.path === "/v1/embeddings", hits.map((h) => h.path));
      check("② ★用 Bearer 而非 x-api-key（embeddings 是 OpenAI 形态）", hits[0]?.auth === "Bearer upstream-secret-key" && hits[0]?.apiKey === undefined, { auth: hits[0]?.auth, apiKey: hits[0]?.apiKey });
      check("② ★请求体原样透传（含数组 input 不被改写）", hits[0]?.body === JSON.stringify({ model: "emb-1", input: ["第一段", "第二段"] }), hits[0]?.body);
      check("② 回执头标注上游 provider", res.headers.get("x-reactor-upstream") === "tokenrhythm", res.headers.get("x-reactor-upstream"));
      check("② 回执头标注调用者（dev）", res.headers.get("x-reactor-auth") === "dev", res.headers.get("x-reactor-auth"));
      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }>; usage?: { total_tokens?: number } };
      check("② 上游回执体原样返回（含向量与 usage）", json.data?.[0]?.embedding?.length === 3 && json.usage?.total_tokens === 7, json);
    }

    // ── ③ rerank 转发 ───────────────────────────────────────────────
    {
      const before = hits.length;
      const res = await post("/v1/rerank", { model: "rr-1", query: "储能", documents: ["甲", "乙"], top_n: 2 }, DEV_TOKEN);
      check("③ 有令牌 → 200", res.status === 200, res.status);
      check("③ ★上游路径是 /v1/rerank", hits[before]?.path === "/v1/rerank", hits.slice(before).map((h) => h.path));
      const json = (await res.json()) as { results?: Array<{ index: number; relevance_score: number }> };
      check("③ 回执原样返回（含排序分）", json.results?.[0]?.index === 1 && json.results?.[0]?.relevance_score === 0.9, json);
      check("③ ★网关不改写字段（top_n 原样过去，归一留给 sidecar 适配器）", hits[before]?.body === JSON.stringify({ model: "rr-1", query: "储能", documents: ["甲", "乙"], top_n: 2 }), hits[before]?.body);
    }

    // ── ④ 与 chat 同一治理：模型解析失败要说清原因 ────────────────────
    {
      const res = await post("/v1/embeddings", { model: "", input: "x" }, DEV_TOKEN);
      // 空 model → 无法路由；env 单上游模式仍会兜底转发（与 chat 行为一致）
      check("④ 空 model 时行为与 chat 一致（env 模式兜底上游，不崩）", res.status === 200 || res.status === 503, res.status);
    }
  } finally {
    upstream.close();
  }

  console.log(failed === 0 ? "\ngateway-embeddings-smoke: 全部断言通过" : `\ngateway-embeddings-smoke: ${failed} 条断言失败`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
