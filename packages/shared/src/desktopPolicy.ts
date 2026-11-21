/**
 * 组织策略（服务端 `GET /desktop/policy`）的**端侧唯一契约**：形状、默认值合并、
 * 以及三个强制点共用的纯判定函数（模式天花板 / 命令黑名单 / 出网白名单）。
 *
 * 为什么放在 `@zcode/shared`：Host（`packages/services/src/reactor-server/`）写策略缓存、
 * CLI（`apps/zcode-cli/packages/{core,adapters}`）读同一个文件并各自强制，UI 展示摘要 ——
 * 三边必须用同一份匹配规则，否则「同一份策略三种解释」。写入者**只有** Host 的
 * `ReactorPolicyCache`（见 docs/未完成-服务端接线-P4-用量上报与策略.md §3、§4.3）。
 *
 * 词表与服务端 `server/packages/shared/src/audit.ts` 的 `AuditPolicyMode` 相同：
 * `plan | build | edit | yolo`，旧词只在读时映射（D2）。
 *
 * 注意：本模块会被**渲染层**经 `@zcode/shared` barrel 求值（vite dev 下 barrel 全量执行），
 * 也会被打进**沙箱 preload**（不能 require node 内建）。因此这里必须保持纯——
 * `node:path` / `process.env` 相关的路径解析在各自 Node 消费方实现
 * （Host：`services/src/reactor-server/reactorPolicyCache.ts`；CLI：`adapters/src/policy/desktopPolicySource.ts`）。
 */

/** 模式词表：与端上 `CollaborationMode`（plan/build/edit/yolo[/auto]）同源。 */
export type ReactorDesktopPolicyMode = "plan" | "build" | "edit" | "yolo";

export const REACTOR_DESKTOP_POLICY_MODES: readonly ReactorDesktopPolicyMode[] = [
  "plan",
  "build",
  "edit",
  "yolo",
];

/** 旧词表 → 新词表（只用于读，不用于写）。与服务端 `LEGACY_POLICY_MODE_MAP` 一致。 */
const LEGACY_MODE_MAP: Readonly<Record<string, ReactorDesktopPolicyMode>> = {
  readonly: "plan",
  strict: "edit",
  balanced: "build",
  trust: "yolo",
};

/** 归一化模式：新词直通，旧词映射，其余 null（调用方决定报错或按默认合并）。 */
export function normalizeReactorDesktopPolicyMode(value: unknown): ReactorDesktopPolicyMode | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if ((REACTOR_DESKTOP_POLICY_MODES as readonly string[]).includes(trimmed)) {
    return trimmed as ReactorDesktopPolicyMode;
  }
  return LEGACY_MODE_MAP[trimmed] ?? null;
}

/**
 * 严格度排序（越小越严）。天花板取交集 = 取更严的一档，因此本表是「只能收紧不能放宽」
 * 的判定依据：`plan < edit < build < yolo`（见 P4 文档 §1 D2 的映射表）。
 */
export const REACTOR_DESKTOP_POLICY_MODE_RANK: Readonly<Record<ReactorDesktopPolicyMode, number>> =
  {
    plan: 0,
    edit: 1,
    build: 2,
    yolo: 3,
  };

export interface ReactorDesktopPolicyQuota {
  /** 月度 token 上限；null = 不限（v1 只告警不阻断）。 */
  monthlyTokenLimit: number | null;
  /** 告警阈值百分比（如 80 / 100）。 */
  alertThresholds: number[];
}

/** 产品文档地址字段上限：与服务端 `normalizeProductDocsUrl` 同口径。 */
const PRODUCT_DOCS_URL_MAX_LENGTH = 500;

/**
 * 归一化产品文档地址：仅接受 http/https，其余（空串 / 非法协议 / 超长 / 非字符串）→ null。
 * 与服务端 `server/packages/server/src/audit/repo.ts` 的同名函数各有一份实现
 * （两个 workspace 不共享运行时），改规则必须同步。
 */
export function normalizeProductDocsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > PRODUCT_DOCS_URL_MAX_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
}

export interface ReactorDesktopPolicy {
  /** 组织允许用户开到的最高档；用户会话 mode 与它取交集。 */
  defaultApprovalMode: ReactorDesktopPolicyMode;
  /** 命令黑名单（子串匹配，见 `matchReactorCommandBlacklist`）；空数组 = 不限制。 */
  commandBlacklist: string[];
  /** 出网白名单（域名后缀，见 `isReactorEgressHostAllowed`）；空数组 = 不限制。 */
  egressAllowlist: string[];
  quota: ReactorDesktopPolicyQuota;
  /** 产品文档入口地址；null = 未配置（UI 提示而非跳转）。不参与任何强制判定。 */
  productDocsUrl: string | null;
  /**
   * 该用户可用的界面模式（`coding` 为编程模式）。**由服务端按 viewer 计算**，
   * 与服务端 `server/packages/shared/src/audit.ts` 的同名字段一一对应（两 workspace
   * 不共享运行时，改口径必须同步）。
   *
   * 缺省 = 白名单关闭（不含 `coding`），与产品规则一致：编程模式只对配置了受众的人开放。
   * 端侧据此隐藏切换器中的编程档，并把已存的 `coding` 兜底到办公档。
   */
  allowedInterfaceModes: ReactorInterfaceMode[];
  /**
   * 托管 MCP（治理平面 P0）：企业登记的 MCP 服务与逐工具三档策略。
   * 与服务端 `server/packages/shared/src/audit.ts` 的 `ManagedMcpPolicy` 手工同步。
   *
   * 红线：payload **不含凭据、不含上游地址** —— 端侧调用一律经服务端 relay；
   * 缺省 = `{ servers: [] }`（无托管），绝不因解析失败放大（见 normalize）。
   * 强制语义见 `managedToolPolicyFor`（未登记工具一律 ask）。
   */
  managedMcp: ReactorManagedMcpPolicy;
  /**
   * 策略内容寻址版本（治理吸收第二批）：策略本体或托管面任一变化即变化。
   * 端侧 `PermissionService` 据此判定会话级「不再询问」授权是否失效（版本变化即清空
   * session allow）。缺省（老服务端/未登录）= undefined = 不联动，行为与现状一致。
   * 与服务端 `server/packages/shared/src/audit.ts` 的同名字段手工同步（两 workspace
   * 不共享运行时）。
   */
  policyVersion?: string;
}

/** 托管 MCP 单服务下发条目（无凭据、无上游 URL；端侧只经 relay 调用）。 */
export type ReactorManagedMcpToolPolicy = "allow" | "ask" | "block";

export interface ReactorManagedMcpServer {
  /** 稳定 id（relay 路由 `/desktop/mcp-relay/:id` 与端侧引用它） */
  id: string;
  /** 服务名 = 模型可见工具前缀段（`mcp__<name>__*`）；服务端约束禁下划线，前缀无歧义 */
  name: string;
  displayName?: string;
  type: "http" | "sse";
  enabled: boolean;
  /** 逐工具三档；不在表内的工具按 defaultToolPolicy 处理 */
  toolPolicy: Record<string, ReactorManagedMcpToolPolicy>;
  /** 未登记工具的三档（v1 固定 "ask"：新工具默认需确认，防上游升级提权） */
  defaultToolPolicy: ReactorManagedMcpToolPolicy;
  updatedAt?: string;
}

export interface ReactorManagedMcpPolicy {
  servers: ReactorManagedMcpServer[];
}

/** 空托管面（未登录 / 老服务端 / 解析失败的合并默认）：绝不放大。 */
export const EMPTY_REACTOR_MANAGED_MCP: ReactorManagedMcpPolicy = {
  servers: [],
};

/** 归一化托管 MCP 下发：逐项校验形状，任一项不合法则**整项丢弃**（宁可少一个服务，不给半成品）。 */
function normalizeManagedMcp(value: unknown): ReactorManagedMcpPolicy {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as Record<string, unknown>).servers)
  ) {
    return { servers: [] };
  }
  const servers: ReactorManagedMcpServer[] = [];
  for (const raw of (value as { servers: unknown[] }).servers) {
    if (typeof raw !== "object" || raw === null) continue;
    const server = raw as Record<string, unknown>;
    if (typeof server.id !== "string" || !server.id) continue;
    if (typeof server.name !== "string" || !server.name) continue;
    if (server.type !== "http" && server.type !== "sse") continue;
    servers.push({
      id: server.id,
      name: server.name,
      ...(typeof server.displayName === "string" && server.displayName
        ? { displayName: server.displayName }
        : {}),
      type: server.type,
      enabled: server.enabled === true,
      toolPolicy: normalizeManagedToolPolicyMap(server.toolPolicy),
      defaultToolPolicy: "ask",
      ...(typeof server.updatedAt === "string" ? { updatedAt: server.updatedAt } : {}),
    });
  }
  return { servers };
}

function normalizeManagedToolPolicyMap(
  value: unknown,
): Record<string, ReactorManagedMcpToolPolicy> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, ReactorManagedMcpToolPolicy> = {};
  for (const [tool, verdict] of Object.entries(value as Record<string, unknown>)) {
    // 非法值一律按 ask 处理（fail-closed：多问一次好过悄悄放行）
    out[tool] = verdict === "allow" || verdict === "block" ? verdict : "ask";
  }
  return out;
}

/**
 * 托管服务的某工具对该会话的三档判定。
 *
 * - `serverName` 命中托管服务（按服务名匹配，服务名禁下划线保证前缀无歧义）；
 * - 该服务停用 / 未命中任何托管服务 → null（调用方按「非托管」走原有注解推导）；
 * - 工具在策略表内 → 表值；**不在表内 → ask**（新工具默认需确认的端侧兜底，
 *   与服务端 relay 的再判口径一致：服务端只拒 block/problem，ask/allow 由本端闸负责）。
 */
export function managedToolPolicyFor(
  policy: ReactorDesktopPolicy | null | undefined,
  serverName: string,
  toolName: string,
): ReactorManagedMcpToolPolicy | null {
  if (!policy) return null;
  const server = policy.managedMcp.servers.find((candidate) => candidate.name === serverName);
  if (!server || !server.enabled) return null;
  return server.toolPolicy[toolName] ?? server.defaultToolPolicy ?? "ask";
}

/** 界面模式词表（与端上 `packages/ui/src/lib/interfaceMode.ts` 的 `InterfaceMode` 同口径）。 */
export const REACTOR_INTERFACE_MODES = ["office", "coding", "review"] as const;
export type ReactorInterfaceMode = (typeof REACTOR_INTERFACE_MODES)[number];

/** 白名单关闭时的默认可用档（不含编程档）：与服务端「未配置受众」的口径一致。 */
const DEFAULT_ALLOWED_INTERFACE_MODES: ReactorInterfaceMode[] = ["office", "review"];

function isReactorInterfaceMode(value: unknown): value is ReactorInterfaceMode {
  return (
    typeof value === "string" && (REACTOR_INTERFACE_MODES as readonly string[]).includes(value)
  );
}

/**
 * 归一化可用界面模式列表：
 * - 非数组 / 解析不出任何合法档 → 回落白名单关闭默认（**绝不放大可见性**）；
 * - 只保留词表内取值并去重。
 */
function normalizeInterfaceModes(value: unknown): ReactorInterfaceMode[] {
  if (!Array.isArray(value)) return [...DEFAULT_ALLOWED_INTERFACE_MODES];
  const set = new Set<ReactorInterfaceMode>();
  for (const item of value) {
    if (isReactorInterfaceMode(item)) set.add(item);
  }
  if (set.size === 0) return [...DEFAULT_ALLOWED_INTERFACE_MODES];
  return [...set];
}

/**
 * 某界面模式对该策略是否可用。`allowed` 缺省（空/未给）时按白名单关闭默认处理，
 * 供 UI 过滤切换器档位、以及 store 兜底当前档使用。
 */
export function isReactorInterfaceModeAllowed(
  mode: string | null | undefined,
  allowed: readonly string[] | null | undefined,
): boolean {
  if (!mode) return false;
  const list = allowed && allowed.length > 0 ? allowed : DEFAULT_ALLOWED_INTERFACE_MODES;
  return list.includes(mode);
}

/**
 * 缺字段时的合并默认值。
 *
 * 关键取舍：**模式缺省取 `yolo`（不额外收紧）而不是服务端默认档 `build`**。
 * 端侧只在「拿到一份可用策略」时才强制；策略解析不出模式（老服务端/形状损坏）时按
 * 「不限制」处理，与 §4.3「未登录 → 不强制 / `source=unknown` 视为不限制」同一口径 ——
 * 反过来默认成 build 会让一次解析失败变成用户被莫名限制。`DEFAULT_POLICY` 语义的
 * 另一半（数组默认为空 = 不限制）在这里同样成立。
 */
export const DEFAULT_REACTOR_DESKTOP_POLICY: ReactorDesktopPolicy = {
  defaultApprovalMode: "yolo",
  commandBlacklist: [],
  egressAllowlist: [],
  quota: { monthlyTokenLimit: null, alertThresholds: [80, 100] },
  productDocsUrl: null,
  // 白名单默认关闭：未配置受众时不含编程档（与产品规则一致，见 docs/未完成-编程模式权限-方案-v1.md）。
  allowedInterfaceModes: [...DEFAULT_ALLOWED_INTERFACE_MODES],
  // 托管 MCP 默认空面：无下发 = 无托管（未登录/老服务端不放大）。fresh 数组防共享可变引用。
  managedMcp: { servers: [] },
};

/** 从任一（可能不完整的）策略对象归一化出完整策略：缺字段按默认合并，不把缺失当清空。 */
export function normalizeReactorDesktopPolicy(raw: unknown): ReactorDesktopPolicy {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_REACTOR_DESKTOP_POLICY };
  const record = raw as Record<string, unknown>;
  const mode =
    normalizeReactorDesktopPolicyMode(record.defaultApprovalMode) ??
    DEFAULT_REACTOR_DESKTOP_POLICY.defaultApprovalMode;
  const quotaRaw =
    typeof record.quota === "object" && record.quota !== null
      ? (record.quota as Record<string, unknown>)
      : {};
  const limit = quotaRaw.monthlyTokenLimit;
  const thresholds = Array.isArray(quotaRaw.alertThresholds)
    ? quotaRaw.alertThresholds.filter(
        (value): value is number => typeof value === "number" && value > 0 && value <= 100,
      )
    : [];
  return {
    defaultApprovalMode: mode,
    commandBlacklist: normalizeStringList(record.commandBlacklist),
    egressAllowlist: normalizeStringList(record.egressAllowlist),
    quota: {
      monthlyTokenLimit:
        typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null,
      alertThresholds:
        thresholds.length > 0
          ? thresholds
          : [...DEFAULT_REACTOR_DESKTOP_POLICY.quota.alertThresholds],
    },
    // 文档地址是随策略下发的配置位：解析不出就当未配置，不影响其余字段的强制语义。
    productDocsUrl: normalizeProductDocsUrl(record.productDocsUrl),
    // 可用界面模式：解析不出就回落白名单关闭默认（不含编程档）——绝不因缺字段放大可见性。
    allowedInterfaceModes: normalizeInterfaceModes(record.allowedInterfaceModes),
    // 托管 MCP：解析不出 = 无托管（空面）。绝不因老服务端/解析失败放大托管面。
    managedMcp: normalizeManagedMcp(record.managedMcp),
    // 策略版本：透传（非法/缺失 = 不联动，行为与现状一致）。
    ...(typeof record.policyVersion === "string" && record.policyVersion
      ? { policyVersion: record.policyVersion }
      : {}),
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * 模式天花板：返回「用户请求档位」与「组织天花板」中更严的一档。
 *
 * - 天花板为 null（无策略/未登录）→ 原样返回请求档位；
 * - 请求档位不可识别（如 `auto`）→ 取天花板：无法证明它不更宽时按更严处理。
 */
export function intersectReactorDesktopPolicyMode(
  requested: string | null | undefined,
  ceiling: ReactorDesktopPolicyMode | null | undefined,
): string {
  if (!ceiling) return requested ?? "";
  const normalizedRequested = normalizeReactorDesktopPolicyMode(requested);
  if (!normalizedRequested) return ceiling;
  return REACTOR_DESKTOP_POLICY_MODE_RANK[normalizedRequested] <=
    REACTOR_DESKTOP_POLICY_MODE_RANK[ceiling]
    ? normalizedRequested
    : ceiling;
}

/**
 * 命令黑名单命中判定：返回命中的条目，未命中返回 null。
 *
 * 语义（v1 明确定义，服务端只存字符串）：
 * - 条目按 **子串** 匹配，大小写不敏感，首尾空白忽略；
 * - 空名单 = 不限制；空条目忽略（服务端也过滤，这里再防一手手工改文件）。
 */
export function matchReactorCommandBlacklist(
  command: string | null | undefined,
  blacklist: readonly string[] | null | undefined,
): string | null {
  const text = command?.trim().toLowerCase();
  if (!text || !blacklist || blacklist.length === 0) return null;
  for (const entry of blacklist) {
    const needle = entry.trim().toLowerCase();
    if (!needle) continue;
    if (text.includes(needle)) return entry.trim();
  }
  return null;
}

function normalizeHostname(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/\.+$/, "")
      // 条目里可能带端口（`example.com:8080`）：端口不参与匹配，直接切掉。
      .replace(/:\d+$/, "")
  );
}

/**
 * 出网白名单域名匹配（P4 文档 §4.3 的规则，避免两义）：
 *
 * - 空名单 = 不限制（返回 true）；
 * - `*` = 逃生阀，允许全部；
 * - `example.com` 允许裸域**与**其子域；
 * - `*.example.com` 只允许子域，**不含**裸域 `example.com`；
 * - 端口不参与匹配；
 * - 名单解析不出任何有效条目（例如只有空串）→ 视为不限制。
 */
export function isReactorEgressHostAllowed(
  hostname: string,
  allowlist: readonly string[] | null | undefined,
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const host = normalizeHostname(hostname);
  if (!host) return false;
  let hasUsableEntry = false;
  for (const entry of allowlist) {
    const normalized = normalizeHostname(entry);
    if (!normalized) continue;
    hasUsableEntry = true;
    if (normalized === "*") return true;
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(2);
      if (suffix && host.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (host === normalized || host.endsWith(`.${normalized}`)) return true;
  }
  return !hasUsableEntry;
}

/** 策略缓存文件名：`{用户数据根}/desktop-policy.json`（写入者只有 Host 的 PolicyCache）。 */
export const REACTOR_DESKTOP_POLICY_FILE_NAME = "desktop-policy.json";

/** 策略缓存文件：Host 写、CLI 只读。`fetchedAt` 只在服务端拉取成功时刷新。 */
export interface ReactorDesktopPolicyFile {
  /** 文件格式版本，便于将来演进时拒绝未知格式。 */
  version: 1;
  /** 本次策略的服务端拉取时间（ISO8601）。 */
  fetchedAt: string;
  policy: ReactorDesktopPolicy;
}

/** 解析策略缓存文件内容；形状不对返回 null（视为"没有策略" = 不限制）。 */
export function parseReactorDesktopPolicyFile(raw: unknown): ReactorDesktopPolicyFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (typeof record.policy !== "object" || record.policy === null) return null;
  return {
    version: 1,
    fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : new Date(0).toISOString(),
    policy: normalizeReactorDesktopPolicy(record.policy),
  };
}

/**
 * 强制点读取的口径：只读快照来源。CLI 的权限闸与出网闸都通过它取策略，
 * 缺省（未注入 / 文件不存在 / 未登录）一律返回 null = 不限制。
 */
export interface ReactorDesktopPolicySource {
  /** 当前生效策略；null = 无策略（不限制）。**必须同步**：它在权限热路径上。 */
  current(): ReactorDesktopPolicy | null;
}
