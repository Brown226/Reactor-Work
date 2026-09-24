import {
  normalizeServerAgentList,
  normalizeServerSkillCatalogItem,
  normalizeServerSkillCatalogList,
  normalizeServerSkillCatalogPage,
  type ApiClient,
  type ServerAgentDefinition,
  type ServerAgentMutationResult,
  type ServerSkillCatalogItem,
  type ServerSkillCatalogPage,
  type ServerSkillCatalogQuery,
  type ServerSkillFavoriteResult,
  type ServerSkillInstallResult,
} from "@zcode/shared";

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

/** 技能附属文件清单项（落盘集响应内联）。sha256 是服务端按**解码后字节**计算的。 */
export interface ReactorServerSkillFileMeta {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}

/** 落盘集技能条目：SKILL.md 正文 + 附件清单（附件内容按需拉，不在本响应里）。 */
export interface ReactorServerSkillPayload {
  readonly name: string;
  readonly title: string;
  readonly description: string | null;
  readonly content: string;
  readonly version: string;
  readonly disableModelInvocation: boolean;
  readonly files: readonly ReactorServerSkillFileMeta[];
}

/** 单个附属文件内容（按需拉取；二进制走 contentB64）。 */
export interface ReactorServerSkillFileContent extends ReactorServerSkillFileMeta {
  readonly content?: string;
  readonly contentB64?: string;
}

/** 注入集条目（只读投影：与落盘集做差集得到「已下架」）。 */
export interface ReactorServerSkillStateEntry {
  readonly name: string;
  readonly enabled: boolean;
  readonly disableModelInvocation: boolean;
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

    /** 技能落盘集：已安装 ∪ 默认安装 − 已 dismiss（附件只含清单，内容按需拉）。 */
    async deliverableSkills(
      serverUrl: string,
      accessToken: string,
    ): Promise<{ skills: ReactorServerSkillPayload[] }> {
      const { data } = await request<{ skills?: unknown }>(`${serverUrl}/me/skills`, {
        method: "GET",
        accessToken,
      });
      const list = Array.isArray(data?.skills) ? data.skills : [];
      return {
        skills: list.map((raw): ReactorServerSkillPayload => {
          const item = (raw ?? {}) as Partial<ReactorServerSkillPayload>;
          const files = Array.isArray(item.files) ? item.files : [];
          return {
            name: typeof item.name === "string" ? item.name : "",
            title: typeof item.title === "string" ? item.title : "",
            description: typeof item.description === "string" ? item.description : null,
            content: typeof item.content === "string" ? item.content : "",
            version: typeof item.version === "string" ? item.version : "",
            disableModelInvocation: item.disableModelInvocation === true,
            files: files.map((rawFile): ReactorServerSkillFileMeta => {
              const file = (rawFile ?? {}) as Partial<ReactorServerSkillFileMeta>;
              return {
                path: typeof file.path === "string" ? file.path : "",
                size: typeof file.size === "number" ? file.size : 0,
                sha256: typeof file.sha256 === "string" ? file.sha256 : "",
                executable: file.executable === true,
              };
            }),
          };
        }),
      };
    },

    /** 单个附属文件内容（按需拉取；404 表示清单与存储不一致，抛 ReactorServerHttpError）。 */
    async skillFile(
      serverUrl: string,
      accessToken: string,
      name: string,
      path: string,
    ): Promise<ReactorServerSkillFileContent> {
      const { data } = await request<{ file?: unknown }>(
        `${serverUrl}/me/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`,
        { method: "GET", accessToken },
      );
      const file = (data?.file ?? {}) as Partial<ReactorServerSkillFileContent>;
      return {
        path: typeof file.path === "string" ? file.path : path,
        size: typeof file.size === "number" ? file.size : 0,
        sha256: typeof file.sha256 === "string" ? file.sha256 : "",
        executable: file.executable === true,
        ...(typeof file.contentB64 === "string" ? { contentB64: file.contentB64 } : {}),
        ...(typeof file.content === "string" ? { content: file.content } : {}),
      };
    },

    /** 注入集（恒过滤 enabled=false）；客户端只读，用于「已下架」投影。 */
    async skillStates(
      serverUrl: string,
      accessToken: string,
    ): Promise<ReactorServerSkillStateEntry[]> {
      const { data } = await request<{ skills?: unknown }>(`${serverUrl}/me/skills/state`, {
        method: "GET",
        accessToken,
      });
      const list = Array.isArray(data?.skills) ? data.skills : [];
      const entries: ReactorServerSkillStateEntry[] = [];
      for (const raw of list) {
        const item = (raw ?? {}) as Partial<ReactorServerSkillStateEntry>;
        if (typeof item.name !== "string" || item.name.length === 0) continue;
        entries.push({
          name: item.name,
          enabled: item.enabled !== false,
          disableModelInvocation: item.disableModelInvocation === true,
        });
      }
      return entries;
    },

    /** 卸载：服务端写 dismissal（auto_install 不会再塞回），幂等。 */
    async uninstallSkill(serverUrl: string, accessToken: string, name: string): Promise<void> {
      await request<unknown>(`${serverUrl}/me/skills/${encodeURIComponent(name)}/install`, {
        method: "DELETE",
        accessToken,
      });
    },

    /** 更新归位：拉完下发集后调用，使 hasUpdate 归位。 */
    async refreshSkill(serverUrl: string, accessToken: string, name: string): Promise<void> {
      await request<unknown>(`${serverUrl}/me/skills/${encodeURIComponent(name)}/refresh`, {
        method: "POST",
        accessToken,
      });
    },

    /**
     * 技能市场目录（分页；可见性与安装/收藏关系由服务端 SQL 完成）。
     * 形状归一化走 shared 的 `normalizeServerSkillCatalogPage`（契约单点：非法 name 丢弃、缺字段兜底）。
     */
    async skillCatalog(
      serverUrl: string,
      accessToken: string,
      query?: ServerSkillCatalogQuery,
    ): Promise<ServerSkillCatalogPage> {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value === undefined) continue;
        const param = key === "favoritedOnly" ? "favorited" : key;
        params.set(param, value === true ? "1" : String(value));
      }
      const search = params.toString();
      const { data } = await request<unknown>(
        `${serverUrl}/me/skills/catalog${search ? `?${search}` : ""}`,
        { method: "GET", accessToken },
      );
      return normalizeServerSkillCatalogPage(data);
    },

    /** 技能精选（服务端按 nonce 加权抽取的 featured 子集；响应 `{items, nonce}`，nonce 不消费）。 */
    async skillFeatured(serverUrl: string, accessToken: string): Promise<ServerSkillCatalogItem[]> {
      const { data } = await request<unknown>(`${serverUrl}/me/skills/featured`, {
        method: "GET",
        accessToken,
      });
      return normalizeServerSkillCatalogList(data);
    },

    /** 安装技能（幂等；重复安装不报错）。成功后调用方必须 re-GET 再 reconcile（D3）。 */
    async installSkill(
      serverUrl: string,
      accessToken: string,
      name: string,
    ): Promise<ServerSkillInstallResult> {
      const { data } = await request<unknown>(
        `${serverUrl}/me/skills/${encodeURIComponent(name)}/install`,
        { method: "POST", accessToken },
      );
      return toSkillMutationResult(data, name);
    },

    /**
     * 收藏 / 取消收藏（幂等；`favorited=true` 用 PUT、false 用 DELETE，对齐服务端路由）。
     * 纯标记不改下发集；成功后调用方 re-GET 刷新目录投影。
     */
    async setSkillFavorite(
      serverUrl: string,
      accessToken: string,
      name: string,
      favorited: boolean,
    ): Promise<ServerSkillFavoriteResult> {
      const { data } = await request<{ ok?: unknown; favorited?: unknown }>(
        `${serverUrl}/me/skills/${encodeURIComponent(name)}/favorite`,
        { method: favorited ? "PUT" : "DELETE", accessToken },
      );
      const value = typeof data?.favorited === "boolean" ? data.favorited : favorited;
      return { ok: true, favorited: value };
    },

    /**
     * 专家市场目录（含我的安装/启停/收藏关系；可见性与分页由服务端 SQL 完成，一次全量）。
     * 形状归一化走 shared 的 `normalizeServerAgentList`（契约单点：非法 name 丢弃、缺字段兜底）。
     */
    async listAgents(serverUrl: string, accessToken: string): Promise<ServerAgentDefinition[]> {
      const { data } = await request<unknown>(`${serverUrl}/me/agents`, {
        method: "GET",
        accessToken,
      });
      return normalizeServerAgentList(data);
    },

    /** 安装专家（幂等；重复安装 = 重新启用）。成功后调用方必须 re-GET 再 reconcile（D3）。 */
    async installAgent(
      serverUrl: string,
      accessToken: string,
      name: string,
    ): Promise<ServerAgentMutationResult> {
      const { data } = await request<unknown>(
        `${serverUrl}/me/agents/${encodeURIComponent(name)}/install`,
        { method: "POST", accessToken },
      );
      return toAgentMutationResult(data, name);
    },

    /** 卸载专家（幂等）；服务端写关系，成功后调用方才删本地文件。 */
    async uninstallAgent(
      serverUrl: string,
      accessToken: string,
      name: string,
    ): Promise<ServerAgentMutationResult> {
      const { data } = await request<unknown>(
        `${serverUrl}/me/agents/${encodeURIComponent(name)}/install`,
        { method: "DELETE", accessToken },
      );
      return toAgentMutationResult(data, name);
    },

    /** 启停已安装专家（未安装时服务端回 409）。 */
    async setAgentInstallEnabled(
      serverUrl: string,
      accessToken: string,
      name: string,
      enabled: boolean,
    ): Promise<ServerAgentMutationResult> {
      const { data } = await request<unknown>(
        `${serverUrl}/me/agents/${encodeURIComponent(name)}/install`,
        { method: "PATCH", accessToken, body: { enabled } },
      );
      return toAgentMutationResult(data, name);
    },
  };
}

/** 技能写操作返回按 shared 契约兜底：缺 `affected` 时退回目标名；`skill` 缺失时留 null（由 re-GET 补）。 */
function toSkillMutationResult(data: unknown, name: string): ServerSkillInstallResult {
  const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const affected = Array.isArray(record.affected)
    ? record.affected.filter((entry): entry is string => typeof entry === "string")
    : [];
  const skill = normalizeServerSkillCatalogItem(record.skill);
  return {
    ok: true,
    affected: affected.length > 0 ? affected : [name],
    skill,
  };
}

/** 写操作返回按 shared 契约兜底：服务端保证 `{ok, affected[...]}`，缺项时退回目标名。 */
function toAgentMutationResult(data: unknown, name: string): ServerAgentMutationResult {
  const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const affected = Array.isArray(record.affected)
    ? record.affected.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ok: true,
    affected: affected.length > 0 ? affected : [name],
    ...(record.created !== undefined ? { created: record.created === true } : {}),
    ...(record.enabled !== undefined ? { enabled: record.enabled === true } : {}),
    ...(record.favorited !== undefined ? { favorited: record.favorited === true } : {}),
  };
}

export type ReactorServerClient = ReturnType<typeof createReactorServerClient>;
