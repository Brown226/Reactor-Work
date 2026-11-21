/**
 * 托管 MCP 工具快照与三档策略（治理平面 P0）：**纯函数层**，无 IO。
 *
 * 语义对齐 KnowWork 的 catalog（吸收其防提权设计，见 docs/未完成-MCP治理平面-spec-v1.md §1）：
 * - **首次登记**照 MCP 注解预填三档（`readOnlyHint === true` → allow，其余 → ask）；
 * - **之后的同步新增工具一律 ask 并标 `isNew`**——上游升级加了写操作不能悄悄变成直接调；
 * - 管理员对该工具显式设过策略（PUT tool-policy 命中）即固化，清 `isNew`；
 * - 参数 schema 不合格的工具标 `problem`：不给模型注册（等同 block），relay 也拒绝执行——
 *   坏工具不许拖垮会话（宁可少一个工具）。
 */

/** 快照单条工具（存 mcp_server.tools_snapshot JSONB）。 */
export interface McpToolSnapshotEntry {
  name: string;
  description?: string;
  /** MCP 标准注解（只认显式声明；destructiveHint 缺省不按 true 处理） */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  inputSchema?: unknown;
  /** 参数结构不合格的原因（有值 = 不给模型、relay 拒执行） */
  problem?: string;
  /** 同步新增且管理员尚未固化策略的标记 */
  isNew?: boolean;
}

/** 三档策略词表（与下发契约 ManagedMcpToolPolicy 同口径）。 */
export type McpToolPolicy = "allow" | "ask" | "block";

export const MCP_TOOL_POLICY_VALUES: readonly McpToolPolicy[] = ["allow", "ask", "block"];

/** 快照/策略上限（超出的截断，防上游一次报几千个工具把行撑爆）。 */
export const MAX_SNAPSHOT_TOOLS = 200;
/** 单工具 inputSchema 序列化上限（64KB）。 */
const MAX_SCHEMA_CHARS = 64 * 1024;

/** 归一化三档：非法值一律 ask（fail-closed——多问一次好过悄悄放行）。 */
export function normalizeToolPolicy(value: unknown): McpToolPolicy {
  return value === "allow" || value === "block" ? value : "ask";
}

/** MCP 注解 → 默认三档：只读放行，其余（含未注解）需确认。 */
export function annotatedDefaultPolicy(entry: Pick<McpToolSnapshotEntry, "annotations">): McpToolPolicy {
  return entry.annotations?.readOnlyHint === true ? "allow" : "ask";
}

/** 校验单条工具；返回 problem 原因（null = 合格）。 */
export function validateSnapshotTool(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return "工具条目不是对象";
  const tool = raw as Record<string, unknown>;
  if (typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name)) {
    return "工具名缺失或含非法字符";
  }
  if (tool.description !== undefined && typeof tool.description !== "string") return "description 类型非法";
  if (tool.inputSchema === undefined) return null;
  if (typeof tool.inputSchema !== "object" || tool.inputSchema === null || Array.isArray(tool.inputSchema)) {
    return "inputSchema 必须是对象";
  }
  const schema = tool.inputSchema as Record<string, unknown>;
  if (schema.type !== undefined && schema.type !== "object") return "inputSchema 根类型必须是 object";
  let serialized: string;
  try {
    serialized = JSON.stringify(tool.inputSchema);
  } catch {
    return "inputSchema 无法序列化";
  }
  if (serialized.length > MAX_SCHEMA_CHARS) return `inputSchema 超过 ${MAX_SCHEMA_CHARS} 字符上限`;
  return null;
}

/**
 * 从上游 tools/list 原始响应构建快照与预填策略。
 *
 * @param rawTools 上游返回的工具数组（未校验形状）
 * @param previous 此前的快照（用于判定「新增」与保留管理员已固化的策略）
 * @param existingPolicy 现行 tool_policy 表
 * @param firstRegistration 是否首次登记（首次照注解预填；之后新增一律 ask）
 */
export function buildSnapshot(
  rawTools: unknown,
  previous: McpToolSnapshotEntry[],
  existingPolicy: Record<string, McpToolPolicy>,
  firstRegistration: boolean,
): { snapshot: McpToolSnapshotEntry[]; policy: Record<string, McpToolPolicy> } {
  const previousNames = new Set(previous.map((tool) => tool.name));
  const rawList = Array.isArray(rawTools) ? rawTools.slice(0, MAX_SNAPSHOT_TOOLS) : [];
  const snapshot: McpToolSnapshotEntry[] = [];
  const policy: Record<string, McpToolPolicy> = {};

  for (const raw of rawList) {
    if (typeof raw !== "object" || raw === null) continue;
    const tool = raw as Record<string, unknown>;
    const name = typeof tool.name === "string" ? tool.name : "";
    if (!name) continue;
    const problem = validateSnapshotTool(raw);
    const annotations = isRecord(tool.annotations)
      ? {
          ...(tool.annotations.readOnlyHint === true ? { readOnlyHint: true } : {}),
          ...(tool.annotations.destructiveHint === true ? { destructiveHint: true } : {}),
          ...(tool.annotations.idempotentHint === true ? { idempotentHint: true } : {}),
        }
      : undefined;
    const entry: McpToolSnapshotEntry = {
      name,
      ...(typeof tool.description === "string" && tool.description ? { description: tool.description } : {}),
      ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      ...(problem ? { problem } : {}),
      // 「新」= 非首次登记才出现、且管理员还没固化过策略（改过即不算新）
      ...(!firstRegistration && !previousNames.has(name) && existingPolicy[name] === undefined
        ? { isNew: true }
        : {}),
    };
    snapshot.push(entry);

    // 策略合并：管理员设过的原样保留（含首次登记后新加的条目——改过即固化）；
    // 没设过的：首次登记照注解预填，之后的同步新增一律 ask（防上游升级提权）。
    const prior = existingPolicy[name];
    policy[name] =
      prior !== undefined
        ? prior
        : firstRegistration
          ? annotatedDefaultPolicy(entry)
          : "ask";
  }
  return { snapshot, policy };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 管理台展示用：工具名是否命中「新增未固化」。 */
export function isNewTool(entry: McpToolSnapshotEntry, policy: Record<string, McpToolPolicy>): boolean {
  return entry.isNew === true && policy[entry.name] === undefined;
}
