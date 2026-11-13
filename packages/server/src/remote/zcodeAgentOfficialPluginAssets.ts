import { posix } from "node:path";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME = "packages";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES = [
  "android-emulator-plugin",
  "browser-use-plugin",
  "zcode-cua-plugin",
  // ── Reactor 自建插件（上游 v3.18.0 没有这些包）──────────────────────────
  // 2026-11-12 上游同步事故：`2c0fc9dd` 把本文件整块重置成上游版本，这 4 个自建插件
  // 随之从远端合同消失，症状是「本地有、远端没有」且不报错。判定标准是 3-way
  // （上游没动、本地动了 = 真定制），不能按「上游有没有这个文件」判断。
  // 审查技能随包内置：远端工作区跑审查同样需要这些技能。
  "review-skills-plugin",
  // 文件能力三件套：parse/docx、扫描件识字、DWG 图纸。
  "file-tools-plugin",
  "ocr-tools-plugin",
  "dwg-tools-plugin",
  "documents-plugin",
  "pdf-plugin",
  "presentations-plugin",
  "spreadsheets-plugin",
  // ── Reactor 自建内容型技能插件（上游 v3.18.0 没有这些包）──────────────────
  // 2026-11-12 上游同步事故：`2c0fc9dd` 把本文件整块重置成上游版本，这 4 个自建插件
  // 随之从远端合同消失，症状是「本地有、远端没有」且不报错。判定标准是 3-way。
  "accounting-and-reporting-plugin",
  "analytics-plugin",
  "research-plugin",
  "obsidian-plugin",
  "image-search-plugin",
  "ios-simulator-plugin",
  "restore-legacy-sessions-plugin",
  "skill-creator-plugin",
  "plugin-creator-plugin",
  "zcode-guide-plugin",
  "visualize-plugin",
  "zcode-site-plugin",
  "design-plugin",
] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS = [
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // 开发态远程插件复制使用独立白名单，遗漏 agents 会只在远端丢失子代理。
  "agents",
  // file-tools / dwg-tools 的引擎资产树（anydoc/canvas/dwg-sidecar）：远端没有
  // resources/tools 独立分发，少了它 seed 会以「声明了 assets 却没有文件」整体拒绝
  // 这两个插件，症状是文档解析/图纸解析在远端静默不可用。
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
  // 工作流技能已迁出插件；远端复用仍必须检查这份 Agent 必需资产。
  "bundled-skills/skills/dynamic-workflows/SKILL.md",
  "bundled-skills/skills/dynamic-workflows/patterns.md",
  "bundled-skills/skills/dynamic-workflows/examples.md",
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
  "visualize-plugin/skills/visualize/SKILL.md",
  "visualize-plugin/skills/visualize/references/api.md",
  "visualize-plugin/skills/visualize/references/styles.md",
  "visualize-plugin/skills/visualize/tweak.md",
  "visualize-plugin/skills/visualize/LICENSE.md",
  "visualize-plugin/skills/visualize/scripts/render.py",
  "visualize-plugin/skills/visualize/assets/visualize.css",
  "visualize-plugin/skills/visualize/assets/visualize.html",
  "visualize-plugin/skills/visualize/assets/calendar.js",
  "visualize-plugin/skills/visualize/assets/runtime-manifest.json",
  "visualize-plugin/skills/visualize/scripts/vendor.py",
  "visualize-plugin/skills/visualize/assets/vendor/manifest.json",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/vendor/lucide-1.17.0.js",
  "visualize-plugin/skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/vendor/d3-7.9.0.min.js",
  "visualize-plugin/skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/standalone-host-bridge.js",
  "visualize-plugin/skills/visualize/assets/standalone-shell.js",
  "visualize-plugin/skills/visualize/widgets/calendar.md",
  "visualize-plugin/skills/visualize/examples/calendar.html",
  "browser-use-plugin/docs/api.json",
  "browser-use-plugin/docs/documents.json",
  "browser-use-plugin/docs/overview.md",
  // 远端缓存若缺少 recording 正文，documents.json 仍会错误宣告该 lookup 可用。
  "browser-use-plugin/docs/recording.md",
  "browser-use-plugin/docs/workflow.md",
  "browser-use-plugin/scripts/browser-client.mjs",
  "browser-use-plugin/skills/control-browser/SKILL.md",
  "browser-use-plugin/skills/web-gui-tester/SKILL.md",
  // ── Reactor 自建插件的必需资产（缺一项就拒绝复用半成品远端缓存）──────────────
  // 审查技能同理：只校验 plugin.json 会放过「有壳没技能」的残缺目录，
  // 而少一个 SKILL.md 在运行时表现为「这个审查类型答案很水」，不是报错。
  "review-skills-plugin/skills/review-compare/SKILL.md",
  "review-skills-plugin/skills/review-consistency/SKILL.md",
  "review-skills-plugin/skills/review-contract/SKILL.md",
  "review-skills-plugin/skills/review-proofread/SKILL.md",
  "review-skills-plugin/skills/review-proofread/references/typo-dictionary.md",
  "review-skills-plugin/skills/review-standard-check/SKILL.md",
  // 运行时型：MCP server 必须先构建出 dist/mcp/server.js（pdf.worker.mjs 随 bundle 拷贝）。
  "file-tools-plugin/dist/mcp/server.js",
  "file-tools-plugin/dist/mcp/pdf.worker.mjs",
  "ocr-tools-plugin/dist/mcp/server.js",
  "dwg-tools-plugin/dist/mcp/server.js",
  // ── Reactor 自建内容型技能插件的必需资产（缺一项就拒绝复用半成品远端缓存）────
  // 只校验 plugin.json 会放过「有壳没技能」的残缺目录，而少一个 SKILL.md 在运行时
  // 表现为「这个类型答案很水」，不是报错。superpowers 上游已主动下线，不在此列。
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
  // 修复原因：仅校验 manifest 无法发现文档插件缺少技能正文或视觉评审 Agent。
  // 文档插件 0.2.0 起带查看面板，远端还必须有 office-runtime 构建出的 server 与面板资源。
  "image-search-plugin/.mcp.json",
  "documents-plugin/agents/visual-judge.md",
  "documents-plugin/skills/docx/SKILL.md",
  "documents-plugin/skills/docx-viewer/SKILL.md",
  "documents-plugin/dist/server.mjs",
  "documents-plugin/dist/ui/assets.json",
  "documents-plugin/dist/ui/panel.html",
  "pdf-plugin/agents/visual-judge.md",
  "pdf-plugin/skills/pdf/SKILL.md",
  "pdf-plugin/skills/pdf-viewer/SKILL.md",
  "pdf-plugin/dist/server.mjs",
  "pdf-plugin/dist/ui/assets.json",
  "pdf-plugin/dist/ui/panel.html",
  "presentations-plugin/agents/visual-judge.md",
  "presentations-plugin/skills/pptx/SKILL.md",
  "presentations-plugin/skills/pptx-viewer/SKILL.md",
  "presentations-plugin/dist/server.mjs",
  "presentations-plugin/dist/ui/assets.json",
  "presentations-plugin/dist/ui/panel.html",
  "spreadsheets-plugin/agents/visual-judge.md",
  "spreadsheets-plugin/skills/xlsx/SKILL.md",
  "spreadsheets-plugin/skills/xlsx-viewer/SKILL.md",
  "spreadsheets-plugin/dist/server.mjs",
  "spreadsheets-plugin/dist/ui/assets.json",
  "spreadsheets-plugin/dist/ui/panel.html",
  // design 列全本地 seed 必需路径（bootstrap OFFICIAL_DESIGN_REQUIRED_SEED_PATHS，server/test 机械对照），
  // 不像其他插件只列哨兵：hook 找不到 SKILL.md 时静默退出，规则文件与脚本按需读取/执行，缺一份都只在会话里失败。
  "design-plugin/skills/design/SKILL.md",
  "design-plugin/skills/design/references/catalog.md",
  "design-plugin/skills/design/references/check.md",
  "design-plugin/skills/design/references/create.md",
  "design-plugin/skills/design/references/design-system.md",
  "design-plugin/skills/design/references/interact.md",
  "design-plugin/skills/design/references/output.md",
  "design-plugin/skills/design/references/redesign.md",
  "design-plugin/skills/design/scripts/adapt-canvas.mjs",
  "design-plugin/skills/design/scripts/design-lint.mjs",
  "design-plugin/skills/design/scripts/design-tokens.mjs",
  "design-plugin/skills/design/scripts/import-design-system.mjs",
  "design-plugin/hooks/hooks.json",
  "design-plugin/hooks/run-hook.cmd",
  "design-plugin/hooks/design-rules",
  "zcode-cua-plugin/docs/computer-use.md",
  "zcode-cua-plugin/scripts/computer-use-client.mjs",
  "zcode-cua-plugin/skills/computer-use/SKILL.md",
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
