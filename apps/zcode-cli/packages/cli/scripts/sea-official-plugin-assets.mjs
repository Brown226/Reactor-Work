import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const seaOfficialPluginAssetPrefix = "zcode-official-plugins/";
export const seaOfficialPluginManifestAssetKey = `${seaOfficialPluginAssetPrefix}manifest.json`;
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // recording lookup 是录屏 API 的模型入口，SEA 不得接受缺失正文的插件资产。
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];

export const officialSeaPlugins = [
  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用的运行时产物，自己不是面向用户的插件
    // （无 skill、无市场 listing）。它必须始终随发布物嵌入，否则任一能力启用时都没有宿主可跑。
    marketplace: "zcode-plugins-official",
    name: "node-repl-host",
    packageName: "@zcode/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    rootPath: join("packages", "node-repl-host"),
    version: "0.6.0",
  },
  {

    marketplace: "zcode-plugins-official",
    name: "browser-use",
    packageName: "@zcode/browser-use-plugin",
    requiresRuntime: true,
    // Browser Use 的 runtime、client、API 文档和 skills 是同一发布单元；
    // SEA 构建必须在嵌入前拒绝任一缺失项，不能把损坏产物留到用户启动时才发现。
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    rootPath: join("packages", "browser-use-plugin"),
    // SEA 清单仍指向旧版时，runtime 会与官方 definition 精确匹配失败，
    // 导致发布产物不 seed browser-use，进而无法装配宿主 node_repl MCP。
    version: "0.5.1",
  },
  {
    // 审查技能：纯内容型插件（只有 skills，没有 MCP server），requiresRuntime:false 跳过
    // runtime 校验，但 requiredSeedPaths 仍逐个钉住 SKILL.md——SEA 产物缺文件时技能会
    // 静默失效，而不是报错。
    marketplace: "zcode-plugins-official",
    name: "review-skills",
    requiresRuntime: false,
    requiredSeedPaths: [
      "skills/review-compare/SKILL.md",
      "skills/review-consistency/SKILL.md",
      "skills/review-contract/SKILL.md",
      "skills/review-proofread/SKILL.md",
      "skills/review-standard-check/SKILL.md",
    ],
    rootPath: join("packages", "review-skills-plugin"),
    version: "0.1.0",
  },
  // 办公四件套：原官方市场插件（cdn-zcode.z.ai seed），因内网隔离部署 fork 进仓库随包分发。
  // 同为纯内容型（requiresRuntime:false）；requiredSeedPaths 与 official-plugin-definitions.ts
  // 四件套条目逐一对应，三处 version 必须同为 0.1.7（见 docs/已完成/已完成-内网办公四件套-fork-spec.md）。
  {
    marketplace: "zcode-plugins-official",
    name: "documents",
    requiresRuntime: false,
    requiredSeedPaths: ["agents/visual-judge.md", "skills/docx/SKILL.md"],
    rootPath: join("packages", "documents-plugin"),
    version: "0.1.7",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "pdf",
    requiresRuntime: false,
    requiredSeedPaths: ["agents/visual-judge.md", "skills/pdf/SKILL.md"],
    rootPath: join("packages", "pdf-plugin"),
    version: "0.1.7",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "presentations",
    requiresRuntime: false,
    requiredSeedPaths: ["agents/visual-judge.md", "skills/pptx/SKILL.md"],
    rootPath: join("packages", "presentations-plugin"),
    version: "0.1.7",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "spreadsheets",
    requiresRuntime: false,
    requiredSeedPaths: ["agents/visual-judge.md", "skills/xlsx/SKILL.md"],
    rootPath: join("packages", "spreadsheets-plugin"),
    version: "0.1.7",
  },
  // 第二批内网 fork：同样纯内容型（requiresRuntime:false），requiredSeedPaths 与
  // official-plugin-definitions.ts 各条目对应，三处 version 一致（见 spec 7.6/第 6 节）。
  {
    marketplace: "zcode-plugins-official",
    name: "zcode-guide",
    requiresRuntime: false,
    requiredSeedPaths: [
      "commands/workflow.md",
      "skills/dynamic-workflows/SKILL.md",
      "skills/dynamic-workflows/examples.md",
      "skills/dynamic-workflows/patterns.md",
    ],
    rootPath: join("packages", "zcode-guide-plugin"),
    version: "0.2.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "skill-creator",
    requiresRuntime: false,
    rootPath: join("packages", "skill-creator-plugin"),
    version: "0.1.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "superpowers",
    requiresRuntime: false,
    requiredSeedPaths: [
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
    ],
    rootPath: join("packages", "superpowers-plugin"),
    version: "5.1.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "obsidian",
    requiresRuntime: false,
    requiredSeedPaths: [
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
    rootPath: join("packages", "obsidian-plugin"),
    version: "0.1.2",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "accounting-and-reporting",
    requiresRuntime: false,
    requiredSeedPaths: [
      "skills/account-mapping/SKILL.md",
      "skills/audit-xls/SKILL.md",
      "skills/financial-reporting/SKILL.md",
      "skills/ledger-reconciliation/SKILL.md",
      "skills/month-end-close-review/SKILL.md",
      "skills/report-render/SKILL.md",
      "skills/statement-consistency-check/SKILL.md",
      "skills/xlsx-author/SKILL.md",
    ],
    rootPath: join("packages", "accounting-and-reporting-plugin"),
    version: "0.1.1",
  },
  // 文件能力三件套（docs/未完成-file-tools拆三插件方案.md）：file-tools=parse/docx/pdf，
  // ocr-tools=扫描件识字，dwg-tools=图纸。requiresRuntime 走 dist/mcp/server.js。
  {
    marketplace: "zcode-plugins-official",
    name: "file-tools",
    packageName: "@zcode/file-tools-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js", "dist/mcp/pdf.worker.mjs"],
    // 与 bootstrap 的 OFFICIAL_PLUGIN_DEFINITIONS.runtimeTopLevelPaths 对齐：
    // anydoc/canvas 引擎资产树。SEA 不采集它，运行期 seed gate 会以
    // 「声明了 assets 却收不到文件」拒绝整个插件（hasDeclaredAssetsButNoFiles）。
    runtimeTopLevelPaths: ["assets"],
    rootPath: join("packages", "file-tools-plugin"),
    version: "0.1.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "ocr-tools",
    packageName: "@zcode/ocr-tools-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeTopLevelPaths: [],
    rootPath: join("packages", "ocr-tools-plugin"),
    version: "0.1.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "dwg-tools",
    packageName: "@zcode/dwg-tools-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    // ACadSharp sidecar 资产树，来源 scripts/prepare-file-tools-assets.mjs。
    runtimeTopLevelPaths: ["assets"],
    rootPath: join("packages", "dwg-tools-plugin"),
    version: "0.1.0",
  },
];

export const collectSeaOfficialPluginAssets = async ({
  requireRuntime = false,
  root,
  stagingDirectory,
} = {}) => {
  const files = [];
  const assets = {};
  const plugins = [];

  await rm(stagingDirectory, {
    force: true,
    recursive: true,
  });

  for (const plugin of officialSeaPlugins) {
    const pluginRoot = resolve(root, plugin.rootPath);
    assertPluginRoot(pluginRoot, plugin);
    assertPluginRequiredSeedAssets(pluginRoot, plugin);
    // 只提供 skills 的内容型插件没有 MCP server，用 requiresRuntime:false 跳过校验；
    // 其余运行时插件仍要在此校验，避免发布缺失可执行入口的产物。
    if (requireRuntime && plugin.requiresRuntime !== false) assertPluginRuntime(pluginRoot, plugin);

    const pluginFiles = [];
    for await (const sourcePath of walkFiles(pluginRoot)) {
      const relativePath = relative(pluginRoot, sourcePath);
      if (!shouldIncludePluginFile(relativePath, plugin)) continue;

      const bytes = await readFile(sourcePath);
      const sourceStats = await stat(sourcePath);
      const assetPath = toPosixPath(
        join(plugin.marketplace, plugin.name, plugin.version, relativePath),
      );
      assets[`${seaOfficialPluginAssetPrefix}${assetPath}`] = sourcePath;
      const file = {
        mode: modeForSeedFile(relativePath, sourceStats.mode),
        path: toPosixPath(relativePath),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      pluginFiles.push(file);
      files.push({
        ...file,
        plugin: plugin.name,
      });
    }

    // 与 bootstrap 运行期 seed gate 同口径的构建期防线：声明了资产树却没采到文件，
    // 宁可让 `pnpm sea` 失败，也不要发布一个注定被拒绝 seed 的插件。
    assertPluginRuntimeAssetPaths(plugin, pluginFiles);

    pluginFiles.sort((left, right) => left.path.localeCompare(right.path));
    plugins.push({
      files: pluginFiles,
      marketplace: plugin.marketplace,
      name: plugin.name,
      version: plugin.version,
    });
  }

  plugins.sort((left, right) => left.name.localeCompare(right.name));
  const manifestHash = createHash("sha256")
    .update(
      JSON.stringify(
        plugins.map((plugin) => [
          plugin.marketplace,
          plugin.name,
          plugin.version,
          plugin.files.map(({ path, sha256, mode }) => [path, sha256, modeForSeedFile(path, mode)]),
        ]),
      ),
    )
    .digest("hex");
  const manifest = {
    hash: manifestHash,
    plugins,
    version: 1,
  };
  const manifestPath = resolve(stagingDirectory, "official-plugins-manifest.json");
  await mkdir(stagingDirectory, {
    recursive: true,
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  assets[seaOfficialPluginManifestAssetKey] = manifestPath;

  return {
    assets,
    manifest,
  };
};

function assertPluginRoot(pluginRoot, plugin) {
  if (!existsSync(join(pluginRoot, ".zcode-plugin", "plugin.json"))) {
    throw new Error(`Missing ${plugin.name} plugin manifest at ${pluginRoot}`);
  }
}

function assertPluginRequiredSeedAssets(pluginRoot, plugin) {
  for (const relativePath of plugin.requiredSeedPaths ?? []) {
    const assetPath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(assetPath)) {
      throw new Error(`Missing ${plugin.name} required seed asset at ${assetPath}`);
    }
  }
}

function assertPluginRuntime(pluginRoot, plugin) {
  for (const relativePath of plugin.requiredRuntimePaths ?? ["dist/mcp/server.js"]) {
    const runtimePath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      const assetKind = relativePath === "dist/mcp/server.js" ? "MCP runtime" : "runtime asset";
      throw new Error(
        `Missing ${plugin.name} ${assetKind} at ${runtimePath}. ` +
          `Run \`pnpm --filter ${plugin.packageName} build\` before \`pnpm sea\`.`,
      );
    }
  }
}

async function* walkFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (shouldSkipDirectory(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile()) {
      yield fullPath;
    }
  }
}

const shouldSkipDirectory = (name) =>
  name === "node_modules" ||
  name === ".turbo" ||
  name === "coverage" ||
  name === ".venv" ||
  name === "__pycache__";

const includedTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // SEA 资源采集曾只允许 skills/commands，导致 document-skills 的 judge 子代理未进入可执行文件。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);

const shouldIncludePluginFile = (relativePath, plugin) => {
  const segments = relativePath.split(sep);
  if (segments.includes(".DS_Store") || segments.some((segment) => segment.endsWith(".pyc"))) {
    return false;
  }
  const [topLevel] = relativePath.split(sep);
  if (topLevel === undefined) return false;
  if (includedTopLevelPaths.has(topLevel)) return true;
  // 声明了 runtimeTopLevelPaths 的插件（如 file-tools / dwg-tools 的引擎资产树）
  // 按声明放行；不声明的一律不收，避免把无关大目录卷进 SEA 产物。
  return (plugin.runtimeTopLevelPaths ?? []).includes(topLevel);
};

const assertPluginRuntimeAssetPaths = (plugin, pluginFiles) => {
  const declared = plugin.runtimeTopLevelPaths ?? [];
  for (const topLevel of declared) {
    const collected = pluginFiles.some((file) => file.path.split("/")[0] === topLevel);
    if (!collected) {
      throw new Error(
        `Missing ${plugin.name} runtime asset tree "${topLevel}/" in the SEA staging. ` +
          `Run \`node scripts/prepare-file-tools-assets.mjs\` before \`pnpm sea\`.`,
      );
    }
  }
};

const toPosixPath = (value) => value.split(sep).join("/");

const modeForSeedFile = (filePath, sourceMode) => {
  if (sourceMode !== undefined && (sourceMode & 0o111) !== 0) return 0o755;

  const normalizedPath = toPosixPath(filePath);
  if (/(?:^|\/)dist\/mcp\/server\.js$/i.test(normalizedPath)) return 0o755;
  if (/^hooks\//u.test(normalizedPath) && !/\.(json|md|txt)$/iu.test(normalizedPath)) {
    return 0o755;
  }

  return 0o644;
};
