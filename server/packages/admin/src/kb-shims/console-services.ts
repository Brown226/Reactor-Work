/**
 * KB 取数层 barrel + 管理端移植（dashboard）的**真实现**取数层。
 *
 * ## 这个文件的两段历史（并行批次撞车后的合并结果，2026-09-19）
 *
 * 两个并行会话同时在做「BuildingAI 管理端移植第 1 批」（dashboard + secret）：
 *  一边先建了本文件（`.ts`），给 dashboard/secret 写了 **mock**（写死假数据，等后端）；
 *  另一边把后端真端点落地（`gateway/admin-routes.ts` 的「密钥模板：写端点」段，t34 冒烟
 *  D1-D7 全绿）并按**生成物的实际字段访问**逐行核对了映射。本文件是合并结果：
 *  mock 段替换为真实现，形状以生成物页面实际用到的字段为准。
 *
 * ## 为什么有这个文件
 *
 * 移植脚本把上游 `@buildingai/services/*` 的引用统一改指到这里（一个 barrel，页面侧
 * 导入路径机械生成）。KB 的真实现住在 `data.tsx`（经 `export *` 透出）。
 *
 * ## ⚠️ 字段映射纪律（与 data.tsx 同一口）：**没有对应就留空，不编造**
 *
 * dashboard 的「订单/收入/访问趋势」与 secret 的「JSON 导入/使用量统计」没有数据源，
 * 对应字段留空或明确报错 —— 每段头上都有「明确不做」清单。
 */

// ── KB（真实现，透出 data.tsx）─────────────────────────────────────────────
import {
  getDatasetsConversationInfo,
  getDatasetsConversationMessages,
  type KbConversation,
  useSimpleMutation,
} from "./data";
import { useQuery } from "@tanstack/react-query";

export * from "./data";

// ── 运营总览（上游 `console/dashboard`，第 1 批移植）────────────────────────
//
// | 上游区块 | 本仓来源 | 结论 |
// |---|---|---|
// | 「对话统计」卡的 Token总数 | `/desktop/usage/summary?groupBy=day` totals | ✅ 真数据 |
// | 「用户统计」卡的用户总数 | `usersApi.list()` 的 total | ✅ 真数据 |
// | 「Token 使用排行」（模型/供应商 Tabs） | `groupBy=model` / `groupBy=provider` | ✅ 真数据 |
// | 「订单统计」/「收入趋势」/「用户趋势（访问/注册）」 | **无数据源**（ToC / 会话不出端） | ❌ 留空 → 0 / 空图 |
// | 活跃用户 / 今日新增 / 今日对话 / 应用使用排行 | **无数据源** | ❌ 留空 → 0 / 空态 |
//
// 区块级「隐藏无数据卡片」要改生成物（脚本会覆盖），所以由包装页
//（pages/DashboardPage.tsx）的横幅声明哪些区块留空；要裁剪应做成脚本变换并记入台账。

import { useCallback, useEffect, useState } from "react";
import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "../services/identity";
import { usageApi } from "../services/audit";
import { usersApi } from "../services/identity-resources";

const KB_AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

/** 上游 DashboardData 的本仓形状 —— **section 必填**（见 toDashboardData 头注的白屏教训），叶子可缺。
 *  `order` 已被用户拍板移除，原位换成 `usage`（客户端使用人数；卡片由脚本变换替换成「客户端使用」） */
export interface DashboardData {
  usage: { activeToday?: number; active7d?: number; changePct?: number };
  user: { totalUsers?: number; activeUsers?: number; newUsersToday?: number; userChange?: number };
  chat: { totalConversations?: number; totalTokens?: number; conversationsToday?: number; chatChange?: number };
  userDetail: { chartData: Array<Record<string, unknown>> };
  revenueDetail: { chartData: Array<Record<string, unknown>> };
  tokenUsage: {
    byModel: Array<{ modelId: string; modelName: string; provider: string; providerName: string; iconUrl?: string; tokens: number; conversations: number }>;
    byProvider: Array<{ providerId: string; provider: string; providerName: string; iconUrl?: string; tokens: number; conversations: number }>;
  };
  extension: { usageRanking: Array<{ extensionId: string; extensionName: string; usageCount: number }> };
}

const isoDaysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/**
 * 服务端聚合 → 页面形状的**纯映射**（探针 t194 直接断言它 —— SSR 不跑 effect，
 * 渲染断言拿不到数据，所以把映射抽成纯函数来验）。
 *
 * ⚠️ **section 对象必须恒在场**（usage/user/chat/userDetail/revenueDetail/tokenUsage/extension）：
 * 上游页面只做**一层**可选链（`data?.usage.changePct ?? 0`）—— 它防 `data` 缺、不防 `usage` 缺，
 * section 对象缺席 = 运行时 TypeError（本批实测白屏，原 `order` 卡因此炸过）。所以「诚实留空」
 * 的正确姿势是 **section 给空对象、叶子留 undefined**（页面 `?? 0` 兜底渲染成 0），不是把键省掉。
 *
 * `usage`（客户端使用人数）的口径：**今日/近7日有模型调用的去重用户数**（usage/summary 的
 * user 维度行数；服务端没有心跳/在线通道，「严格在线」当前不可得 —— 卡片文案写明口径）。
 */
export function toDashboardData(
  byModel: Array<{ key: string; calls: number; totalTokens: number }> | null,
  byDay: { totals?: { totalTokens?: number } } | null,
  users: { total?: number } | null,
  usage: { activeToday?: number; active7d?: number; changePct?: number } = {},
): DashboardData {
  return {
    usage,
    user: { totalUsers: users?.total },
    chat: { totalTokens: byDay?.totals?.totalTokens },
    userDetail: { chartData: [] },
    revenueDetail: { chartData: [] },
    tokenUsage: {
      byModel: (byModel ?? []).map((r) => ({
        modelId: r.key,
        modelName: r.key,
        provider: "",
        providerName: "",
        tokens: r.totalTokens,
        conversations: r.calls,
      })),
      // ⚠️ 服务端聚合没有 provider 维度（dept/model/user/day）⇒ 「供应商」Tab 留空；
      // 要真实聚合需 join 模型目录，属后续批次。
      byProvider: [],
    },
    extension: { usageRanking: [] },
  };
}

/** 活跃度统计：窗口内有模型调用的去重 uid 数（rows.length；rows 上限 500，超出即远超关注阈值） */
const countActive = (r: { rows?: Array<unknown> } | null): number | undefined => (r ? r.rows?.length ?? 0 : undefined);

export function useDashboardQuery(_params?: { userDays?: number; revenueDays?: number; tokenDays?: number }) {
  const [data, setData] = useState<DashboardData | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(() => {
    setIsLoading(true);
    const from = isoDaysAgo(30);
    let alive = true;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();
    Promise.all([
      usageApi.summary({ groupBy: "model", from }).catch(() => null),
      usageApi.summary({ groupBy: "day", from }).catch(() => null),
      usersApi.list().catch(() => null),
      usageApi.summary({ groupBy: "user", from: todayStart }).catch(() => null),
      usageApi.summary({ groupBy: "user", from: yesterdayStart, to: todayStart }).catch(() => null),
      usageApi.summary({ groupBy: "user", from }).catch(() => null),
    ]).then(([byModel, byDay, users, activeTodayRows, activeYesterdayRows, active7dRows]) => {
      if (!alive) return;
      const activeToday = countActive(activeTodayRows);
      const activeYesterday = countActive(activeYesterdayRows);
      const changePct =
        activeToday === undefined || activeYesterday === undefined || activeYesterday === 0
          ? undefined
          : Math.round(((activeToday - activeYesterday) / activeYesterday) * 1000) / 10;
      setData(
        toDashboardData(byModel?.rows ?? null, byDay, users, {
          activeToday,
          active7d: countActive(active7dRows),
          changePct,
        }),
      );
      setIsLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  return { data, isLoading, refetch: load };
}

// ── 密钥管理：**已下线**（2026-09-19 用户口径）───────────────────────────────
//
// 这里原本是「密钥管理」页（上游 `console/ai/secret` 移植）的取数层：模板查询、
// 按模板归组、密钥 CRUD 等。用户口径：**不需要针对密钥做单独的管理界面**，
// 密钥改到「供应商配置」里直接填写（`providersApi` 的 `apiKey` 字段），
// 模板概念一并下线。于是：页面、菜单、本段取数层、上游移植页、t195 探针全部删除。
//
// ⚠ 服务端仍保留 `/admin/secrets`（加密落盘/掩码回显/密钥使用审计的回归网在用，见 t34 A 段），
//   但管理台没有再封装它的客户端 —— 有页面才需要客户端，没页面还留着封装只会让人以为还有入口。

// ── ask-assistant-ui 对话组件库需要的其余取数件（mock / 兼容实现） ────────────

/** 上游对话输入可选挂 MCP 工具；本仓 MCP 尚未到接入阶段 ⇒ 恒空列表（入口自然收起） */
export interface McpServer {
  id: string;
  name: string;
  /** mcp-selector 会读这三个字段渲染卡片；本仓恒空 ⇒ 渲染为占位（不编造） */
  description?: string | null;
  icon?: string | null;
  tools?: Array<{ id?: string; name: string; description?: string | null }>;
  type: McpServerType;
}

export type McpServerType = "stdio" | "sse";

export function useMcpServersAllQuery() {
  return { data: [] as McpServer[], isLoading: false, refetch: () => {} };
}
export function useMcpServerQuickMenuQuery() {
  return { data: [] as McpServer[], isLoading: false, refetch: () => {} };
}

/** ⚠️ mock：用户反馈（点赞/点踩）未接后端 */
export function useCreateFeedbackMutation() {
  return useSimpleMutation(async (_args: { messageId: string; feedback: string }) => {
    throw new Error("用户反馈尚未接入本仓后端（mock 阶段）。");
  });
}

/** 会员等级（上游商业化）；内部部署恒返回空 */
export function useMembershipLevelsQuery() {
  return { data: [] as Array<{ id: string; name: string }>, isLoading: false, refetch: () => {} };
}

// ── 会话消息（对话组件库的分页回放；真实现走 data.tsx 的 KB 对话面） ──────────

export interface MessageRecord {
  id: string;
  role: "user" | "assistant";
  content: string;
  usage?: { model?: string; inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  createdAt?: string;
}

export async function getConversationInfo(datasetId: string, conversationId: string): Promise<KbConversation> {
  return getDatasetsConversationInfo(datasetId, conversationId);
}

export async function getConversationMessages(
  datasetId: string,
  conversationId: string,
  _opts?: { page?: number },
): Promise<{ items: MessageRecord[]; total: number }> {
  return getDatasetsConversationMessages(datasetId, conversationId);
}

export function useConversationMessagesQuery(datasetId?: string, conversationId?: string) {
  return useQuery({
    queryKey: ["datasets", datasetId ?? "", "conversation-messages", conversationId ?? ""],
    queryFn: () => getConversationMessages(datasetId ?? "", conversationId ?? ""),
    enabled: Boolean(datasetId && conversationId),
  });
}

// ── 数据集编辑（用户侧 datasets 页）：接真（PATCH /v1/kb/datasets/:id，服务端既有端点）──

export async function updateDataset(id: string | number, payload: Record<string, unknown>): Promise<void> {
  await http.patch(`/v1/kb/datasets/${id}`, payload, KB_AUTH);
}

export * from "./login";
