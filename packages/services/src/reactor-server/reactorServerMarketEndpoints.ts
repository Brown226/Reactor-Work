/**
 * 企业服务端客户端的 M2 市场出口：技能详情（`GET /me/skills/:name`）与技能套件（`/me/bundles*`）。
 *
 * 为什么单独成文件：与 `reactorServerP4Endpoints.ts` 同款惯例——`reactorServerClient.ts`
 * 受 `max-lines` 约束，把新出口搬出来既不改变「唯一出网通道」的所有权（`request` 由
 * 调用方注入，这里不 new 客户端、不持状态），也让详情/套件各自可读。
 * 形状归一化全部走 shared 契约（server-skills-market-types.ts），不在这里手写第二份 shape。
 */
import {
  normalizeServerSkillBundleDetail,
  normalizeServerSkillBundleList,
  normalizeServerSkillDetail,
  type ServerSkillBundleDetail,
  type ServerSkillBundleInstallResult,
  type ServerSkillBundleSummary,
  type ServerSkillDetail,
} from "@zcode/shared";

/** `createReactorServerClient` 内部的请求器签名（与 P4 出口共用同一闭包）。 */
export interface ReactorServerRequester {
  <T>(
    url: string,
    init: { method: string; body?: unknown; accessToken?: string; apiKey?: string },
  ): Promise<{ data: T; renewedAccessToken?: string }>;
}

export function createReactorServerMarketEndpoints(request: ReactorServerRequester) {
  return {
    /**
     * 技能详情（M2 #2）：目录条目 + SKILL.md 正文 + allowedTools + 附件清单（仅元信息）。
     * 404（技能不存在/不可见）由 request 抛 ReactorServerHttpError。
     */
    async skillDetail(
      serverUrl: string,
      accessToken: string,
      name: string,
    ): Promise<ServerSkillDetail> {
      const { data } = await request<unknown>(
        `${serverUrl}/me/skills/${encodeURIComponent(name)}`,
        { method: "GET", accessToken },
      );
      return normalizeServerSkillDetail(data);
    },

    /** 用户可见技能套件摘要（M2/M3 #13）：含可见成员数与我的已装数。 */
    async skillBundles(serverUrl: string, accessToken: string): Promise<ServerSkillBundleSummary[]> {
      const { data } = await request<unknown>(`${serverUrl}/me/bundles`, {
        method: "GET",
        accessToken,
      });
      return normalizeServerSkillBundleList(data);
    },

    /** 套件详情（成员为 catalog 同形条目）；响应形状不符时抛错（404 已由 request 抛）。 */
    async skillBundleDetail(
      serverUrl: string,
      accessToken: string,
      id: number,
    ): Promise<ServerSkillBundleDetail> {
      const { data } = await request<unknown>(
        `${serverUrl}/me/bundles/${encodeURIComponent(String(id))}`,
        { method: "GET", accessToken },
      );
      const detail = normalizeServerSkillBundleDetail(data);
      if (!detail) throw new Error(`套件详情响应形状不符: ${id}`);
      return detail;
    },

    /** 整套安装（服务端对可见且 enabled 的成员逐个写安装并撤销 dismissal，幂等）。 */
    async installSkillBundle(
      serverUrl: string,
      accessToken: string,
      id: number,
    ): Promise<ServerSkillBundleInstallResult> {
      const { data } = await request<unknown>(
        `${serverUrl}/me/bundles/${encodeURIComponent(String(id))}/install`,
        { method: "POST", accessToken },
      );
      const record = (typeof data === "object" && data !== null ? data : {}) as Record<
        string,
        unknown
      >;
      const affected = Array.isArray(record.affected)
        ? record.affected.filter((entry): entry is string => typeof entry === "string")
        : [];
      return { ok: true, affected };
    },
  };
}
