// Reactor 管理台 · Skills 技能库服务（S-1/S-3）
// 契约对齐 packages/server/src/skills/routes.ts（/admin/skills、/admin/bundles，platform_admin 专用）。
//
// 元数据字段（分类/图标/标签/作者/精选/权重/默认安装）的**语义真源**在
// packages/shared/src/skills.ts：admin 是独立构建、不依赖 @reactor/shared，
// 所以这里镜像一份类型与常量（改契约时两处都要动）。

import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "./identity";
import type { Role } from "../types";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

export type SkillScopeKind = "all" | "role" | "dept" | "user";

export interface SkillScope {
  kind: SkillScopeKind;
  roles: Role[];
  deptIds: number[];
  uids: string[];
}

/**
 * 技能分类（**契约真源：packages/shared/src/skills.ts 的 SKILL_CATEGORIES**）。
 *
 * 产品已拍板收敛为 5 类：早期 11 类在窄栏里 chips 挤两行、且多数类目长期为空，
 * 细分需求改由标签（tags）承载。列表必须与桌面端 chips 逐个一致，否则会出现
 * "管理台能选、用户端筛不到"的幽灵分类。
 */
export const SKILL_CATEGORIES = ["office", "dev", "data", "content", "other"] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export const SKILL_CATEGORY_LABELS: Record<SkillCategory, string> = {
  office: "办公协同",
  dev: "开发工具",
  data: "数据分析",
  content: "内容创作",
  other: "其他",
};

/** 字段上限（**契约真源：shared 的 SKILL_LIMITS**，与服务端校验保持一致，避免"填完才报错"） */
export const SKILL_LIMITS = { tags: 10, tagChars: 24, iconChars: 8, titleChars: 120, descChars: 500, weight: 100 } as const;

export interface AdminSkill {
  id: number;
  name: string;
  title: string;
  description: string | null;
  content: string;
  version: string;
  enabled: boolean;
  scope: SkillScope;
  // —— 技能市场元数据（frontmatter 优先、后台覆盖）——
  icon: string | null;
  category: SkillCategory;
  tags: string[];
  author: string | null;
  /** 是否进「精选技能」位（首页曝光） */
  featured: boolean;
  /** 换一换的加权（0-100，越大越容易被抽到） */
  weight: number;
  /** 默认安装：新用户开箱即用（无需自己去市场点安装） */
  autoInstall: boolean;
  /** 声明"不自动调用"：仍可被斜杠面板显式调用，但不进模型自动选技能的范围 */
  disableModelInvocation: boolean;
  /** 被后台人工覆盖过的字段（`parse` 不会覆盖它们；`clearOverride` 才交还给 frontmatter） */
  overriddenFields: string[];
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SkillInput {
  name: string;
  title: string;
  description?: string | null;
  content: string;
  version?: string;
  enabled?: boolean;
  scope: SkillScope;
  icon?: string | null;
  category?: SkillCategory;
  tags?: string[];
  author?: string | null;
  featured?: boolean;
  weight?: number;
  autoInstall?: boolean;
}

export interface AdminBundle {
  id: number;
  name: string;
  title: string;
  description: string | null;
  icon: string | null;
  enabled: boolean;
  scope: SkillScope;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** 成员技能标识（后端随列表一起回，省一次查询） */
  members?: string[];
}

export interface BundleInput {
  name: string;
  title: string;
  description?: string | null;
  icon?: string | null;
  enabled?: boolean;
  scope: SkillScope;
  /** 成员技能标识（至少 1 个；后端会校验存在性） */
  members: string[];
}

/** 受众预估（管理台「这个技能到底发给谁」） */
export interface SkillAudience {
  scope: SkillScope;
  enabled: boolean;
  autoInstall: boolean;
  visibleUsers: number;
  installedUsers: number;
}

export const skillsApi = {
  list: () => http.get<{ skills: AdminSkill[] }>("/admin/skills", AUTH),
  create: (body: SkillInput) => http.post<{ skill: AdminSkill }>("/admin/skills", body, AUTH),
  patch: (id: number, body: Partial<Omit<SkillInput, "name">>) =>
    http.patch<{ skill: AdminSkill }>(`/admin/skills/${id}`, body, AUTH),
  remove: (id: number) => http.delete<{ ok: boolean }>(`/admin/skills/${id}`, AUTH),
  /**
   * 受众预估：可见人数 / 已安装人数。
   * 口径与服务端 `visibilitySql` 逐条对齐（dept 是**精确匹配**、不展开子树）——
   * 数字必须与真实下发一致，否则比不显示更糟。
   */
  audience: (id: number) => http.get<SkillAudience>(`/admin/skills/${id}/audience`, AUTH),
  /**
   * 从 SKILL.md 的 frontmatter **重解析**元数据。
   * 已被人工覆盖的字段不动（这是「后台覆盖优先」的关键：重解析不该把人工修正冲掉），
   * 想交还 frontmatter 必须先 `clearOverride`。
   */
  parse: (id: number) => http.post<{ skill: AdminSkill }>(`/admin/skills/${id}/parse`, {}, AUTH),
  /**
   * 清除覆盖标记，此后这些字段重新由 frontmatter 决定。
   * `fields` **必须非空**（服务端对空数组返 400）—— “什么都不清的清覆盖”是调用方的 bug，
   * 不要静默当成“清全部”，否则一次误点就会把整个人工修正抹掉。
   */
  clearOverride: (id: number, fields: string[]) =>
    http.post<{ skill: AdminSkill }>(`/admin/skills/${id}/clear-override`, { fields }, AUTH),
};

/**
 * 分类字典（**服务端为真源**）。
 *
 * 注意：`SKILL_CATEGORIES` 仍保留在管理台（服务端校验、下拉兜底），但**文案与顺序以接口为准** ——
 * 运营改完名/顺序后，管理台与桌面端两边显示必须一致，不能各持一份镜像常量。
 */
export interface SkillCategoryRow {
  code: string;
  label: string;
  sort: number;
  enabled: boolean;
  skillCount?: number;
}

export const skillCategoriesApi = {
  list: () => http.get<{ categories: SkillCategoryRow[] }>("/admin/skill-categories", AUTH),
  patch: (code: string, body: { label?: string; sort?: number; enabled?: boolean }) =>
    http.patch<{ category: SkillCategoryRow }>(`/admin/skill-categories/${encodeURIComponent(code)}`, body, AUTH),
};

/** 技能附属文件（多文件技能）：清单只含 path/size/sha，内容按需拉 */
export interface SkillFileMeta {
  path: string;
  size: number;
  sha256: string;
  executable?: boolean;
}

/** 上传项：文本用 content、二进制用 contentB64 */
export interface SkillFileUpload {
  path: string;
  content?: string;
  contentB64?: string;
  executable?: boolean;
}

export const skillFilesApi = {
  list: (skillId: number) => http.get<{ files: SkillFileMeta[] }>(`/admin/skills/${skillId}/files`, AUTH),
  /** 批量替换（整目录导入）：服务端先全量校验再落库，任何一项越界都整批拒绝 */
  replace: (skillId: number, files: SkillFileUpload[]) =>
    http.put<{ ok: boolean; files: SkillFileMeta[] }>(`/admin/skills/${skillId}/files`, { files }, AUTH),
};

export const bundlesApi = {
  list: () => http.get<{ bundles: AdminBundle[] }>("/admin/bundles", AUTH),
  create: (body: BundleInput) => http.post<{ bundle: AdminBundle; members: string[] }>("/admin/bundles", body, AUTH),
  patch: (id: number, body: Partial<Omit<BundleInput, "name">>) =>
    http.patch<{ bundle: AdminBundle; members: string[] }>(`/admin/bundles/${id}`, body, AUTH),
  remove: (id: number) => http.delete<{ ok: boolean }>(`/admin/bundles/${id}`, AUTH),
};
