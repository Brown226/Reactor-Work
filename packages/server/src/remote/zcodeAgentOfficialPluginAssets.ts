import { posix } from "node:path";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME = "packages";

/**
 * 随包官方插件的目录名（= `packages/<目录>`，即 seed 的 rootCandidates）。
 *
 * ⚠ 与 `scripts/official-plugin-seeds.mjs`（桌面打包 + 远端预构建共用的单一数据源）
 * **一一对应**：那份漏一个，这里就会在 dev 态 SSH 部署时静默少一个插件——
 * 「本地有、远端没有」没有任何报错。2026-10-09 已把两份补满到 17 个随包插件
 * （历史：44b25ed46c 只改了一部分，安装包一度只剩 3 个而 dev 链仍拿全部）。
 *
 * 唯一的有意差异：`node-repl-host` 不进这份合同 —— 远端工作区当前不承载
 * Browser Use / Computer Use，宿主 runtime 部署了也没有消费者。
 */
export const REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES = [
  "browser-use-plugin",
  // 审查技能随包内置：远端工作区跑审查同样需要这些技能。缺了不报错，只是静默没有技能，
  // 所以这里必须进合同，靠 required 相对路径在部署前拦住半成品。
  "review-skills-plugin",
  // ── 以下 14 个为 2026-10-09 补全（与官方插件集合对齐）────────────────────
  "file-tools-plugin",
  "ocr-tools-plugin",
  "dwg-tools-plugin",
  "documents-plugin",
  "pdf-plugin",
  "presentations-plugin",
  "spreadsheets-plugin",
  "accounting-and-reporting-plugin",
  "analytics-plugin",
  "research-plugin",
  "obsidian-plugin",
  "superpowers-plugin",
  "skill-creator-plugin",
  "zcode-guide-plugin",
] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS = [
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // 开发态远程插件复制使用独立白名单，遗漏 agents 会只在远端丢失子代理。
  "agents",
  // file-tools / dwg-tools 的引擎资产树：远端没有 resources/tools 独立分发，
  // 少了它 seed 会以「声明了 assets 却没有文件」整体拒绝这两个插件。
  "assets",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // Browser bootstrap 会从插件根目录动态导入 scripts/browser-client.mjs。
  // 开发态 SSH 部署若漏掉 scripts，会出现 MCP server 已启动但浏览器绑定无法初始化的半成品状态。
  "scripts",
  "skills",
  "templates",
] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS = [
  ...REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES.map(
    (packageName) => `${packageName}/.zcode-plugin/plugin.json`,
  ),
  // 只校验 Browser Use manifest 会把“有插件壳”的残缺目录
  // 误判为可复用。生产 remote、开发态 remote 与 release source 校验共用这份必需资产合同。
  //
  // 这里只能列 browser-use **自己产出**的资产。node_repl 宿主抽成 @zcode/node-repl-host 后
  // browser-use 不再产出 dist/mcp/server.js；
  // 本清单里指向不存在的文件，会让远端资产校验对着幽灵路径报缺失。
  // 远程工作区当前不承载 Browser Use / Computer Use，因此宿主 runtime 不进这份远端合同——
  // 要支持远程 bua/cua 时，应把 node-repl-host 补进上面的 PACKAGE_NAMES 并在此声明它的
  // dist/mcp/server.js，而不是把宿主产物挂回 browser-use 名下。
  "browser-use-plugin/docs/api.json",
  "browser-use-plugin/docs/documents.json",
  "browser-use-plugin/docs/overview.md",
  // 远端缓存若缺少 recording 正文，documents.json 仍会错误宣告该 lookup 可用。
  "browser-use-plugin/docs/recording.md",
  "browser-use-plugin/docs/workflow.md",
  "browser-use-plugin/scripts/browser-client.mjs",
  "browser-use-plugin/skills/control-browser/SKILL.md",
  "browser-use-plugin/skills/web-gui-tester/SKILL.md",
  // 仅校验 manifest 无法发现文档插件缺少技能正文或视觉评审 Agent。
  //
  // 审查技能同理：只校验 plugin.json 会放过「有壳没技能」的残缺目录，
  // 而少一个 SKILL.md 在运行时表现为「这个审查类型答案很水」，不是报错。
  "review-skills-plugin/skills/review-compare/SKILL.md",
  "review-skills-plugin/skills/review-consistency/SKILL.md",
  "review-skills-plugin/skills/review-contract/SKILL.md",
  "review-skills-plugin/skills/review-proofread/SKILL.md",
  "review-skills-plugin/skills/review-proofread/references/typo-dictionary.md",
  "review-skills-plugin/skills/review-standard-check/SKILL.md",
  // ── 以下 14 个插件为 2026-10-09 补全（与 scripts/official-plugin-seeds.mjs 同源）──
  // 运行时型（MCP server 必须先构建出 dist/mcp/server.js）
  "file-tools-plugin/dist/mcp/server.js",
  "file-tools-plugin/dist/mcp/pdf.worker.mjs",
  "ocr-tools-plugin/dist/mcp/server.js",
  "dwg-tools-plugin/dist/mcp/server.js",
  // 办公四件套：技能正文 + 视觉评审子代理
  "documents-plugin/agents/visual-judge.md",
  "documents-plugin/skills/docx/SKILL.md",
  "pdf-plugin/agents/visual-judge.md",
  "pdf-plugin/skills/pdf/SKILL.md",
  "presentations-plugin/agents/visual-judge.md",
  "presentations-plugin/skills/pptx/SKILL.md",
  "spreadsheets-plugin/agents/visual-judge.md",
  "spreadsheets-plugin/skills/xlsx/SKILL.md",
  // 内容型技能集：逐个钉住 SKILL.md（少一个就只是"这个类型答案变水"，没有报错）
  "accounting-and-reporting-plugin/skills/account-mapping/SKILL.md",
  "accounting-and-reporting-plugin/skills/audit-xls/SKILL.md",
  "accounting-and-reporting-plugin/skills/financial-reporting/SKILL.md",
  "accounting-and-reporting-plugin/skills/ledger-reconciliation/SKILL.md",
  "accounting-and-reporting-plugin/skills/month-end-close-review/SKILL.md",
  "accounting-and-reporting-plugin/skills/report-render/SKILL.md",
  "accounting-and-reporting-plugin/skills/statement-consistency-check/SKILL.md",
  "accounting-and-reporting-plugin/skills/xlsx-author/SKILL.md",
  "analytics-plugin/skills/analyze-data-quality/SKILL.md",
  "analytics-plugin/skills/build-dashboard/SKILL.md",
  "analytics-plugin/skills/design-kpis/SKILL.md",
  "analytics-plugin/skills/metric-diagnostics/SKILL.md",
  "research-plugin/skills/arxiv/SKILL.md",
  "research-plugin/skills/super-research/SKILL.md",
  "obsidian-plugin/skills/defuddle/SKILL.md",
  "obsidian-plugin/skills/excalidraw-diagram/SKILL.md",
  "obsidian-plugin/skills/json-canvas/SKILL.md",
  "obsidian-plugin/skills/knap/SKILL.md",
  "obsidian-plugin/skills/mermaid-visualizer/SKILL.md",
  "obsidian-plugin/skills/obsidian-bases/SKILL.md",
  "obsidian-plugin/skills/obsidian-cli/SKILL.md",
  "obsidian-plugin/skills/obsidian-markdown/SKILL.md",
  "obsidian-plugin/skills/setup/SKILL.md",
  "superpowers-plugin/skills/brainstorming/SKILL.md",
  "superpowers-plugin/skills/dispatching-parallel-agents/SKILL.md",
  "superpowers-plugin/skills/executing-plans/SKILL.md",
  "superpowers-plugin/skills/finishing-a-development-branch/SKILL.md",
  "superpowers-plugin/skills/receiving-code-review/SKILL.md",
  "superpowers-plugin/skills/requesting-code-review/SKILL.md",
  "superpowers-plugin/skills/subagent-driven-development/SKILL.md",
  "superpowers-plugin/skills/systematic-debugging/SKILL.md",
  "superpowers-plugin/skills/test-driven-development/SKILL.md",
  "superpowers-plugin/skills/using-git-worktrees/SKILL.md",
  "superpowers-plugin/skills/using-superpowers/SKILL.md",
  "superpowers-plugin/skills/verification-before-completion/SKILL.md",
  "superpowers-plugin/skills/writing-plans/SKILL.md",
  "superpowers-plugin/skills/writing-skills/SKILL.md",
  "skill-creator-plugin/skills/skill-creator/SKILL.md",
  "zcode-guide-plugin/commands/workflow.md",
  "zcode-guide-plugin/skills/dynamic-workflows/SKILL.md",
  "zcode-guide-plugin/skills/dynamic-workflows/examples.md",
  "zcode-guide-plugin/skills/dynamic-workflows/patterns.md",
] as const;

export function buildRemoteAgentOfficialPluginDir(remoteProviderDir: string): string {
  return posix.join(remoteProviderDir, REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME);
}

export function buildRemoteAgentOfficialPluginSourceRelativePath(params: {
  runtimeResourceDir: string;
  platformArch: string;
}): string {
  return posix.join(
    params.runtimeResourceDir,
    params.platformArch,
    REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
  );
}

export function buildRemoteAgentOfficialPluginRequiredPaths(remoteProviderDir: string): string[] {
  const remoteOfficialPluginDir = buildRemoteAgentOfficialPluginDir(remoteProviderDir);
  return REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS.map((relativePath) =>
    posix.join(remoteOfficialPluginDir, relativePath),
  );
}
