/**
 * 「总是允许」规则内容推导与越权防护回归
 * （`npx tsx --test test/always-allow-rule-content.test.ts`，在 packages/core 下执行）。
 *
 * 守的是一类**静默越权**：工具声明了 `alwaysAllowPatternSources`，但规则内容实际由一张写死的
 * 入参键表推导；键表不认识该工具的入参时，产出的是**无内容规则**。而
 * `permissionService.matchesRule` 对无内容规则一律判匹配（`if (!rule.ruleContent) return true;`）
 * —— 用户点一次"总是允许"（以为是"按目录记住"），拿到的是整个工具的项目级永久放行。
 * ExportReviewReport 的入参是 `sourcePath` / `outputPath`，正好都不在旧键表里，就是这条路径。
 *
 * 三件事在这里钉死：
 * ① 声明了来源就按声明的来源推导（ExportReviewReport → `sourcePath`）；
 * ② 声明了 path / command / network / input 却解析不出内容 → **不产出无内容规则**，且不投放"总是允许"；
 * ③ 未声明来源的工具、以及 `toolName` / `none` 声明（回退旧键表）行为不变 —— 本次修复只收窄，不放宽。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { PermissionUpdate, ToolPermissionPatternSource } from "@zcode/contracts";

import { agentToolEntry } from "../src/tool/handlers/agent.js";
import { evalWorkflowSnippetToolEntry } from "../src/tool/handlers/eval-workflow-snippet.js";
import { exportReviewReportToolEntry } from "../src/tool/handlers/export-review-report.js";
import { resolveToolApproval } from "../src/tool/executor/approval-gate.js";
import { buildDefaultPermissionUpdates } from "../src/tool/executor/permission-suggestions.js";
import type { ToolEntry } from "../src/tool/types.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";

const EXPORT_INPUT = {
  format: "docx",
  title: "施工图设计说明",
  issues: [],
  conclusion: "no_issues",
  // 被审文件（稳定），与默认输出同目录
  sourcePath: "C:/ws/docs/施工图设计说明.md",
  // 默认产物路径带时间戳，每次调用都不同
  outputPath: "C:/ws/docs/施工图设计说明-审查报告-20260930.docx",
} as const;

function allowRules(updates: PermissionUpdate[]) {
  return updates.flatMap((update) => (update.type === "addRules" ? update.rules : []));
}

function firstRule(updates: PermissionUpdate[]) {
  const [rule] = allowRules(updates);
  assert.ok(rule, "期望至少产出一条 allow 规则");
  return rule;
}

/** resolveToolApproval 只读 entry.permission / entry.prepareApproval，测试桩不必铺满 ToolEntry。 */
function stubEntry(permission: {
  alwaysAllowPatternSources?: ToolPermissionPatternSource[];
  askOptions?: { allowAlways: false | "session" };
}): ToolEntry {
  return { permission } as unknown as ToolEntry;
}

function approvalOptionsPolicyFor(
  permission: Parameters<typeof stubEntry>[0],
  input: unknown,
): string | undefined {
  return resolveToolApproval(
    {} as ToolExecutorDeps,
    {} as never,
    stubEntry(permission),
    input,
    {} as never,
  ).optionsPolicy;
}

test("path 声明按稳定优先取 sourcePath（ExportReviewReport 场景）", () => {
  const declarations = exportReviewReportToolEntry.permission.alwaysAllowPatternSources;
  assert.deepEqual(declarations, ["path"], "ExportReviewReport 的声明本身是本次修复的输入前提");

  const updates = buildDefaultPermissionUpdates(
    exportReviewReportToolEntry.metadata.name,
    EXPORT_INPUT,
    undefined,
    declarations,
  );

  assert.deepEqual(firstRule(updates), {
    ruleContent: EXPORT_INPUT.sourcePath,
    toolName: "ExportReviewReport",
  });
});

test("修复前的前提：旧键表不认 sourcePath/outputPath，只会产出无内容规则", () => {
  const updates = buildDefaultPermissionUpdates("ExportReviewReport", EXPORT_INPUT);

  // 无内容规则 = 匹配该工具的一切调用（permissionService.matchesRule 的第一条分支）
  assert.deepEqual(firstRule(updates), { toolName: "ExportReviewReport" });
});

test("path 声明 + 只有时间戳型 outputPath：取 outputPath，而不是无内容规则", () => {
  const updates = buildDefaultPermissionUpdates(
    "ExportReviewReport",
    { ...EXPORT_INPUT, sourcePath: "   " },
    undefined,
    ["path"],
  );

  assert.deepEqual(firstRule(updates), {
    ruleContent: EXPORT_INPUT.outputPath,
    toolName: "ExportReviewReport",
  });
});

test("path 声明但解析不到任何路径：不产出无内容规则，也不投放'总是允许'", () => {
  const inputWithoutPaths: unknown = { format: "docx", title: "只有标题和问题清单", issues: [] };

  assert.deepEqual(
    buildDefaultPermissionUpdates("ExportReviewReport", inputWithoutPaths, undefined, ["path"]),
    [],
    "解析不出作用域内容时不能退化成整工具放行",
  );
  assert.equal(
    approvalOptionsPolicyFor({ alwaysAllowPatternSources: ["path"] }, inputWithoutPaths),
    "no-always-allow",
  );
});

test("path 声明且解析出内容时，保留'总是允许'选项", () => {
  assert.equal(
    approvalOptionsPolicyFor({ alwaysAllowPatternSources: ["path"] }, EXPORT_INPUT),
    undefined,
  );
});

test("command / network 声明同样受安全默认约束，候选键能命中时保持可用", () => {
  assert.equal(
    approvalOptionsPolicyFor({ alwaysAllowPatternSources: ["command"] }, { command: "ls" }),
    undefined,
  );
  assert.equal(
    approvalOptionsPolicyFor({ alwaysAllowPatternSources: ["command"] }, { cwd: "C:/ws" }),
    "no-always-allow",
  );
  assert.equal(
    approvalOptionsPolicyFor(
      { alwaysAllowPatternSources: ["command"] },
      { cmd: "pnpm lint" },
      // cmd 是候选键
    ),
    undefined,
  );

  assert.equal(
    approvalOptionsPolicyFor({ alwaysAllowPatternSources: ["network"] }, { url: "https://a.dev" }),
    undefined,
  );
  assert.equal(
    approvalOptionsPolicyFor({ alwaysAllowPatternSources: ["network"] }, { path: "C:/ws/a.md" }),
    "no-always-allow",
    "network 声明的工具不得因为 path 里恰好有字符串就记住一个网络规则",
  );
});

test("toolName 声明 + 入参含旧键表字段：仍取该内容（与修复前逐字节一致，更窄）", () => {
  // 真实声明：EvalWorkflowSnippet 声明 toolName，入参里恰好有 `path`。
  // 修复前旧键表取到 path 限定规则；本次修复的方向是收窄越权，不能顺带放宽成整工具放行。
  const declarations = evalWorkflowSnippetToolEntry.permission.alwaysAllowPatternSources;
  assert.deepEqual(declarations, ["toolName"]);

  assert.deepEqual(
    firstRule(
      buildDefaultPermissionUpdates(
        "EvalWorkflowSnippet",
        { path: "C:/ws/snippet.ts" },
        undefined,
        declarations,
      ),
    ),
    { ruleContent: "C:/ws/snippet.ts", toolName: "EvalWorkflowSnippet" },
  );
});

test("toolName 声明 + 入参无旧键表字段：仍是无内容规则（与修复前一致）", () => {
  const updates = buildDefaultPermissionUpdates(
    "TodoWrite",
    { todos: [{ content: "x", status: "pending" }] },
    undefined,
    ["toolName"],
  );

  assert.deepEqual(firstRule(updates), { toolName: "TodoWrite" });
  assert.equal(
    approvalOptionsPolicyFor({ alwaysAllowPatternSources: ["toolName"] }, { todos: [] }),
    undefined,
  );
});

test("input 声明纳入安全默认：候选键命中才有内容，命中不了不投放'总是允许'", () => {
  const agentInput = { description: "审查清单", prompt: "逐条核对" };
  const declarations = agentToolEntry.permission.alwaysAllowPatternSources;
  assert.deepEqual(declarations, ["input"]);

  // description/prompt 不在候选键里：input 也是"限定作用域"的来源，解析不出内容时不能退化成
  // 整工具放行（Agent 是 needsApproval:false，正常模式下本来就极少弹窗，此处只影响被强制询问时）。
  assert.deepEqual(buildDefaultPermissionUpdates("Agent", agentInput, undefined, declarations), []);
  assert.equal(
    approvalOptionsPolicyFor({ alwaysAllowPatternSources: ["input"] }, agentInput),
    "no-always-allow",
  );

  // 候选键命中时按候选顺序取（command 在 url 之前，与旧键表顺序一致）
  assert.deepEqual(
    firstRule(
      buildDefaultPermissionUpdates(
        "SomeTool",
        { url: "https://a.dev", command: "ls" },
        undefined,
        ["input"],
      ),
    ),
    { ruleContent: "ls", toolName: "SomeTool" },
  );
});

test("空声明数组按'没有可推导的来源'处理，行为与修复前一致", () => {
  assert.deepEqual(firstRule(buildDefaultPermissionUpdates("js", { code: "1+1" }, undefined, [])), {
    toolName: "js",
  });
  assert.equal(
    approvalOptionsPolicyFor({ alwaysAllowPatternSources: [] }, { code: "1+1" }),
    undefined,
  );
});

test("未声明 alwaysAllowPatternSources 的工具：旧键表行为不变", () => {
  // 旧键表能命中 → 内容不变
  assert.deepEqual(firstRule(buildDefaultPermissionUpdates("Bash", { command: "pnpm lint" })), {
    ruleContent: "pnpm lint",
    toolName: "Bash",
  });
  assert.deepEqual(firstRule(buildDefaultPermissionUpdates("WebFetch", { url: "https://a.dev" })), {
    ruleContent: "https://a.dev",
    toolName: "WebFetch",
  });
  // 旧键表命中不了 → 仍是无内容规则（本次修复刻意不扩大到未声明的工具）
  assert.deepEqual(
    firstRule(buildDefaultPermissionUpdates("SomeMcpTool", { sourcePath: "a.md" })),
    {
      toolName: "SomeMcpTool",
    },
  );
  assert.equal(approvalOptionsPolicyFor({}, { sourcePath: "a.md" }), undefined);
});

test("工具显式声明的 askOptions 优先于安全默认", () => {
  assert.equal(
    approvalOptionsPolicyFor(
      { alwaysAllowPatternSources: ["path"], askOptions: { allowAlways: "session" } },
      { cwd: "C:/ws" },
    ),
    "session-always-allow",
  );
  assert.equal(
    approvalOptionsPolicyFor(
      { alwaysAllowPatternSources: ["path"], askOptions: { allowAlways: false } },
      EXPORT_INPUT,
    ),
    "no-always-allow",
  );
});
