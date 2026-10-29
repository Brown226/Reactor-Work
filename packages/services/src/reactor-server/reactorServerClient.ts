import {
  normalizeServerAgentList,
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
import { toAgentMutationResult, toSkillMutationResult } from "./reactorServerWriteResults.js";
import {
  createReactorServerP4Endpoints,
  type ReactorUsageGroupBy,
  type ReactorUsageSummary,
  type ReactorUsageSummaryRow,
} from "./reactorServerP4Endpoints.js";
import { createReactorServerMarketEndpoints } from "./reactorServerMarketEndpoints.js";

export type { ReactorUsageGroupBy, ReactorUsageSummary, ReactorUsageSummaryRow };

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
    /** true = 必须修改初始密码（旧版本服务端不下发该字段，故为可选）。 */
    mustChangePassword?: boolean;
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
  /** 上下文窗口（网关 `context_length`）；null = 上游/管理台未给，端侧走既有兜底 */
  readonly contextWindow: number | null;
  /** 最大输出 tokens（网关 `max_completion_tokens`）；null = 未配置 */
  readonly maxOutputTokens: number | null;
  readonly supportsTools: boolean;
  readonly supportsReasoning: boolean;
  /** 多模态（网关 `supports_vision`）：决定桌面端 `inputFormat.supportsImage` */
  readonly supportsVision: boolean;
  /**
   * 2026-10-14：桌面端「高级配置」里原本写死的 6 项能力，改由管理台勾选后经网关下发。
   * 未下发 / 非 true 一律 false，与扩量前的端侧硬编码行为一致。
   */
  readonly supportsVideo: boolean;
  readonly supportsAudio: boolean;
  readonly supportsPdf: boolean;
  /** 结构化输出（JSON Schema） */
  readonly supportsJsonSchemaOutput: boolean;
  /** 原生联网搜索 */
  readonly supportsNativeWebSearch: boolean;
  /** 对话进行中插入系统消息 */
  readonly supportsMidConversationSystem: boolean;
  /** 推理档位可选值（网关 `reasoning_levels`）；null = 管理台未配置，端侧按族推断兜底 */
  readonly reasoningLevels: readonly string[] | null;
  /** 档位→请求体的 CEL 表达式（网关 `reasoning_map`）；null = 用端侧安全缺省 `"{}"` */
  readonly reasoningMap: string | null;
  /**
   * 客户端直连地址（网关 `direct_base_url`，2026-10-22）；null = 该模型经网关转发。
   *
   * 为什么需要它：部分内网上游按**源 IP** 限并发（如 4），全体用户都从服务器一个出口出去必然打满。
   * 非空时端侧会为这些模型单独建一个 provider 直连该地址，出口 IP 变成用户自己的机器。
   * 用量与审计**不依赖流量经网关**（见 reactorServerP4Wiring 的 isEnterpriseProvider），管控不丢。
   */
  readonly directBaseUrl: string | null;
}

/** 只接受正整数：0/负数/小数/字符串一律按「未提供」处理，避免把脏值写进模型配置。 */
function positiveIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** 去空白、去空项；非数组或全空返回 null（区分「配了空数组」与「没配」）。 */
function stringArrayOrNull(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  return items.length > 0 ? [...new Set(items)] : null;
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

    /**
     * 自助修改密码（桌面端强制改密弹窗与「设置 → 账号」共用）。
     * 服务端会校验原密码与新密码强度，成功后清掉 mustChangePassword 并回传最新 user。
     */
    async changePassword(
      serverUrl: string,
      accessToken: string,
      oldPassword: string,
      newPassword: string,
    ): Promise<ReactorServerLoginResult["user"]> {
      const { data } = await request<{ user: ReactorServerLoginResult["user"] }>(
        `${serverUrl}/auth/change-password`,
        { method: "POST", accessToken, body: { oldPassword, newPassword } },
      );
      return data.user;
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
        data?: {
          id?: unknown;
          model_type?: unknown;
          display_name?: unknown;
          context_length?: unknown;
          max_completion_tokens?: unknown;
          supports_tools?: unknown;
          supports_reasoning?: unknown;
          supports_vision?: unknown;
          supports_video?: unknown;
          supports_audio?: unknown;
          supports_pdf?: unknown;
          supports_json_schema?: unknown;
          supports_native_web_search?: unknown;
          supports_mid_conversation_system?: unknown;
          reasoning_levels?: unknown;
          reasoning_map?: unknown;
          /** 客户端直连地址（2026-10-22）；老网关不下发，按 null 处理 */
          direct_base_url?: unknown;
        }[];
      }>(`${gatewayBaseUrl}/models`, { method: "GET", apiKey: gatewayToken });
      const list = Array.isArray(data?.data) ? data.data : [];
      const models: ReactorServerModelInfo[] = [];
      for (const item of list) {
        if (typeof item?.id !== "string" || item.id.length === 0) continue;
        models.push({
          id: item.id,
          modelType: typeof item.model_type === "string" ? item.model_type : null,
          displayName: typeof item.display_name === "string" ? item.display_name : null,
          // 2026-10-13：以下字段网关早已下发，此前接收段整段丢弃，导致桌面端只能用兜底值
          // （上下文/最大输出不同步、多模态标识丢失、推理档位推不出来）。见
          // docs/未完成-网关模型能力同步桌面端-方案-v1.md
          contextWindow: positiveIntOrNull(item.context_length),
          maxOutputTokens: positiveIntOrNull(item.max_completion_tokens),
          supportsTools: item.supports_tools === true,
          supportsReasoning: item.supports_reasoning === true,
          supportsVision: item.supports_vision === true,
          // 2026-10-14：6 项布尔能力。老版本网关不下发这些字段，`=== true` 自然落到 false，
          // 因此不需要版本协商，也不会让只连旧服务端的用户行为发生变化。
          supportsVideo: item.supports_video === true,
          supportsAudio: item.supports_audio === true,
          supportsPdf: item.supports_pdf === true,
          supportsJsonSchemaOutput: item.supports_json_schema === true,
          supportsNativeWebSearch: item.supports_native_web_search === true,
          supportsMidConversationSystem: item.supports_mid_conversation_system === true,
          reasoningLevels: stringArrayOrNull(item.reasoning_levels),
          reasoningMap:
            typeof item.reasoning_map === "string" && item.reasoning_map.trim()
              ? item.reasoning_map
              : null,
          // 老网关不下发该字段 → null，端侧行为与改造前逐字一致（全部经网关转发）
          directBaseUrl:
            typeof item.direct_base_url === "string" && item.direct_base_url.trim()
              ? item.direct_base_url.trim()
              : null,
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

    // P4 出口（批量审计上报 / 策略下发 / 用量聚合）在 reactorServerP4Endpoints.ts，
    // 与这里共用同一个 request 闭包：不新开第二条出网通道，也不把本文件顶过行数上限。
    ...createReactorServerP4Endpoints(request),
    // M2 市场出口（技能详情 /me/skills/:name、套件 /me/bundles*）在 reactorServerMarketEndpoints.ts，
    // 同 P4 惯例共用 request 闭包；形状归一化全部落在 shared 契约。
    ...createReactorServerMarketEndpoints(request),
  };
}

export type ReactorServerClient = ReturnType<typeof createReactorServerClient>;
