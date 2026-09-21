/**
 * 专家市场（Agent 专家）契约 —— 服务端 / 桌面端 / 管理台三端共用。
 *
 * 命名与 `skills.ts`（技能商城契约）**刻意对称**：`author` = 卡片作者；
 * `hot` = 安装量（`agent_installs` 计数）；`uses` = 使用量（`agent_usage` 会话计数）。
 * 两处市场若命名分叉，前端筛选与后端 SQL 会各写一份口径。
 *
 * ⚠ 分类与标签**不是代码常量**（用户 2026-09-14 拍板）：
 * 它们是后台可维护的数据（`agent_categories` / `agent_tags` 两表），
 * 所以本文件只定义「一条分类/标签长什么样」，不定义「有哪些分类/标签」。
 * 历史教训：把分类码表写进代码，会导致「加一个分类要改三处代码 + 发版」，
 * 而运营口径（尤其是本平台真的需要「办公协同 / 编码开发」这类）一定会变。
 *
 * 与 `identity.ts` 的 `AgentDefinition` 的关系：
 *  - 本文件 = **市场面**（字典、卡片附加指标、排序、写操作返回）
 *  - `AgentDefinition` = **下发面**（市场字段 + persona/model/skills，建会话时应用）
 */

import type { AuditPolicyMode } from "./audit.js";
import type { SessionType, ThinkingLevel } from "./session.js";

/** 分类 / 标签的稳定标识规范（与专家 slug 同规范：小写字母/数字/连字符） */
export const AGENT_CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 卡片与字典字段上限（服务端校验 + 客户端截断展示共用同一组常量） */
export const AGENT_LIMITS = {
  /** 每个专家最多几个标签 */
  tags: 10,
  codeChars: 32,
  labelChars: 24,
  emojiChars: 8,
  titleChars: 120,
  descChars: 500,
  authorChars: 64,
  /** 推荐开场白（D2）：条数与单条长度 */
  starters: 6,
  starterChars: 200,
} as const;

/** 一条分类（后台可增改；code 创建后不可改，label 随时改） */
export interface AgentCategoryItem {
  code: string;
  label: string;
  /** 后台排序（越小越前） */
  sort: number;
  /** 停用：新专家不可再选，存量专家不受影响（所以「卸载分类」用停用而不是删除） */
  enabled: boolean;
  /** 当前有多少专家在用（管理台展示；删除被拒时告诉管理员「谁在用」） */
  agentCount?: number;
}

/** 一条标签（后台可增改的受控词表；专家只能从库里选） */
export interface AgentTagItem {
  name: string;
  sort: number;
  enabled: boolean;
  agentCount?: number;
}

/**
 * 市场字典：分类 + 标签。
 * 一次取回（量级是几十条），客户端据此渲染 chips 与筛选；
 * **筛选条件永远用 code/name**，展示层才查 label（改名不影响任何存值）。
 */
export interface AgentTaxonomy {
  categories: AgentCategoryItem[];
  tags: AgentTagItem[];
}

/** 排序口径（对齐界面「综合 / 最热 / 最新」） */
export type AgentSort = "recommend" | "hot" | "new";

/** 安装 / 卸载 / 启停 / 收藏的统一返回（对齐 `SkillMutationResult`） */
export interface AgentMutationResult {
  ok: true;
  /** 本次受影响的专家名（安装/卸载/收藏的目标） */
  affected: string[];
}

/**
 * 专家预设包（D2）：新建会话时由客户端预置、用户仍可在首页改。
 * 全部可为 null —— 表示"该专家不指定，跟随用户/会话默认"。
 */
export interface AgentPreset {
  sessionType: SessionType | null;
  policyMode: AuditPolicyMode | null;
  thinkingLevel: ThinkingLevel | null;
  /** 推荐开场白（首页「场景 pill」数据源） */
  starters: string[];
}

/** 「我的专家」筛选来源（D6 不开放个人自建，故无 "mine"） */
export type AgentScopeFilter = "market" | "installed" | "favorite";
