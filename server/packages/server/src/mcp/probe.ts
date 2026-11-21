/**
 * 托管 MCP 上游探测（治理平面 P0）：管理台登记/改配置/手动同步/连通测试共用。
 *
 * 用官方 SDK（与端侧 adapters 同版本 `@modelcontextprotocol/client`）建一次短连接拉
 * `tools/list`，用完即关。SDK 会吞掉 HTTP 细节，所以包一层记录型 fetch 抓最后一个非 2xx
 * 状态码，把失败翻译成管理员可读的文案（spec §6）——**只回结论，不回上游响应原文**
 * （原文里可能夹带密钥或内部地址）。
 */

import { Client } from "@modelcontextprotocol/client";
import { SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export interface McpProbeInput {
  url: string;
  type: "http" | "sse";
  /** 已解密的共享凭据请求头（调用方负责 openSecret；本文件不落盘不打印） */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpProbeResult {
  ok: boolean;
  /** 原始工具数组（未校验形状；交给 catalog.buildSnapshot 校验与投影） */
  tools?: unknown[];
  /** 中文可读、脱敏的失败原因 */
  error?: string;
  latencyMs?: number;
  /** 401/403 = 凭据问题（管理台 UI 据此提示去改凭据而不是改地址） */
  rejected?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function probeMcpServer(input: McpProbeInput): Promise<McpProbeResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let lastStatus: number | null = null;
  // 记录型 fetch：SDK 吞掉 HTTP 状态，这里抓最后一个非 2xx 供错误归类
  const recordingFetch: typeof fetch = async (fetchInput, fetchInit) => {
    const response = await fetch(fetchInput, fetchInit);
    if (response.status >= 300) lastStatus = response.status;
    return response;
  };
  const url = new URL(input.url);
  const transport =
    input.type === "http"
      ? new StreamableHTTPClientTransport(url, {
          ...(input.headers && Object.keys(input.headers).length > 0
            ? { requestInit: { headers: input.headers } }
            : {}),
          fetch: recordingFetch,
        })
      : new SSEClientTransport(url, {
          ...(input.headers && Object.keys(input.headers).length > 0
            ? { requestInit: { headers: input.headers } }
            : {}),
          fetch: recordingFetch,
        });
  const client = new Client({ name: "reactor-identity-admin", version: "1.0.0" });
  try {
    await withTimeout(client.connect(transport), timeoutMs, "连接超时");
    const listed = await withTimeout(client.listTools(), timeoutMs, "拉取工具清单超时");
    return {
      ok: true,
      tools: listed.tools,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return { ok: false, error: explainProbeError(error, lastStatus, timeoutMs), rejected: isRejected(lastStatus) };
  } finally {
    try {
      await client.close();
    } catch {
      // 关闭失败不影响探测结论
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRejected(status: number | null): boolean {
  return status === 401 || status === 403;
}

/** 状态码 → 管理员可读文案（不回上游响应原文）。 */
function explainProbeError(error: unknown, status: number | null, timeoutMs: number): string {
  if (status === 401 || status === 403) return `凭据被拒绝（${status}）：共享凭据不对，或该账号没有访问权限`;
  if (status === 404) return "地址不存在或端点不对（404）：确认 URL 指向 MCP 端点";
  if (status !== null && status >= 400) return `上游返回 ${status}，请检查地址与凭据`;
  const raw = error instanceof Error ? error.message : String(error);
  if (/timed out|超时|abort/i.test(raw)) return `连接或拉取超时（${Math.round(timeoutMs / 1000)} 秒）`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|getaddrinfo/i.test(raw)) return "无法连接到目标地址";
  return "响应不是 MCP 端点或协议不符";
}
