/**
 * 审计与用量契约（G0 治理数据面）：端侧采集 → 服务端落库 → 查询/聚合。
 *
 * 红线（BRD **NFR-P-01：正文不落服务端**）：本契约只承载**结构化元数据 + 用量计数**，
 * 不含任何提示词/回复/工具输出正文。`summary` 仅允许短标签（工具名、状态等），
 * 服务端对其长度有硬校验——**不要往里塞会话内容**。
 *
 * 归属口径：事件里的 `uid`/`deptId` **由服务端按令牌写入**，请求体不需要也不允许指定；
 * 端侧只描述「发生了什么」。
 */

/** 事件动作类别。 */
export type AuditActionKind =
  | "model_call" // 一次模型调用（通常带 usage）
  | "tool_call" // 一次工具执行
  | "approval" // 审批结论（allow/deny）
  | "policy_block" // 策略/权限边界拦截（如 readonly 拦写、黑名单命令）
  | "session" // 会话生命周期（新建/结束/分支）
  | "admin_action" // 管理台敏感操作（密钥查看/新增/修改/删除、连通性测试）
  | "auth"; // 登录/登出/续签

/** 事件结果。 */
export type AuditOutcome = "ok" | "error" | "denied" | "cancelled";

/** 审批结论（对应 sidecar 审批闸门）。 */
export type AuditApprovalDecision = "allow" | "deny" | "ask" | "forbidden";

/**
 * 访问模式：与桌面端 `zcodeTaskMode` **同一词表**（plan / build / edit / yolo）。
 *
 * 历史：改造前是 `readonly/balanced/trust/strict`（旧 standalone 项目的词表）。桌面端不接受旧词，
 * 因此**只写新值**；库里可能残留旧值，读时用 `normalizeAuditPolicyMode` 映射
 * （readonly→plan · strict→edit · balanced→build · trust→yolo），见
 * docs/服务端接线-P4-用量上报与策略.md 的 D2。
 */
export type AuditPolicyMode = "plan" | "build" | "edit" | "yolo";

export const AUDIT_POLICY_MODES: readonly AuditPolicyMode[] = ["plan", "build", "edit", "yolo"];

/** 旧词表 → 新词表（只用于读，不用于写）。 */
export const LEGACY_POLICY_MODE_MAP: Readonly<Record<string, AuditPolicyMode>> = {
  readonly: "plan",
  strict: "edit",
  balanced: "build",
  trust: "yolo",
};

/** 归一化访问模式：新词直接通过，旧词映射，其余返回 null（调用方决定报错或回落默认）。 */
export function normalizeAuditPolicyMode(value: unknown): AuditPolicyMode | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if ((AUDIT_POLICY_MODES as readonly string[]).includes(trimmed)) {
    return trimmed as AuditPolicyMode;
  }
  return LEGACY_POLICY_MODE_MAP[trimmed] ?? null;
}

/** 会话场景（对应 SESSION_TOOL_PRESETS 的场景边界）。 */
export type AuditSessionType = "code" | "work" | "general" | "unknown";

/** 用量分项（与 pi 的 usage 对齐；缺省字段视为 0）。 */
export interface AuditUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 命中缓存的输入 tokens（缓存价远低于正价，计量必须分项） */
  cacheReadTokens?: number;
  /** 写入缓存 tokens */
  cacheWriteTokens?: number;
  totalTokens?: number;
  /**
   * 费用。**落库时以服务端核算为准**：服务端按模型四段价（input/output/cacheRead/cacheWrite）
   * 与本次 token 分项算出；该模型没有配价目时，才回落到端侧上报值（并用 `costSource` 标记来源）。
   * 端侧上报此字段仍有用——它是无价目配置时的兜底，也是与服务端核算结果的对照。
   */
  cost?: number;
  /** 缺省 CNY */
  currency?: string;
  model?: string;
  provider?: string;
}

/** 端侧上报的单条事件。 */
export interface AuditEventInput {
  /** 端侧生成的幂等键（离线重传不会重复入库） */
  eventId: string;
  /** 事件发生时间（ISO8601）；服务端校验不得过于超前 */
  ts: string;
  sessionId?: string;
  sessionType?: AuditSessionType;
  action: AuditActionKind;
  toolName?: string;
  /**
   * 操作对象标识（`admin_action` 用）：如 `secrets:3`、`providers:tokenrhythm`。
   * 端侧无需填写；管理台敏感操作由**服务端**写入。
   */
  target?: string;
  outcome?: AuditOutcome;
  approvalDecision?: AuditApprovalDecision;
  policyMode?: AuditPolicyMode;
  durationMs?: number;
  errorCode?: string;
  /** 短摘要（≤200 字，**不得含会话正文**） */
  summary?: string;
  /** 涉及文件数（只报数量，不报路径，避免路径泄露） */
  filesTouched?: number;
  usage?: AuditUsage;
}

/** 批量上报请求（一次 ≤ MAX_AUDIT_BATCH 条）。 */
export interface AuditBatchRequest {
  /** 端侧批次号（排查用，不参与幂等） */
  batchId?: string;
  events: AuditEventInput[];
}

/** 批量上报结果。 */
export interface AuditBatchResponse {
  accepted: number;
  duplicates: number;
  rejected: Array<{ eventId: string; reason: string }>;
}

export const MAX_AUDIT_BATCH = 500;
export const MAX_AUDIT_SUMMARY_CHARS = 200;

/** 服务端返回的事件（含服务端写入的归属与接收时间）。 */
export interface AuditEventRecord extends AuditEventInput {
  id: number;
  uid: string;
  /** 部门为**写入时快照**：用户之后调岗不影响历史统计的准确性 */
  deptId: number | null;
  deptPath: string | null;
  /** 服务端核算的费用（= usage.cost） */
  cost?: number;
  /** 端侧上报的费用（对照用） */
  costReported?: number;
  /** 费用来源：server=服务端按四段价核算；client=无量价配置，回落端侧上报 */
  costSource?: "server" | "client" | null;
  receivedAt: string;
}

export interface AuditQueryResponse {
  events: AuditEventRecord[];
  total: number;
  limit: number;
  offset: number;
}

/** 用量聚合分组口径。 */
export type UsageGroupBy = "dept" | "model" | "user" | "day";

export interface UsageSummaryRow {
  /** 分组键：部门路径 / 模型名 / uid / 日期（YYYY-MM-DD） */
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export interface UsageSummaryResponse {
  groupBy: UsageGroupBy;
  from: string;
  to: string;
  rows: UsageSummaryRow[];
  totals: UsageSummaryRow;
}

/** 组织级下发策略（M11-04 的可配形态；原先是写死值）。 */
export interface DesktopPolicy {
  /** 默认访问模式（用户在客户端可覆盖到不超过该天花板） */
  defaultApprovalMode: AuditPolicyMode;
  /** 命令黑名单（子串/正则由端侧引擎解释，服务端只存） */
  commandBlacklist: string[];
  /** 出网白名单（域名后缀） */
  egressAllowlist: string[];
  /** 额度：月度 token 上限与告警阈值（百分比）；null = 不限 */
  quota: {
    monthlyTokenLimit: number | null;
    alertThresholds: number[];
  };
  updatedAt?: string;
  updatedBy?: string;
}

export interface DesktopPolicyResponse {
  policy: DesktopPolicy;
}
