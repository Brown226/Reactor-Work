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

// 文档插件查看面板的构建产物（office-runtime 输出到各插件 dist/）。
const officeViewerRuntimePaths = ["dist/server.mjs", "dist/ui/assets.json", "dist/ui/panel.html"];

export const officialSeaPlugins = [
  {
    marketplace: "zcode-plugins-official",
    name: "visualize",
    packageName: "@zcode/visualize-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [
      "skills/visualize/SKILL.md",
      "skills/visualize/references/api.md",
      "skills/visualize/references/styles.md",
      "skills/visualize/tweak.md",
      "skills/visualize/LICENSE.md",
      "skills/visualize/scripts/render.py",
      "skills/visualize/assets/visualize.css",
      "skills/visualize/assets/visualize.html",
      "skills/visualize/assets/calendar.js",
      "skills/visualize/assets/runtime-manifest.json",
      "skills/visualize/scripts/vendor.py",
      "skills/visualize/assets/vendor/manifest.json",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
      "skills/visualize/assets/vendor/lucide-1.17.0.js",
      "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
      "skills/visualize/widgets/calendar.md",
      "skills/visualize/examples/calendar.html",
      "skills/visualize/assets/standalone-host-bridge.js",
      "skills/visualize/assets/standalone-shell.js",
    ],
    rootPath: join("packages", "visualize-plugin"),
    version: "0.1.2",
  },
  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用的运行时产物，自己不是面向用户的插件
    // （无 skill、无市场 listing）。它必须始终随发布物嵌入，否则任一能力启用时都没有宿主可跑。
    marketplace: "zcode-plugins-official",
    name: "node-repl-host",
    packageName: "@zcode/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    rootPath: join("packages", "node-repl-host"),
    version: "0.7.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "android-emulator",
    packageName: "@zcode/android-emulator-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    rootPath: join("packages", "android-emulator-plugin"),
    version: "0.1.1",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "documents",
    packageName: "@zcode/documents-plugin",
    // 0.2.0 起带查看面板：SEA 必须在嵌入前校验 office-runtime 构建出的 server 与面板资源。
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/docx/SKILL.md",
      "skills/docx-viewer/SKILL.md",
    ],
    rootPath: join("packages", "documents-plugin"),
    // 修复原因：SEA manifest 必须与 package、plugin manifest 和官方 definition 同步，避免发布产物嵌入旧版本。
    version: "0.2.2",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "image-search",
    packageName: "@zcode/image-search-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [".mcp.json"],
    rootPath: join("packages", "image-search-plugin"),
    // 修复原因：SEA manifest 必须与 package、plugin manifest 和官方 definition 同步，避免发布产物嵌入旧版本。
    version: "0.1.1",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "pdf",
    packageName: "@zcode/pdf-plugin",
    // 0.2.0 起带查看面板：SEA 必须在嵌入前校验 office-runtime 构建出的 server 与面板资源。
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/pdf/SKILL.md",
      "skills/pdf-viewer/SKILL.md",
    ],
    rootPath: join("packages", "pdf-plugin"),
    // 修复原因：SEA manifest 必须与 package、plugin manifest 和官方 definition 同步，避免发布产物嵌入旧版本。
    version: "0.2.3",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "presentations",
    packageName: "@zcode/presentations-plugin",
    // 0.2.0 起带查看面板：SEA 必须在嵌入前校验 office-runtime 构建出的 server 与面板资源。
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/pptx/SKILL.md",
      "skills/pptx-viewer/SKILL.md",
    ],
    rootPath: join("packages", "presentations-plugin"),
    // 修复原因：SEA manifest 必须与 package、plugin manifest 和官方 definition 同步，避免发布产物嵌入旧版本。
    version: "0.2.2",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "spreadsheets",
    packageName: "@zcode/spreadsheets-plugin",
    // 0.2.0 起带查看面板：SEA 必须在嵌入前校验 office-runtime 构建出的 server 与面板资源。
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/xlsx/SKILL.md",
      "skills/xlsx-viewer/SKILL.md",
    ],
    rootPath: join("packages", "spreadsheets-plugin"),
    // 修复原因：SEA manifest 必须与 package、plugin manifest 和官方 definition 同步，避免发布产物嵌入旧版本。
    version: "0.2.2",
  },
  {
    // browser-use 使用真实 node_repl MCP runtime，SEA 必须校验并嵌入 server.js。
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
    marketplace: "zcode-plugins-official",
    name: "ios-simulator",
    packageName: "@zcode/ios-simulator-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    rootPath: join("packages", "ios-simulator-plugin"),
    version: "0.1.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "restore-legacy-sessions",
    packageName: "@zcode/restore-legacy-sessions-plugin",
    requiresRuntime: false,
    rootPath: join("packages", "restore-legacy-sessions-plugin"),
    version: "0.1.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "skill-creator",
    packageName: "@zcode/skill-creator-plugin",
    requiresRuntime: false,
    rootPath: join("packages", "skill-creator-plugin"),
    version: "0.1.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "plugin-creator",
    packageName: "@zcode/plugin-creator-plugin",
    requiresRuntime: false,
    rootPath: join("packages", "plugin-creator-plugin"),
    version: "0.1.1",
  },
  {
    // 纯内容型（只提供 skills）：requiresRuntime:false，SEA 构建不校验 dist/mcp/server.js。
    // 版本必须与 package.json / plugin.json / official-plugin-definitions.ts 同步 bump——
    // runtime 按 (name, version) 精确匹配 SEA 资产，这里落后会让整个插件在 SEA 下不 seed
    // （browser-use 0.3.1 的既有教训，build-sea.test.mjs:564 钉住四处对齐）。
    // 0.3.0：`/workflow` 与 dynamic-workflows 技能移出本插件（见 sea-bundled-skill-assets.mjs）。
    marketplace: "zcode-plugins-official",
    name: "zcode-guide",
    packageName: "@zcode/zcode-guide-plugin",
    requiresRuntime: false,
    requiredSeedPaths: ["skills/zcode-configuration-guide/SKILL.md"],
    rootPath: join("packages", "zcode-guide-plugin"),
    version: "0.3.0",
  },
  {
    // skill + start.sh 模板 + 零依赖的 zcode-site CLI，加上 Sites 面板（dist/ 下的 MCP server 与页面，
    // 由插件自己的 build 脚本构建）。版本与 package.json / plugin.json / official-plugin-definitions.ts 同步 bump。
    marketplace: "zcode-plugins-official",
    name: "zcode-site",
    packageName: "@zcode/zcode-site-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/server.mjs", "dist/ui/panel.html"],
    requiredSeedPaths: [
      "scripts/zcode-site.mjs",
      "scripts/stage.mjs",
      "scripts/errors.mjs",
      "skills/site-deploy/SKILL.md",
    ],
    rootPath: join("packages", "zcode-site-plugin"),
    version: "0.5.0",
  },
  {
    // design：纯内容型（技能 + 设计资源 + SessionStart hook），requiresRuntime:false。
    // requiredSeedPaths 与 official-plugin-definitions.ts 的 OFFICIAL_DESIGN_REQUIRED_SEED_PATHS 一致；
    // 版本与 package.json / plugin.json / definitions 同步 bump。
    marketplace: "zcode-plugins-official",
    name: "design",
    packageName: "@zcode/design-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [
      "skills/design/SKILL.md",
      "skills/design/references/catalog.md",
      "skills/design/references/check.md",
      "skills/design/references/create.md",
      "skills/design/references/design-system.md",
      "skills/design/references/interact.md",
      "skills/design/references/output.md",
      "skills/design/references/redesign.md",
      "skills/design/scripts/adapt-canvas.mjs",
      "skills/design/scripts/design-lint.mjs",
      "skills/design/scripts/design-tokens.mjs",
      "skills/design/scripts/import-design-system.mjs",
      "hooks/hooks.json",
      "hooks/run-hook.cmd",
      "hooks/design-rules",
    ],
    rootPath: join("packages", "design-plugin"),
    version: "0.7.2",
  },
  // ── Reactor 自建插件（上游 v3.18.0 没有这些包）──────────────────────────────
  // 2026-11-12 上游同步事故：`2c0fc9dd` 把本清单里的 4 个自建插件整块删掉，SEA 产物
  // 不再嵌入它们，安装包里图纸解析 / 扫描件识别 / 文件审查直接消失。
  // 判定标准是 3-way（上游没动、本地动了 = 真定制）。
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
      "skills/review-proofread/references/punctuation-rules.md",
      "skills/review-proofread/references/typo-dictionary.md",
      "skills/review-standard-check/SKILL.md",
    ],
    rootPath: join("packages", "review-skills-plugin"),
    version: "0.1.0",
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
  // superpowers 已从内置插件下线，改走 UI 推荐区按需安装；这里不再打入 SEA 资源清单。
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

    pluginFiles.sort((left, right) => left.path.localeCompare(right.path));
    // 先断言资产树，再推进 manifest：缺引擎的插件必须在采集阶段炸掉，而不是发布后才被发现。
    assertPluginRuntimeAssetPaths(plugin, pluginFiles);
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

// 声明了 runtimeTopLevelPaths 的插件，SEA 采集阶段就必须收到至少一个资产文件。
// 缺了会让「有插件壳、无引擎」的残缺产物直接发布，运行期 seed 再整体拒绝该插件。
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
