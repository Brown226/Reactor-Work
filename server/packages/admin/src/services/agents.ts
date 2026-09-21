// Reactor 管理台 · Agent 数字人服务（A-1 管理面 / v1 市场面 + 字典维护）
// 契约对齐 packages/server/src/agents/routes.ts（/admin/agents*、/admin/agent-categories*、
// /admin/agent-tags*）。
//
// 契约真源：packages/shared/src/agents.ts 与 packages/shared/src/session.ts。
// 本包不依赖 @reactor/shared（保持独立构建，同 services/audit.ts）——
// 所以下面的枚举是**拷贝**，改名时必须两边一起改。

import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "./identity";
import type { SkillScopeKind } from "./skills";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

/* ==================== 字典（分类 / 标签库）==================== */
/*
 * 分类与标签**不是代码常量**，是后台可维护的数据（用户 2026-09-14 拍板）。
 * 因此这里不导出任何 AGENT_CATEGORIES 常量，只导出「怎么读写字典」。
 */

/** 分类标识规范（真源 shared/agents.ts 的 AGENT_CODE_PATTERN） */
export const AGENT_CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 字典字段上限（真源 shared/agents.ts 的 AGENT_LIMITS） */
export const AGENT_LIMITS = {
  tags: 10,
  codeChars: 32,
  labelChars: 24,
  emojiChars: 8,
  starters: 6,
  starterChars: 200,
} as const;

/** 一条分类（code 稳定不可改，label 随时改） */
export interface AgentCategoryItem {
  code: string;
  label: string;
  sort: number;
  enabled: boolean;
  /** 有多少专家在用（删除被拒时提示用） */
  agentCount?: number;
}

/** 一条标签（受控词表，name 即展示值） */
export interface AgentTagItem {
  name: string;
  sort: number;
  enabled: boolean;
  agentCount?: number;
}

export interface AgentTaxonomy {
  categories: AgentCategoryItem[];
  tags: AgentTagItem[];
}

/* ==================== 预设包枚举（真源在 shared）==================== */

/** 会话类型（真源 shared/session.ts 的 SESSION_TYPES） */
export type AgentSessionType = "code" | "work" | "general";
/** 权限模式（真源 shared/audit.ts 的 AuditPolicyMode） */
export type AgentPolicyMode = "readonly" | "balanced" | "trust" | "strict";
/** 思考级别（真源 shared/session.ts 的 THINKING_LEVELS） */
export type AgentThinkingLevel = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const AGENT_SESSION_TYPE_LABELS: Record<AgentSessionType, string> = {
  code: "编码",
  work: "办公",
  general: "通用",
};
export const AGENT_POLICY_MODE_LABELS: Record<AgentPolicyMode, string> = {
  readonly: "只读",
  balanced: "均衡",
  trust: "信任",
  strict: "严格",
};
export const AGENT_THINKING_LEVELS: readonly AgentThinkingLevel[] = [
  "auto",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/* ==================== Agent ==================== */

export interface AgentScope {
  kind: SkillScopeKind;
  roles: Array<"platform_admin" | "dept_head" | "user">;
  deptIds: number[];
  uids: string[];
}

export interface AdminAgent {
  id: number;
  name: string;
  title: string;
  description: string | null;
  emoji: string | null;
  persona: string | null;
  provider: string | null;
  modelId: string | null;
  skills: string[];
  /* v1 市场字段 */
  tags: string[];
  /** 分类 code；null = 未分类 */
  category: string | null;
  official: boolean;
  author: string | null;
  publishedAt: string | null;
  /* v1 预设包 */
  preset: {
    sessionType: AgentSessionType | null;
    policyMode: AgentPolicyMode | null;
    thinkingLevel: AgentThinkingLevel | null;
    starters: string[];
  };
  scope: AgentScope;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AgentInput {
  name: string;
  title: string;
  description?: string | null;
  emoji?: string | null;
  persona?: string | null;
  provider?: string | null;
  modelId?: string | null;
  skills?: string[];
  /** 标签名（必须在标签库中） */
  tags?: string[];
  /** 分类 code（必须在分类表中；null = 未分类） */
  category?: string | null;
  official?: boolean;
  author?: string | null;
  /** 上架开关（true → 服务端写 now）；新建不传 = 草稿 */
  published?: boolean;
  sessionType?: AgentSessionType | null;
  policyMode?: AgentPolicyMode | null;
  thinkingLevel?: AgentThinkingLevel | null;
  starters?: string[];
  scope: AgentScope;
  enabled?: boolean;
}

export const agentsApi = {
  list: () => http.get<{ agents: AdminAgent[] }>("/admin/agents", AUTH),
  create: (body: AgentInput) => http.post<{ agent: AdminAgent }>("/admin/agents", body, AUTH),
  patch: (id: number, body: Partial<Omit<AgentInput, "name">>) =>
    http.patch<{ agent: AdminAgent }>(`/admin/agents/${id}`, body, AUTH),
  remove: (id: number) => http.delete<{ ok: boolean }>(`/admin/agents/${id}`, AUTH),
};

/* ==================== 字典 API ==================== */

export const agentTaxonomyApi = {
  /** 全量（含停用项 + 引用数）——管理台专用；市场侧走 /me/agent-taxonomy（只启用项） */
  list: () => http.get<AgentTaxonomy>("/admin/agent-taxonomy", AUTH),

  createCategory: (body: { code: string; label: string; sort?: number; enabled?: boolean }) =>
    http.post<{ category: AgentCategoryItem }>("/admin/agent-categories", body, AUTH),
  patchCategory: (code: string, body: { label?: string; sort?: number; enabled?: boolean }) =>
    http.patch<{ category: AgentCategoryItem }>(`/admin/agent-categories/${encodeURIComponent(code)}`, body, AUTH),
  removeCategory: (code: string) =>
    http.delete<{ ok: boolean }>(`/admin/agent-categories/${encodeURIComponent(code)}`, AUTH),

  createTag: (body: { name: string; sort?: number; enabled?: boolean }) =>
    http.post<{ tag: AgentTagItem }>("/admin/agent-tags", body, AUTH),
  patchTag: (name: string, body: { sort?: number; enabled?: boolean }) =>
    http.patch<{ tag: AgentTagItem }>(`/admin/agent-tags/${encodeURIComponent(name)}`, body, AUTH),
  removeTag: (name: string) => http.delete<{ ok: boolean }>(`/admin/agent-tags/${encodeURIComponent(name)}`, AUTH),
};
