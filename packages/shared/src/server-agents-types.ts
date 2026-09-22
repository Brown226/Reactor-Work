import type { AgentPermissionMode } from "./subagents-types.js";

/**
 * 企业服务端 Agent 下发契约（P3）——客户端侧唯一的 payload shape 与 normalize。
 *
 * 事实源：`server/packages/server/src/agents/repo.ts` 的 `toAgentPayload`（`AgentDefinition`）。
 * 不在 services 里手写第二份 shape：服务端加字段/改缺省时，必须在这里显式跟随，
 * 否则两端会静默漂移（与技能契约 `skills-types.ts` 同纪律）。
 * 字段映射正本见 docs/服务端接线-方案-v1.md §4.4；实施计划 docs/服务端接线-P3-Agent下发.md。
 */

/** 服务端 policyMode 词表（`server/packages/shared/src/audit.ts` 的 `AuditPolicyMode`）。 */
export type ServerAgentPolicyMode = "readonly" | "balanced" | "trust" | "strict";

/** 预设 sessionType（下发面带出；v1 不物化，留给「以此专家开会话」薄封装）。 */
export type ServerAgentSessionType = "code" | "work" | "general";

/** `/me/agents` 单条 payload（关系字段仅市场源有，管理面缺省 0/false，normalize 统一兜底）。 */
export interface ServerAgentDefinition {
  readonly id: number;
  readonly name: string;
  readonly title: string;
  readonly description: string | null;
  readonly emoji: string | null;
  readonly persona: string | null;
  /** 网关逻辑名——**禁止**字面写进 subagent frontmatter 的 `model`（§4.4）。 */
  readonly provider: string | null;
  readonly modelId: string | null;
  readonly skills: readonly string[];
  /* 市场字段：不进 markdown，UI 徽标用内存投影 */
  readonly tags: readonly string[];
  readonly category: string | null;
  readonly official: boolean;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly updatedAt: string | null;
  /** 定义级启用；false 时服务端已不放进 `/me/agents`，客户端不需要再判可见性。 */
  readonly enabled: boolean;
  readonly hot: number;
  readonly uses: number;
  /* 我的关系：物化目标集 = installed && installEnabled（§4.3） */
  readonly installed: boolean;
  readonly installEnabled: boolean;
  readonly favorited: boolean;
  /* 预设包：v1 只透传，不物化 */
  readonly sessionType: ServerAgentSessionType | null;
  readonly policyMode: ServerAgentPolicyMode | null;
  /** 服务端思考档位原样字符串；落盘时挂到 `modelSelection.options.reasoningLevel`。 */
  readonly thinkingLevel: string | null;
  readonly starters: readonly string[];
}

/** 写操作统一返回（对齐服务端 `AgentMutationResult`）。 */
export interface ServerAgentMutationResult {
  readonly ok: true;
  readonly affected: readonly string[];
  readonly created?: boolean;
  readonly enabled?: boolean;
  readonly favorited?: boolean;
}

/** 与服务端 `AGENT_NAME_PATTERN`/`AGENT_NAME_MAX` 同口径：先校验再当文件名（防线 1）。 */
const SERVER_AGENT_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 该 name 能否安全物化为 `<name>.md`（2-64 字符、小写字母/数字/连字符且不连续）。 */
export function isServerAgentNameFileSafe(name: string): boolean {
  return name.length >= 2 && name.length <= 64 && SERVER_AGENT_NAME_PATTERN.test(name);
}

/**
 * `policyMode` → subagent `permissionMode` 降级映射（§4.4，**不可逆**）：
 * subagent 词表只有 `auto`/`plan` 两档（`subagents-types.ts`），与会话四档是两回事。
 * 未指定（null）→ undefined = frontmatter 不写，跟随运行时默认。
 */
export function mapServerAgentPolicyMode(
  mode: ServerAgentPolicyMode | null | undefined,
): AgentPermissionMode | undefined {
  if (mode === "readonly" || mode === "strict") return "plan";
  if (mode === "balanced" || mode === "trust") return "auto";
  return undefined;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asPolicyMode(value: unknown): ServerAgentPolicyMode | null {
  return value === "readonly" || value === "balanced" || value === "trust" || value === "strict"
    ? value
    : null;
}

function asSessionType(value: unknown): ServerAgentSessionType | null {
  return value === "code" || value === "work" || value === "general" ? value : null;
}

/**
 * 归一化一条 payload；**非法 name 直接丢弃整条**（宁可少一个专家，也不写坏文件名），
 * 旧响应缺字段按 0/false/[]/null 兜底（容旧缓存，不抛错）。
 */
export function normalizeServerAgentDefinition(raw: unknown): ServerAgentDefinition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const id = item.id;
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  const name = asString(item.name)?.trim() ?? "";
  if (!isServerAgentNameFileSafe(name)) return null;
  const title = asString(item.title)?.trim();
  return {
    id,
    name,
    // title 服务端必填；防御旧数据缺失时退回 name，保证 UI 与 description 兜底有值。
    title: title && title.length > 0 ? title : name,
    description: asString(item.description),
    emoji: asString(item.emoji),
    persona: asString(item.persona),
    provider: asString(item.provider),
    modelId: asString(item.modelId),
    skills: asStringList(item.skills),
    tags: asStringList(item.tags),
    category: asString(item.category),
    official: asBoolean(item.official),
    author: asString(item.author),
    publishedAt: asString(item.publishedAt),
    updatedAt: asString(item.updatedAt),
    enabled: asBoolean(item.enabled),
    hot: asNumber(item.hot),
    uses: asNumber(item.uses),
    installed: asBoolean(item.installed),
    installEnabled: asBoolean(item.installEnabled),
    favorited: asBoolean(item.favorited),
    sessionType: asSessionType(item.sessionType),
    policyMode: asPolicyMode(item.policyMode),
    thinkingLevel: asString(item.thinkingLevel),
    starters: asStringList(item.starters),
  };
}

/** 解析 `GET /me/agents` 响应（`{agents: [...]}`）；形状不对时返回空集而不是抛错。 */
export function normalizeServerAgentList(payload: unknown): ServerAgentDefinition[] {
  const list =
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { agents?: unknown }).agents)
      ? (payload as { agents: unknown[] }).agents
      : [];
  const result: ServerAgentDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const agent = normalizeServerAgentDefinition(raw);
    if (!agent || seen.has(agent.name)) continue;
    seen.add(agent.name);
    result.push(agent);
  }
  return result;
}
