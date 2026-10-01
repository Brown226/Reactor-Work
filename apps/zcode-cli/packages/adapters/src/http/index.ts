// ============================================================
// Node HTTP Client Adapter
// ============================================================

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { ProxyAgent } from "proxy-agent";
import {
  createHttpClientError,
  isHttpClientPortError,
  type HttpClientEgressInfo,
  type HttpClientPort,
  type HttpClientRequest,
  type HttpClientResponse,
  type HttpClientRunOptions,
} from "@zcode/contracts";
import {
  isReactorEgressHostAllowed,
  type ReactorDesktopPolicySource,
} from "@zcode/shared";
import {
  loadTlsCaCertificates,
  resolveProxyForRequest,
  resolveWebFetchProxyForRequest,
} from "../network/http-config.js";
import { createDesktopPolicySource } from "../policy/desktopPolicySource.js";
import {
  assertPublicEgressDestination,
  createPublicEgressLookup,
  defaultPublicDnsLookup,
  type DnsLookup,
} from "./public-egress-policy.js";
import { readResponseBody } from "./response-body.js";

const TRACE_HEADER = "x-zcode-trace-id";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface NodeHttpClientAdapterOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  proxyUrl?: string;
  noProxy?: string;
  caCertFile?: string;
  dnsLookup?: DnsLookup;
  capturedUserProxyEnvFallback?: boolean;
  /**
   * 组织出网白名单来源（P4.3）：缺省读 `{用户数据根}/desktop-policy.json`（Host 写、CLI 只读）。
   * 只作用于 `egressPolicy === "public"` 的请求（WebFetch 这类统一出网口），
   * 未配置（文件不存在 / 名单为空）时行为与接线前完全一致 —— 不限制。
   */
  desktopPolicy?: ReactorDesktopPolicySource;
}

/** 进程内共享的默认策略来源：读同一个文件，没必要每个 client 各持一份缓存。 */
let sharedDesktopPolicySource: ReactorDesktopPolicySource | null = null;
function resolveDesktopPolicySource(
  override: ReactorDesktopPolicySource | undefined,
): ReactorDesktopPolicySource {
  if (override) return override;
  sharedDesktopPolicySource ??= createDesktopPolicySource();
  return sharedDesktopPolicySource;
}

export class NodeHttpClientAdapter implements HttpClientPort {
  private tlsCaCertificates: Buffer | undefined;
  private tlsCaLoaded = false;

  constructor(private readonly options: NodeHttpClientAdapterOptions = {}) {}

  async request(
    request: HttpClientRequest,
    options: HttpClientRunOptions = {},
  ): Promise<HttpClientResponse> {
    const startedAt = Date.now();
    const url = normalizeUrl(request.url);
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes =
      request.maxResponseBytes ?? this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const proxyResolver = this.options.capturedUserProxyEnvFallback
      ? resolveWebFetchProxyForRequest
      : resolveProxyForRequest;
    const proxy = proxyResolver(url, {
      env: this.options.env,
      httpProxy: this.options.proxyUrl,
      noProxy: this.options.noProxy,
    });
    const publicDnsLookup =
      request.egressPolicy === "public"
        ? (this.options.dnsLookup ?? defaultPublicDnsLookup())
        : undefined;
    const tlsCaCertificates = this.resolveTlsCaCertificates();
    const egress = buildEgressInfo(proxy, tlsCaCertificates);
    const abortController = new AbortController();
    const abortState = linkAbortSignals(options.signal, abortController);
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        abortState.timedOut = true;
        abortController.abort(new Error(`HTTP request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    try {
      if (publicDnsLookup) {
        // P4.3 出网白名单：与 public-egress（私网 IP 校验）**双重判定**，互不替代。
        // 顺序上先判组织名单（本地判定，不需要 DNS），再判公网可达性。
        assertEgressAllowlist(url, this.options.desktopPolicy);
        assertPublicEgressProxyBoundary(url, proxy.proxyUrl);
        await assertPublicEgressDestination(url, publicDnsLookup, {
          signal: abortController.signal,
        });
      }
      const response = await fetchHttpResponse(
        url,
        request,
        abortController.signal,
        proxy.proxyUrl,
        tlsCaCertificates,
        publicDnsLookup,
      );
      const responseUrl = response.url || url.toString();
      const body = await readResponseBody(
        response,
        maxResponseBytes,
        abortController.signal,
        responseUrl,
      );

      return {
        url: responseUrl,
        status: response.status,
        statusText: response.statusText,
        headers: headersToRecord(response.headers),
        body,
        bytes: body.byteLength,
        durationMs: Math.max(0, Date.now() - startedAt),
        egress,
      };
    } catch (error) {
      throw toHttpClientError(error, {
        cancelled: abortController.signal.aborted && !abortState.timedOut,
        proxied: Boolean(proxy.proxyUrl),
        timedOut: abortState.timedOut,
        url: url.toString(),
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      abortState.unlink();
    }
  }

  private resolveTlsCaCertificates(): Buffer | undefined {
    if (!this.tlsCaLoaded) {
      this.tlsCaCertificates = loadTlsCaCertificates({
        caCertFile: this.options.caCertFile,
        env: this.options.env,
      });
      this.tlsCaLoaded = true;
    }
    return this.tlsCaCertificates;
  }
}

export function createNodeHttpClientAdapter(
  options: NodeHttpClientAdapterOptions = {},
): HttpClientPort {
  return new NodeHttpClientAdapter(options);
}

export function createNodeWebFetchHttpClientAdapter(
  options: NodeHttpClientAdapterOptions = {},
): HttpClientPort {
  return new NodeHttpClientAdapter({
    ...options,
    capturedUserProxyEnvFallback: true,
  });
}

function fetchHttpResponse(
  url: URL,
  request: HttpClientRequest,
  signal: AbortSignal,
  proxyUrl: string | undefined,
  tlsCaCertificates: Buffer | undefined,
  publicDnsLookup: DnsLookup | undefined,
): Promise<Response> {
  const useCustomTlsAgent = url.protocol === "https:" && tlsCaCertificates !== undefined;
  if (!proxyUrl && !useCustomTlsAgent && !publicDnsLookup) {
    return fetch(url.toString(), {
      body: request.body ? Buffer.from(request.body) : undefined,
      method: request.method ?? "GET",
      headers: buildHeaders(request),
      redirect: request.redirect ?? "manual",
      signal,
    });
  }

  const headers = buildHeaders(request);
  const transport = url.protocol === "https:" ? https : http;
  const agent = createRequestAgent(url, proxyUrl, tlsCaCertificates);
  const lookup = publicDnsLookup
    ? createPublicEgressLookup(url.toString(), publicDnsLookup, { signal })
    : undefined;

  return new Promise((resolve, reject) => {
    const requestOptions: http.RequestOptions = {
      agent,
      headers: headersToOutgoing(headers),
      hostname: url.hostname,
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      port: url.port || undefined,
      protocol: url.protocol,
      signal,
    };
    const clientRequest = transport.request(
      {
        ...requestOptions,
        lookup: proxyUrl ? undefined : lookup,
      },
      (message) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(message.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) {
              responseHeaders.append(name, item);
            }
          } else if (value !== undefined) {
            responseHeaders.append(name, String(value));
          }
        }

        resolve(
          new Response(Readable.toWeb(message) as ReadableStream<Uint8Array>, {
            headers: responseHeaders,
            status: message.statusCode ?? 502,
            statusText: message.statusMessage,
          }),
        );
      },
    );

    clientRequest.once("error", reject);
    clientRequest.end(request.body ? Buffer.from(request.body) : undefined);
  });
}

function normalizeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw createHttpClientError({
      code: "invalid_url",
      url: value,
      message: `Invalid URL: ${value}`,
      cause: error,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw createHttpClientError({
      code: "unsupported_protocol",
      url: value,
      message: `Unsupported URL protocol for HTTP request: ${url.protocol}`,
    });
  }

  return url;
}

function createRequestAgent(
  url: URL,
  proxyUrl: string | undefined,
  tlsCaCertificates: Buffer | undefined,
): http.Agent | undefined {
  if (proxyUrl) {
    return new ProxyAgent({
      ca: tlsCaCertificates,
      getProxyForUrl: () => proxyUrl,
      httpsAgent: tlsCaCertificates ? new https.Agent({ ca: tlsCaCertificates }) : undefined,
    }) as unknown as http.Agent;
  }

  if (url.protocol === "https:" && tlsCaCertificates) {
    return new https.Agent({ ca: tlsCaCertificates });
  }

  return undefined;
}

/**
 * 组织出网白名单闸（P4.3）：命中"不在名单内"即拒绝，理由给中文可读文案（会进入模型上下文）。
 *
 * 判定规则见 `@zcode/shared` 的 `isReactorEgressHostAllowed`（裸域含子域 / `*.` 不含裸域 /
 * `*` 逃生阀 / 端口不参与匹配）；名单为空或策略文件不存在 = 不限制，与接线前行为一致。
 */
function assertEgressAllowlist(url: URL, source: ReactorDesktopPolicySource | undefined): void {
  const allowlist = resolveDesktopPolicySource(source).current()?.egressAllowlist;
  if (!allowlist || allowlist.length === 0) return;
  if (isReactorEgressHostAllowed(url.hostname, allowlist)) return;
  throw createHttpClientError({
    code: "egress_blocked",
    url: url.toString(),
    message: `出网被组织策略拒绝：域名 ${url.hostname} 不在允许访问的清单内（如需访问请联系管理员调整出网白名单）`,
  });
}

function assertPublicEgressProxyBoundary(url: URL, proxyUrl: string | undefined): void {  if (!proxyUrl) return;
  // 普通代理会在代理侧解析目标域名，本地 DNS 校验无法证明最终 IP 仍是公网地址。
  throw createHttpClientError({
    code: "egress_blocked",
    url: url.toString(),
    message:
      "HTTP public egress cannot use a proxy because proxy-side DNS resolution cannot be verified",
  });
}

function buildEgressInfo(
  proxy: ReturnType<typeof resolveProxyForRequest>,
  tlsCaCertificates: Buffer | undefined,
): HttpClientEgressInfo {
  return {
    customCa: tlsCaCertificates !== undefined,
    noProxyMatched: proxy.noProxyMatched || undefined,
    proxied: proxy.proxyUrl !== undefined,
    proxyHost: proxy.proxyUrl ? safeProxyHost(proxy.proxyUrl) : undefined,
    proxySource: proxy.proxySource,
  };
}

function safeProxyHost(proxyUrl: string): string | undefined {
  try {
    const url = new URL(proxyUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return undefined;
  }
}

function buildHeaders(request: HttpClientRequest): Headers {
  const headers = new Headers(request.headers);
  if (request.trace?.traceId && !headers.has(TRACE_HEADER)) {
    headers.set(TRACE_HEADER, request.trace.traceId);
  }
  return headers;
}

function headersToOutgoing(headers: Headers): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    outgoing[key] = value;
  });
  return outgoing;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function linkAbortSignals(
  parent: AbortSignal | undefined,
  controller: AbortController,
): { timedOut: boolean; unlink: () => void } {
  const state: { timedOut: boolean; unlink: () => void } = {
    timedOut: false,
    unlink: () => undefined,
  };

  if (!parent) return state;

  if (parent.aborted) {
    controller.abort(parent.reason);
    return state;
  }

  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  state.unlink = () => parent.removeEventListener("abort", onAbort);
  return state;
}

function toHttpClientError(
  error: unknown,
  context: { cancelled: boolean; proxied: boolean; timedOut: boolean; url: string },
): Error {
  if (isHttpClientPortError(error)) {
    return error;
  }

  if (context.timedOut) {
    return createHttpClientError({
      code: "timeout",
      url: context.url,
      message: error instanceof Error ? error.message : "HTTP request timed out",
      cause: error,
    });
  }

  if (context.cancelled) {
    return createHttpClientError({
      code: "cancelled",
      url: context.url,
      message: error instanceof Error ? error.message : "HTTP request was cancelled",
      cause: error,
    });
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return createHttpClientError({
      code: "cancelled",
      url: context.url,
      message: "HTTP request was cancelled",
      cause: error,
    });
  }

  return createHttpClientError({
    code: context.proxied ? "proxy_error" : "network_error",
    url: context.url,
    message: error instanceof Error ? error.message : "HTTP request failed",
    cause: error,
  });
}
