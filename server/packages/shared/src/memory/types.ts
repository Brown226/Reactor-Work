/**
 * 记忆层契约（W4-②）—— 三存储（episodic / semantic / procedural）。
 *
 * 设计来源：LeAgent `memory/types.py`（Apache-2.0）。**只取数据结构与算法，不取存储实现**：
 * LeAgent 用 SQL + 可选 Milvus；Reactor 是桌面单机，落 JSONL（真源）+ 内存索引。
 * 这正是 LeAgent 自己主张的「SQL 是真源、向量可选」在无 SQLite 依赖场景下的等价形态。
 *
 * 三种记忆的分工（不要混）：
 *  - **episodic**：「发生过什么」——一轮对话的摘要。数量最多、价值最低、衰减最快。
 *  - **semantic**：「事实是什么」——用户偏好/约定。稳定、高置信、可折叠掉同内容 episode。
 *  - **procedural**：「怎么做事」——带工具的成功流程。按 `successRate` 加权，失败多了自动降权。
 */

/** 记忆种类 */
export type MemoryKind = "episodic" | "semantic" | "procedural";

/** 记忆的归属维度（召回时用于隔离；子 agent 不共享用户记忆是产品决策） */
export interface MemoryScope {
  readonly userId?: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
}

/** 一轮对话的摘要（episodic） */
export interface Episode extends MemoryScope {
  readonly id: string;
  /** 摘要正文（由 `buildEpisodeSummary` 产出，≤1200 字） */
  readonly summary: string;
  /**
   * 原文转录（**自动 formation 时通常为空**）。
   *
   * 照 LeAgent：`build_episode_summary` 只填 summary，要查原文得回 session store。
   * 保留该字段是为了「显式收藏某轮」这类手动路径，不要让自动路径往里塞全文
   * —— 那会让记忆库体积爆炸。
   */
  readonly transcript?: string;
  readonly tags: readonly string[];
  readonly importance: number;
  readonly tokenCount?: number;
  readonly recallCount: number;
  readonly lastRecalledAt?: string;
  readonly createdAt: string;
}

/** 一条事实（semantic） */
export interface Fact extends MemoryScope {
  readonly id: string;
  /** 事实键（如 `ui.language`）；同一 scope 下同键覆盖 */
  readonly key: string;
  readonly value: string;
  readonly confidence: number;
  readonly source?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

/** 一个流程（procedural） */
export interface Procedure extends MemoryScope {
  readonly id: string;
  readonly name: string;
  /** 确定性指纹（`buildProcedureSignature`）；同指纹视为同一流程并累加 runCount */
  readonly signature: string;
  readonly description: string;
  readonly runCount: number;
  readonly successCount: number;
  readonly lastOutcome?: string;
  readonly lastError?: string;
  readonly lastDurationMs?: number;
  readonly lastRunAt?: string;
  readonly createdAt: string;
}

/** 召回条目（三库统一视图；`score` 是**原始**分，boost 后分数见 `applyBoosts`） */
export interface RecallEntry {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly score: number;
  readonly sourceId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** 一次召回的完整结果 */
export interface RecallBundle {
  readonly query: string;
  readonly entries: readonly RecallEntry[];
  readonly episodes: readonly Episode[];
  readonly facts: readonly Fact[];
  readonly procedures: readonly Procedure[];
}

/** 空 bundle（召回失败/超时/无命中时的**唯一**合法降级产物） */
export function emptyRecallBundle(query: string): RecallBundle {
  return { query, entries: [], episodes: [], facts: [], procedures: [] };
}

// ---------------------------------------------------------------------------
// 常量（照 LeAgent）
// ---------------------------------------------------------------------------

/** 单库召回条数上限 */
export const DEFAULT_LIMIT_PER_STORE = 4;

/** 总召回条数上限（渲染进 prompt 的硬顶） */
export const DEFAULT_TOTAL_LIMIT = 8;

/** 时间衰减半衰期（天）—— 14 天前的东西权重减半 */
export const RECENCY_HALF_LIFE_DAYS = 14;

/** 渲染 `<attachment kind="recall">` 时每条最多多少行 */
export const RECALL_MAX_LINES = 16;

/** 近重折叠时截取的文本前缀长度 */
export const TEXT_SIGNATURE_PREFIX = 300;

/** `Procedure.successRate`：`runCount=0` 时为 0（不假设成功） */
export function successRate(procedure: Pick<Procedure, "runCount" | "successCount">): number {
  if (procedure.runCount <= 0) return 0;
  return clamp01(procedure.successCount / procedure.runCount);
}

/** 夹到 [0,1]（LeAgent 到处用，统一一个实现避免各写一份） */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 近重指纹：小写 + 去空白 + 截断（照 LeAgent `_text_signature`） */
export function textSignature(text: string): string {
  return (text ?? "").trim().toLowerCase().slice(0, TEXT_SIGNATURE_PREFIX);
}
