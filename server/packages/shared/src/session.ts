/**
 * Reactor 会话契约（BRD M2；M0-B1 分类型 + M0-B2 JSONL v3 读取/恢复）
 */

/** 会话显式分类型（FR-M2-02：Work 只暴露办公工具、Code 只暴露代码工具） */
export type SessionType = "code" | "work" | "general";

export const SESSION_TYPES: readonly SessionType[] = ["code", "work", "general"];

/**
 * 会话类型的**命名权威**（单一真源）。
 *
 * 为什么放共享层：此前「办公/编码/通用」这套名字在三处各写一遍
 * （`ChatView` 的徽标三元表达式、`EmptyState` 的 TYPES 数组、`WelcomeScenarios` 的场景卡），
 * 改一个名字要动四个文件，而且首页叫「日常办公」、会话徽标叫「办公」—— 同一个概念两套叫法。
 *
 * 这里只放 **i18n key**（不放文案）：文案属客户端词表层（`client/src/file-viewer/i18n.ts`），
 * 本层保持语言无关；图标也一样留在客户端（React 组件不进共享契约）。
 *
 * label = 短名（徽标 / 选择器按钮），desc = 一句话（首页选择器的说明行）。
 */
export const SESSION_TYPE_I18N: Record<SessionType, { label: string; description: string }> = {
  code: { label: "mode.code.label", description: "mode.code.desc" },
  work: { label: "mode.work.label", description: "mode.work.desc" },
  general: { label: "mode.general.label", description: "mode.general.desc" },
};

/**
 * 思考级别（内核取值）。与 `client/src/prefs.ts` 的 `ThinkingLevel` 是同一集合 ——
 * 那边是 UI 侧定义，这里是**服务端也要校验**的线上取值，所以放在共享契约里。
 * 待 sync：prefs.ts 可改为直接 re-export 本结，避免两处枚举分叉。
 */
export const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** 会话元数据（列表/侧栏数据源；会话正文以 Pi JSONL v3 文件为准） */
export interface SessionMeta {
  id: string;
  type: SessionType;
  name: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
  /** 工作区白名单根（添加即自动登记，FR-M7-01） */
  workspaceRoots: string[];
  /**
   * 解析后的项目根（清单 #15）：worktree 顶层折叠回主仓库根；
   * 分组与「空间」归并用它而不是原始 cwd。
   */
  projectRoot?: string;
  /** 项目分组键（Windows 大小写/分隔符归一，对齐 pi-web projectIdentityKey） */
  projectKey?: string;
  /** 所属 git 分支（worktree 展示用） */
  branch?: string;
  /** 该会话 cwd 是否为 linked worktree 顶层 */
  isWorktree?: boolean;
  /** fork 来源会话 id（JSONL 树形，仅展示元数据，M13） */
  parentSession?: string;
  /**
   * 建会话时绑定的专家名（slug；D3）。
   * 会话创建后不再变——换专家 = 派生新会话；徽标展示用 title/emoji 由客户端查专家目录。
   */
  agentName?: string;
  /** 会话 JSONL 文件绝对路径（M0-B2 建立 id→file 索引） */
  sessionFile?: string;
  messageCount?: number;
  firstMessage?: string;
}

/**
 * 会话 JSONL 条目对外摘要（Pi JSONL v3 真实格式：id/parentId/timestamp/type，
 * 见 pi-web AGENTS.md）。由 M0-B2 reader 有界读取 + 坏行容错后产出。
 */
export interface SessionEntrySummary {
  entryId: string;
  parentId: string | null;
  type: string;
  ts: number;
  role?: "user" | "assistant" | "toolResult";
  contentPreview?: string;
  /** message 条目的完整结构化 content（Pi blocks 数组，JSON 安全），供回放重建 */
  content?: unknown;
  /** toolResult 条目的关联调用 id */
  toolCallId?: string;
  /** toolResult 是否出错 */
  isError?: boolean;
  /** toolResult 的 details（patch/diff） */
  details?: unknown;
  /** assistant 消息信封字段（模型/用量/时间），回放消息头尾渲染用 */
  model?: string;
  provider?: string;
  usage?: unknown;
  timestamp?: number;
}
