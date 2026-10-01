/**
 * 企业服务端客户端的 P4 出口：批量审计上报 / 策略下发 / 用量聚合。
 *
 * 为什么单独成文件：`reactorServerClient.ts` 已有 480 行且受 `max-lines` 约束，
 * 把 P4 的三个接口与它们的回执归一化搬出来，既不改变"唯一出网通道"的所有权
 * （`request` 由调用方注入，这里不 new 客户端、不持状态），也让新增出口各自可读。
 */
import type { AuditBatchRequest, AuditBatchResponse } from "./auditContract.js";

/** `createReactorServerClient` 内部的请求器签名（Bearer + 可选 x-api-key，回执带滑动续签头）。 */
export interface ReactorServerRequester {
  <T>(
    url: string,
    init: { method: string; body?: unknown; accessToken?: string; apiKey?: string },
  ): Promise<{ data: T; renewedAccessToken?: string }>;
}

/** 用量聚合分组口径（服务端 `UsageGroupBy`）。 */
export type ReactorUsageGroupBy = "dept" | "model" | "user" | "day";

/** 用量聚合的一行：分组键 + 四段 token + 调用数 + 服务端核算费用。 */
export interface ReactorUsageSummaryRow {
  readonly key: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
}

export interface ReactorUsageSummary {
  readonly groupBy: ReactorUsageGroupBy;
  readonly from: string;
  readonly to: string;
  readonly rows: readonly ReactorUsageSummaryRow[];
  readonly totals: ReactorUsageSummaryRow;
}

export function createReactorServerP4Endpoints(request: ReactorServerRequester) {
  return {
    /**
     * 批量上报用量/审计事件（P4.1b）：`POST /desktop/audit/batch`，Bearer **access** 令牌
     * （不是网关令牌，两者 audience 不同）。
     *
     * 红线（服务端会 400）：请求体**不得**带 `uid`/`deptId`（归属由服务端按令牌写入）；
     * 单批 ≤ `MAX_AUDIT_BATCH`（由调用方 `flushAuditOutbox` 保证）。这里只做出口，
     * 重试/ack/幂等语义都在 `auditFlush.ts` 与 `auditOutbox.ts`，不在客户端层兜。
     */
    async postAuditBatch(
      serverUrl: string,
      accessToken: string,
      body: AuditBatchRequest,
    ): Promise<AuditBatchResponse> {
      const { data } = await request<{
        accepted?: unknown;
        duplicates?: unknown;
        rejected?: unknown;
      }>(`${serverUrl}/desktop/audit/batch`, { method: "POST", accessToken, body });
      return normalizeAuditBatchResponse(data);
    },

    /**
     * 企业策略下发（`GET /desktop/policy`）：任意已登录用户可读。
     * 形状归一化（缺字段按默认合并、旧模式词映射）由调用方用
     * `@zcode/shared` 的 `normalizeReactorDesktopPolicy` 完成，这里只取 `policy` 字段。
     */
    async policy(serverUrl: string, accessToken: string): Promise<unknown> {
      const { data } = await request<{ policy?: unknown }>(`${serverUrl}/desktop/policy`, {
        method: "GET",
        accessToken,
      });
      return data?.policy;
    },

    /**
     * 用量聚合（`GET /desktop/usage/summary`）：设置页「本月累计 token」的服务端权威值
     * —— 端上 outbox 只存未确认事件，上报成功即 ack 删除，做不了月度累计（P4 文档 §5 做-4）。
     */
    async usageSummary(
      serverUrl: string,
      accessToken: string,
      query: { groupBy: ReactorUsageGroupBy; from?: string; to?: string },
    ): Promise<ReactorUsageSummary> {
      const params = new URLSearchParams({ groupBy: query.groupBy });
      if (query.from) params.set("from", query.from);
      if (query.to) params.set("to", query.to);
      const { data } = await request<{
        from?: unknown;
        to?: unknown;
        rows?: unknown;
        totals?: unknown;
      }>(`${serverUrl}/desktop/usage/summary?${params.toString()}`, {
        method: "GET",
        accessToken,
      });
      return {
        groupBy: query.groupBy,
        from: typeof data?.from === "string" ? data.from : "",
        to: typeof data?.to === "string" ? data.to : "",
        rows: Array.isArray(data?.rows) ? data.rows.map(toUsageSummaryRow) : [],
        totals: toUsageSummaryRow(data?.totals),
      };
    },
  };
}

/** 上报回执归一化：服务端保证 `{accepted,duplicates,rejected}`，缺项按 0 兜底（脏回执不丢整批）。 */
function normalizeAuditBatchResponse(raw: unknown): AuditBatchResponse {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const rejected = Array.isArray(record.rejected)
    ? record.rejected
        .map((entry) => {
          const item = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
            string,
            unknown
          >;
          return {
            eventId: typeof item.eventId === "string" ? item.eventId : "",
            reason: typeof item.reason === "string" ? item.reason : "",
          };
        })
        .filter((entry) => entry.eventId.length > 0)
    : [];
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  return { accepted: count(record.accepted), duplicates: count(record.duplicates), rejected };
}

export function toUsageSummaryRow(raw: unknown): ReactorUsageSummaryRow {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const number = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    key: typeof record.key === "string" ? record.key : "",
    calls: number(record.calls),
    inputTokens: number(record.inputTokens),
    outputTokens: number(record.outputTokens),
    cacheReadTokens: number(record.cacheReadTokens),
    cacheWriteTokens: number(record.cacheWriteTokens),
    totalTokens: number(record.totalTokens),
    cost: number(record.cost),
  };
}
