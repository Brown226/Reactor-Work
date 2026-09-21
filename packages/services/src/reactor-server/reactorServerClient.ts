import type { ApiClient } from "@zcode/shared";

/**
 * 企业服务端的 HTTP 客户端（薄封装，不做重试与状态）。
 *
 * 严守服务端契约（见 `server/packages/server/src/identity/routes.ts`）：
 *  - 错误体是 `{ error: { code, message } }`，`code` 多为字符串化的 HTTP 状态；
 *  - access 剩余不足 5 分钟时，**任何鉴权响应**都会带 `x-new-token`，不消费它就会在 2h 后被全量 401；
 *  - 网关令牌与 access 令牌 audience 不同，**不可混用**（混用必然 401）。
 */

/** 服务端固定端口约定：身份 8791、网关 8790（见 compose 的端口映射）。 */
const IDENTITY_PORT = "8791";
const GATEWAY_PORT = "8790";

export class ReactorServerHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ReactorServerHttpError";
    this.status = status;
    this.code = code;
  }

  /** 令牌失效类错误：调用方应据此判定"需要重新登录"，而不是重试。 */
  get isUnauthorized(): boolean {
    return this.status === 401 || this.code === "unauthorized";
  }
}

export interface ReactorServerTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** 服务端在响应头里捎带的新 access（滑动续签），有则覆盖缓存。 */
  readonly renewedAccessToken?: string;
}

export interface ReactorServerLoginResult extends ReactorServerTokenPair {
  readonly user: {
    id?: number;
    uid: string;
    name: string;
    role: string;
    dept?: { id: number; path?: string } | null;
  };
}

export interface ReactorServerGatewayTokenResult {
  readonly token: string;
  readonly expiresIn: number;
  readonly renewedAccessToken?: string;
}

export interface ReactorServerModelInfo {
  readonly id: string;
  readonly modelType: string | null;
  readonly displayName: string | null;
}

/** 归一化身份基址：去掉尾斜杠，缺协议时补 http://。 */
export function normalizeReactorServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("服务端地址不能为空");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`服务端地址无法解析：${input}`);
  }
  // 只有「http + 没写端口 + 没写路径」才补默认身份端口。https 通常意味着前面有反向代理，
  // 这时补 :8791 会把请求打到代理没监听的端口上；显式写了端口的也不改。
  if (url.protocol === "http:" && !url.port && url.pathname === "/") url.port = IDENTITY_PORT;
  return url.toString().replace(/\/+$/, "");
}

/**
 * 由身份基址推导网关基址（含 `/v1`）。
 * 约定：同主机，http 下端口换成网关端口；https（反向代理场景）保持隐式 443，只改路径。
 */
export function deriveGatewayBaseUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === "http:") url.port = GATEWAY_PORT;
  url.pathname = "/v1";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function createReactorServerClient(apiClient: ApiClient) {
  async function request<T>(
    url: string,
    init: { method: string; body?: unknown; accessToken?: string; apiKey?: string },
  ): Promise<{ data: T; renewedAccessToken?: string }> {
    const headers = new Headers({ accept: "application/json" });
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (init.accessToken) headers.set("authorization", `Bearer ${init.accessToken}`);
    if (init.apiKey) headers.set("x-api-key", init.apiKey);
    const response = await apiClient.request(url, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      timeoutMs: 20_000,
    });
    const renewed = response.headers.get("x-new-token")?.trim();
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw new ReactorServerHttpError(
        response.status,
        typeof error?.code === "string" ? error.code : String(response.status),
        typeof error?.message === "string" ? error.message : `服务端返回 ${response.status}`,
      );
    }
    return {
      data: parsed as T,
      ...(renewed ? { renewedAccessToken: renewed } : {}),
    };
  }

  return {
    async login(
      serverUrl: string,
      username: string,
      password: string,
    ): Promise<ReactorServerLoginResult> {
      const { data, renewedAccessToken } = await request<{
        accessToken: string;
        refreshToken: string;
        user: ReactorServerLoginResult["user"];
      }>(`${serverUrl}/auth/login`, { method: "POST", body: { username, password } });
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        user: data.user,
        ...(renewedAccessToken ? { renewedAccessToken } : {}),
      };
    },

    async refresh(serverUrl: string, refreshToken: string): Promise<ReactorServerTokenPair> {
      const { data } = await request<{ accessToken: string; refreshToken: string }>(
        `${serverUrl}/auth/refresh`,
        { method: "POST", body: { refreshToken } },
      );
      // refresh 是滚动轮换：必须把新的 refresh 存回去，否则下一次刷新必然失败。
      return { accessToken: data.accessToken, refreshToken: data.refreshToken };
    },

    async logout(serverUrl: string, accessToken: string): Promise<void> {
      await request<unknown>(`${serverUrl}/auth/logout`, { method: "POST", accessToken });
    },

    async gatewayToken(
      serverUrl: string,
      accessToken: string,
    ): Promise<ReactorServerGatewayTokenResult> {
      const { data, renewedAccessToken } = await request<{
        token: string;
        expiresIn: number;
      }>(`${serverUrl}/auth/gateway-token`, { method: "POST", accessToken });
      return {
        token: data.token,
        expiresIn: data.expiresIn,
        ...(renewedAccessToken ? { renewedAccessToken } : {}),
      };
    },

    async models(gatewayBaseUrl: string, gatewayToken: string): Promise<ReactorServerModelInfo[]> {
      const { data } = await request<{
        data?: { id?: unknown; model_type?: unknown; display_name?: unknown }[];
      }>(`${gatewayBaseUrl}/models`, { method: "GET", apiKey: gatewayToken });
      const list = Array.isArray(data?.data) ? data.data : [];
      const models: ReactorServerModelInfo[] = [];
      for (const item of list) {
        if (typeof item?.id !== "string" || item.id.length === 0) continue;
        models.push({
          id: item.id,
          modelType: typeof item.model_type === "string" ? item.model_type : null,
          displayName: typeof item.display_name === "string" ? item.display_name : null,
        });
      }
      return models;
    },
  };
}

export type ReactorServerClient = ReturnType<typeof createReactorServerClient>;
