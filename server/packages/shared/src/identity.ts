/**
 * 身份契约（服务端↔桌面端↔管理台共享，第 1 批身份底座）。
 *
 * 与 packages/server/src/identity/{users,auth,routes}.ts 的对外载荷一一对应：
 *  - 登录/刷新返回 { accessToken, refreshToken }（令牌只在受信任进程持有，不进渲染层）
 *  - /me 返回 { user: PublicUser, scope }
 * 桌面端主进程用本契约做 IPC 回传（只回 user/scope，不回令牌）。
 */

import type { AuditPolicyMode } from "./audit.js";
import type { SessionType, ThinkingLevel } from "./session.js";

export const IDENTITY_ROLES = ["platform_admin", "dept_head", "user"] as const;
export type Role = (typeof IDENTITY_ROLES)[number];

export type UserSource = "ad" | "local";
export type UserStatus = "active" | "disabled";

export interface PublicUser {
  id: number;
  uid: string;
  name: string;
  email: string | null;
  role: Role;
  source: UserSource;
  status: UserStatus;
  dept: { id: number; path: string } | null;
  syncedAt: string | null;
}

/** 数据范围：全公司 / 本部门及子部门 / 仅本人 */
export type AuthScope =
  | { kind: "all" }
  | { kind: "dept"; path: string }
  | { kind: "self" };

export interface AuthSession {
  user: PublicUser;
  scope: AuthScope;
}

/** 服务器地址信息（桌面端可配置，Docker 部署换地址） */
export interface AuthServerInfo {
  baseUrl: string;
  configured: boolean;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export const ROLE_LABELS: Record<Role, string> = {
  platform_admin: "平台管理员",
  dept_head: "部门负责人",
  user: "普通用户",
};

/**
 * Agent 数字人定义（A-2 `/me/agents` 下发载荷；桌面端新建会话时应用）。
 *
 * v1 起 `/me/agents` 语义 = **专家市场目录**（可见且已上架 + 当前登录者的安装/收藏关系），
 * 因此本载荷同时携带市场卡片字段与预设包字段。
 *
 * 新增字段一律可选：`<userData>/agents.json` 是跨版本本地缓存，字段缺失必须能读旧文件
 * （见 `client/electron/agents-sync.ts` 的宽松 normalize）。
 */
export interface AgentDefinition {
  name: string;
  title: string;
  description: string | null;
  emoji: string | null;
  /** 追加到系统提示的人设 */
  persona: string | null;
  provider: string | null;
  modelId: string | null;
  /** 技能白名单（空 = 不限制） */
  skills: string[];

  /* ===== v1 市场字段（卡片渲染 + 筛选排序）===== */
  id?: number;
  tags?: string[];
  /**
   * 分类 code（对应 `agent_categories.code`）。
   * **不是**联合类型：分类是后台可维护的数据，客户端不得内置任何码表 ——
   * 未收录到字典的 code 一律归入「未分类」展示（见 lib/agent-market.ts）。
   */
  category?: string | null;
  /** 官方 / 特邀认证（对应卡片「特邀专家」徽标） */
  official?: boolean;
  /** 卡片作者（展示名，非 uid） */
  author?: string | null;
  /** 安装量（`agent_installs` 计数；不是冗余列，避免计数漂移） */
  hot?: number;
  /** 使用量（`agent_usage` 的会话计数；「最热」排序用它，与安装量分开） */
  uses?: number;
  publishedAt?: string | null;
  updatedAt?: string | null;
  /** 上架开关（false 只在管理台可见） */
  enabled?: boolean;

  /* ===== v1 预设包（D2：建会话时客户端预置，用户可改）===== */
  sessionType?: SessionType | null;
  policyMode?: AuditPolicyMode | null;
  thinkingLevel?: ThinkingLevel | null;
  /** 推荐开场白 */
  starters?: string[];

  /* ===== v1 当前登录者的关系（由 /me/agents 计算，非 agents 表列）===== */
  installed?: boolean;
  /** 已安装且启用；首页专家选择器只列 `installed && installEnabled` 的专家 */
  installEnabled?: boolean;
  favorited?: boolean;
}

export interface AgentsState {
  agents: AgentDefinition[];
  /** 服务端不可达/未登录（返回本地缓存） */
  offline: boolean;
  updatedAt: string | null;
}
