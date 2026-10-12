/**
 * 官方插件随包 seed 清单的**单一数据源**。
 *
 * 为什么抽出来：同一份插件清单过去在三处各写一遍 —— 桌面打包
 * （packages/desktop/scripts/prepare-agent-node-bundle.mjs）、远端预构建
 * （scripts/prepare-prebuilds.mjs）、服务端远端合同
 * （packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts）。
 * 三份平行清单各自维护的结果就是漂移：`44b25ed46c` 把内置插件从随包清单移除时只改了
 * 一部分，于是「dev 链从源码 seed 拿得到全部插件、安装包只剩 3 个」静默存在了很久。
 *
 * 本模块供两个 .mjs 构建脚本导入（TS 侧合同见 zcodeAgentOfficialPluginAssets.ts，
 * 由 bootstrap 的单测机械对照，见 apps/zcode-cli/packages/bootstrap/test/）。
 *
 * ## 两种插件
 *
 *  · **内容型**（`CONTENT_PLUGIN_SEEDS`）：只有 skills/agents/commands 与 `.zcode-plugin`
 *    清单，没有 package.json、没有构建步骤，拷进 `glm/packages/<目录>` 即被 seed 识别。
 *  · **运行时型**（`RUNTIME_PLUGIN_PACKAGES`）：带 MCP server，seed 前必须构建出
 *    `dist/mcp/server.js`（`pnpm --filter <packageName> build`）。
 *
 * `requiredSeedPaths` 是**拷完之后的校验**：缺一个文件就让打包/预构建失败，
 * 而不是发出一个「有插件壳、少技能正文」的残缺包 —— 后者的症状是审查/分析答案变水，
 * 没有任何报错能指向交付问题。
 */

/**
 * 内容型插件表：`[目录名, seed 必需相对路径]`。
 *
 * 目录名同时决定 `relativePath`（apps/zcode-cli/packages/<目录>）与
 * `stagedPath`（packages/<目录>）—— 后者必须与 bootstrap 的 rootCandidates
 * （`packages/<name>-plugin`）对得上，否则 seed 在安装包里找不到插件。
 */
export const CONTENT_PLUGIN_SEEDS = [
  ["documents-plugin", ["agents/visual-judge.md", "skills/docx/SKILL.md"]],
  ["pdf-plugin", ["agents/visual-judge.md", "skills/pdf/SKILL.md"]],
  ["presentations-plugin", ["agents/visual-judge.md", "skills/pptx/SKILL.md"]],
  ["spreadsheets-plugin", ["agents/visual-judge.md", "skills/xlsx/SKILL.md"]],
  [
    "accounting-and-reporting-plugin",
    [
      "skills/account-mapping/SKILL.md",
      "skills/audit-xls/SKILL.md",
      "skills/financial-reporting/SKILL.md",
      "skills/ledger-reconciliation/SKILL.md",
      "skills/month-end-close-review/SKILL.md",
      "skills/report-render/SKILL.md",
      "skills/statement-consistency-check/SKILL.md",
      "skills/xlsx-author/SKILL.md",
    ],
  ],
  [
    "analytics-plugin",
    [
      "skills/analyze-data-quality/SKILL.md",
      "skills/build-dashboard/SKILL.md",
      "skills/design-kpis/SKILL.md",
      "skills/metric-diagnostics/SKILL.md",
    ],
  ],
  ["research-plugin", ["skills/arxiv/SKILL.md", "skills/super-research/SKILL.md"]],
  [
    "obsidian-plugin",
    [
      "skills/defuddle/SKILL.md",
      "skills/excalidraw-diagram/SKILL.md",
      "skills/json-canvas/SKILL.md",
      "skills/knap/SKILL.md",
      "skills/mermaid-visualizer/SKILL.md",
      "skills/obsidian-bases/SKILL.md",
      "skills/obsidian-cli/SKILL.md",
      "skills/obsidian-markdown/SKILL.md",
      "skills/setup/SKILL.md",
    ],
  ],
  [
    // 14 个技能：official-plugin-definitions.ts 只列了 12 个（漏 writing-plans /
    // writing-skills），那份已同步补齐；此处按磁盘实际技能钉住。
    "superpowers-plugin",
    [
      "skills/brainstorming/SKILL.md",
      "skills/dispatching-parallel-agents/SKILL.md",
      "skills/executing-plans/SKILL.md",
      "skills/finishing-a-development-branch/SKILL.md",
      "skills/receiving-code-review/SKILL.md",
      "skills/requesting-code-review/SKILL.md",
      "skills/subagent-driven-development/SKILL.md",
      "skills/systematic-debugging/SKILL.md",
      "skills/test-driven-development/SKILL.md",
      "skills/using-git-worktrees/SKILL.md",
      "skills/using-superpowers/SKILL.md",
      "skills/verification-before-completion/SKILL.md",
      "skills/writing-plans/SKILL.md",
      "skills/writing-skills/SKILL.md",
    ],
  ],
  [
    // 只有 SKILL.md：plugin-creator 才有 scripts/ 那套脚手架（且当前无源码，不随包）
    "skill-creator-plugin",
    ["skills/skill-creator/SKILL.md"],
  ],
  [
    "zcode-guide-plugin",
    [
      "commands/workflow.md",
      "skills/dynamic-workflows/SKILL.md",
      "skills/dynamic-workflows/examples.md",
      "skills/dynamic-workflows/patterns.md",
    ],
  ],
];

/** 内容型插件的 seed 条目（供构建脚本的 staging 循环直接用）。 */
export const CONTENT_PLUGIN_SEED_ENTRIES = CONTENT_PLUGIN_SEEDS.map(([dirName, requiredSeedPaths]) => ({
  relativePath: `apps/zcode-cli/packages/${dirName}`,
  requiresRuntime: false,
  requiredSeedPaths,
  stagedPath: `packages/${dirName}`,
}));

/** 运行时型插件：seed 前必须构建出各自声明的 dist 资产。 */
export const RUNTIME_PLUGIN_PACKAGES = [
  {
    // anydoc + canvas + pdfjs fake worker（parse_document / pdf-research）
    packageName: "@zcode/file-tools-plugin",
    relativePath: "apps/zcode-cli/packages/file-tools-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js", "dist/mcp/pdf.worker.mjs"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/file-tools-plugin",
  },
  {
    // OCR（PP-OCR）：推理引擎在 resources/tools/office-engines，本插件只带 MCP server
    packageName: "@zcode/ocr-tools-plugin",
    relativePath: "apps/zcode-cli/packages/ocr-tools-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/ocr-tools-plugin",
  },
  {
    // DWG 图纸：ACadSharp sidecar 走 resources/tools/dwg-tools，这里只 seed MCP server
    packageName: "@zcode/dwg-tools-plugin",
    relativePath: "apps/zcode-cli/packages/dwg-tools-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/dwg-tools-plugin",
  },
];

/** 全部随包插件的 stagedPath（`packages/<目录>`），供合同与校验用。 */
export const ALL_STAGED_PLUGIN_PATHS = [
  ...RUNTIME_PLUGIN_PACKAGES.map((plugin) => plugin.stagedPath),
  ...CONTENT_PLUGIN_SEED_ENTRIES.map((entry) => entry.stagedPath),
];
