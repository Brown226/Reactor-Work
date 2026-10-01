import {
  PermissionCapabilityGroup,
  type PermissionUpdate,
  type ToolPermissionPatternSource,
} from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";

import type { ToolEntry } from "../types.js";

/**
 * 未声明 `alwaysAllowPatternSources` 的工具仍走这张键表（历史行为，本次修复刻意保持不变）。
 * `input` 来源与它同义：那是"从入参里挑一个字段当规则内容"的通用语义，不是某个具体对象。
 */
const PROJECT_RULE_INPUT_KEYS = ["command", "url", "file_path", "path", "pattern"] as const;

/**
 * 已声明来源各自的候选入参键。
 *
 * `path` 按**稳定优先**排序：被读取的源路径（`file_path`/`sourcePath`）排在前面，产物路径
 * （`outputPath`）排在后面。规则内容不稳定时"记住"本来就等于没记住，但排序能保证
 * ExportReviewReport 这类工具记住的是它读的源文件（`sourcePath`），而不是带时间戳的产物路径。
 *
 * `custom` 不出现在这里：它的推导归工具自己的 `resolvePermissionRulePolicy`
 * （当前没有工具声明它）；声明了 custom 却拿不到推导结果时按"不可限定作用域"处理，见下。
 * `toolName` / `none` 也不在这里：它们不参与声明驱动推导，而是回退旧键表，见
 * `resolveAlwaysAllowRuleContent` 的第 ③ 档。
 */
const PATTERN_SOURCE_INPUT_KEYS: Readonly<
  Partial<Record<ToolPermissionPatternSource, readonly string[]>>
> = {
  command: ["command", "cmd"],
  input: PROJECT_RULE_INPUT_KEYS,
  network: ["url", "endpoint", "host"],
  path: ["file_path", "path", "filePath", "sourcePath", "outputPath", "dir", "directory"],
};

/**
 * 声明这些来源意味着"规则必须限定作用域"：它们各自指向一个具体对象（文件路径 / 命令 / 网络目标 /
 * 具体入参字段）。声明了这些来源时，规则内容只能由它们推导；推导不出内容就不记忆，而不是放行。
 *
 * 越权缺陷的成因就在这条边界上：`permissionService.matchesRule` 对**无内容规则**一律判匹配
 * （`if (!rule.ruleContent) return true;`），所以"解析不出作用域内容"如果退化成无内容规则，
 * 用户点一次"总是允许"拿到的是**整个工具的项目级永久放行**。因此这里把这类来源单独标出来，
 * 让调用方在拿不到内容时改为"不提供总是允许"，而不是放行。
 *
 * `custom` 也在集合里：它的推导不在这里，取不到内容时同样按不可安全记忆处理。
 */
const SCOPED_PATTERN_SOURCES: ReadonlySet<ToolPermissionPatternSource> = new Set([
  "custom",
  "input",
  "path",
  "command",
  "network",
]);

/** 声明的来源里是否包含"必须限定作用域"的一类（path / command / network / input / custom）。 */
export function requiresScopedAlwaysAllowContent(
  sources: readonly ToolPermissionPatternSource[] | undefined,
): boolean {
  return (sources ?? []).some((source) => SCOPED_PATTERN_SOURCES.has(source));
}

/**
 * 推导"总是允许"规则的内容。三档语义：
 *
 * ① 未声明 `alwaysAllowPatternSources` —— 旧键表，行为与修复前逐字节一致；
 * ② 限定作用域的来源（path / command / network / input，见 `SCOPED_PATTERN_SOURCES`）——
 *    只接受由这些来源按候选键推导出的内容；推导不出时返回 `undefined`，由调用方按
 *    "不可安全记忆"处理（不提供总是允许），见 `buildDefaultPermissionUpdates`；
 * ③ `toolName` / `none` —— **回退旧键表**，而不是直接落无内容规则。
 *
 * 第 ③ 档为什么这么定：这两个来源按字面语义是"整工具放行"，但修复前那张旧键表可能已经从入参里
 * 取到了**更窄**的内容（EvalWorkflowSnippet / CreateWorkflow / AmendWorkflow / SaveWorkflow 的
 * 入参里都有 `path`，旧行为记住的是 path 限定的规则）。本次修复的方向是**收窄**越权，顺带把任何
 * 工具的授权放宽都是反向扩大，所以旧键表取得出内容就照旧用（更窄），取不出才落无内容规则
 * （与今天一致）。
 */
export function resolveAlwaysAllowRuleContent(
  input: unknown,
  sources: readonly ToolPermissionPatternSource[] | undefined,
): string | undefined {
  if (sources === undefined) return legacyRuleContentFromInput(input);
  for (const source of sources) {
    if (!SCOPED_PATTERN_SOURCES.has(source)) continue;
    const content = ruleContentForSource(input, source);
    if (content !== undefined) return content;
  }
  return sources.some((source) => source === "toolName" || source === "none")
    ? legacyRuleContentFromInput(input)
    : undefined;
}

/**
 * 执行器入口：能力组与 `alwaysAllowPatternSources` 都从工具 entry 上取，语义是"建议必须跟随工具声明"。
 * 保留下面的原语给只有零散字段的调用方。
 */
export function buildEntryPermissionUpdates(
  entry: ToolEntry,
  toolName: string,
  input: unknown,
): PermissionUpdate[] {
  return buildDefaultPermissionUpdates(
    toolName,
    input,
    entry.permissionCapabilityGroup,
    entry.permission?.alwaysAllowPatternSources,
  );
}

export function buildDefaultPermissionUpdates(
  toolName: string,
  input: unknown,
  capabilityGroup?: PermissionCapabilityGroup,
  alwaysAllowPatternSources?: readonly ToolPermissionPatternSource[],
): PermissionUpdate[] {
  if (capabilityGroup) {
    if (capabilityGroup !== PermissionCapabilityGroup.OfficialCua) {
      throw new Error(`Unsupported permission capability group: ${capabilityGroup}`);
    }
    return [
      {
        behavior: "allow",
        rules: [{ toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME }],
        type: "addRules",
      },
    ];
  }

  const ruleContent = resolveAlwaysAllowRuleContent(input, alwaysAllowPatternSources);
  if (ruleContent === undefined && requiresScopedAlwaysAllowContent(alwaysAllowPatternSources)) {
    // 越权防护（本次修复的核心）：工具声明了必须限定作用域的来源（path / command / network /
    // input），却从本次入参解析不出任何内容（ExportReviewReport 入参是 sourcePath / outputPath，
    // 旧写死键表都不认，就是这条路径）。这里**不产出任何建议**，而不是产出"无内容规则"：
    // 无内容规则匹配该工具的每一次调用，等于把一次"按目录记住"扩权成整个工具的项目级永久放行。
    // 声明 toolName / none 的工具不落到这个分支：它们回退旧键表，规则内容与修复前一致。
    // 配套：approval-gate 在同样条件下把 optionsPolicy 收窄为 no-always-allow，
    // 消费面（v4 选项投影与 legacy 投影）因此不投放"总是允许"，退回每次都问。
    return [];
  }

  return [
    {
      behavior: "allow",
      rules: [
        {
          toolName,
          ...(ruleContent ? { ruleContent } : {}),
        },
      ],
      type: "addRules",
    },
  ];
}

function ruleContentForSource(
  input: unknown,
  source: ToolPermissionPatternSource,
): string | undefined {
  const keys = PATTERN_SOURCE_INPUT_KEYS[source];
  if (!keys) return undefined;
  const record = asRecord(input);
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function legacyRuleContentFromInput(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim().length > 0) return input;
  const record = asRecord(input);
  if (!record) return undefined;
  for (const key of PROJECT_RULE_INPUT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
