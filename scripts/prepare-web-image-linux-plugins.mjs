#!/usr/bin/env node
/**
 * Web 镜像（linux-x64）内置官方插件 staging。
 *
 * 为什么需要：桌面安装包把官方插件 seed 源放在 `resources/glm/packages/*-plugin`
 * （bootstrap `resolveFilesystemPluginRoot` 的 `rootCandidates` 就按这个相对路径找）。
 * Web 镜像此前只复制了 `zcode.cjs` 与工具资产，没有插件包，于是：
 * - 插件市场「个人/公开」都为空；
 * - dwg_modify / dwg_graph、parse_document、OCR 等 MCP 工具在 Web 端不可达。
 *
 * 产物：`<outRoot>/agent/packages/<plugin>`，容器内即 `/app/agent/packages`。
 * 来源优先级：桌面已 stage 的 `resources/glm/packages`（含构建好的 dist）→ 仓库源码
 * （源码缺少 dist 时由调用方先跑插件 build）。平台资产只保留 linux-x64：
 * - dwg-tools：仓库 `assets/linux-x64`（自包含 sidecar）；
 * - file-tools：复用 `<outRoot>/bundled-tools/linux-x64/file-tools`（任何原生依赖按 Linux 重取）。
 * 运行时仍优先读 ZCODE_DWG_TOOLS_ASSETS_ROOT / ZCODE_FILE_TOOLS_ASSETS_ROOT；
 * 插件 assets 树只用于通过 seed 的「声明了 assets 必须非空」校验。
 *
 * 用法：node scripts/prepare-web-image-linux-plugins.mjs <构建上下文目录>
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const outRoot = resolve(process.argv[2] ?? "");
if (!outRoot) {
  console.error("用法：node scripts/prepare-web-image-linux-plugins.mjs <构建上下文目录>");
  process.exit(1);
}
const repoRoot = resolve(import.meta.dirname, "..");
const desktopPlugins = join(
  repoRoot,
  "packages",
  "desktop",
  "dist",
  "win-unpacked",
  "resources",
  "glm",
  "packages",
);
const sourcePlugins = join(repoRoot, "apps", "zcode-cli", "packages");
const targetRoot = join(outRoot, "agent", "packages");

// 官方 seed 的根候选是 packages/<name>-plugin；桌面树是同一布局的已 stage 产物。
const PLUGIN_NAMES = [
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
  "review-skills-plugin",
  "skill-creator-plugin",
  "zcode-guide-plugin",
];

const SKIP_SEGMENTS = new Set([
  "node_modules",
  ".turbo",
  "dist-types",
  "coverage",
  "__pycache__",
  ".venv",
]);

function shouldSkip(path) {
  const segments = path.split(/[\\/]/);
  // assets 树里的 node_modules 是原生依赖（anydoc/canvas），必须随包；
  // 只有插件根/源码树的开发态 node_modules 才剪掉。
  const insideAssets = segments.includes("assets");
  return segments.some(
    (segment) =>
      (SKIP_SEGMENTS.has(segment) && !(insideAssets && segment === "node_modules")) ||
      segment.endsWith(".map"),
  );
}

function copyDirectory(source, target) {
  cpSync(source, target, { recursive: true, filter: (path) => !shouldSkip(path) });
}

function replaceAssets(pluginName, target) {
  const assetsRoot = join(target, "assets");
  for (const variant of ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64"]) {
    rmSync(join(assetsRoot, variant), { recursive: true, force: true });
  }
  if (pluginName === "dwg-tools-plugin") {
    const source = join(sourcePlugins, pluginName, "assets", "linux-x64");
    if (!existsSync(source)) throw new Error(`dwg-tools linux 资产缺失：${source}`);
    rmSync(join(assetsRoot, "linux-x64"), { recursive: true, force: true });
    // 资产树原样拷贝：其中的 node_modules 是 sidecar/原生依赖，不能再按开发态过滤。
    cpSync(source, join(assetsRoot, "linux-x64"), { recursive: true });
  }
  if (pluginName === "file-tools-plugin") {
    const source = join(outRoot, "bundled-tools", "linux-x64", "file-tools");
    if (!existsSync(source)) {
      throw new Error(`file-tools linux 资产缺失：${source}（先跑 prepare-web-image-linux-tools）`);
    }
    rmSync(join(assetsRoot, "linux-x64"), { recursive: true, force: true });
    cpSync(source, join(assetsRoot, "linux-x64"), { recursive: true });
  }
}

function assertSeedFiles(pluginName, target) {
  const required = ["dist/mcp/server.js", ".zcode-plugin/plugin.json"];
  for (const relative of required) {
    if (!existsSync(join(target, relative))) {
      throw new Error(`${pluginName} 缺少 seed 必需文件：${relative}`);
    }
  }
  const assetsRoot = join(target, "assets");
  if (existsSync(assetsRoot)) {
    const hasFile = (dir) =>
      readdirSync(dir).some((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? hasFile(full) : true;
      });
    if (!hasFile(assetsRoot)) {
      throw new Error(`${pluginName} 声明了 assets 但目录为空（seed 会拒绝整个插件）`);
    }
  }
}

rmSync(targetRoot, { recursive: true, force: true });
mkdirSync(targetRoot, { recursive: true });

const RUNTIME_PLUGINS = new Set(["file-tools-plugin", "ocr-tools-plugin", "dwg-tools-plugin"]);

for (const name of PLUGIN_NAMES) {
  const fromDesktop = join(desktopPlugins, name);
  const fromRepo = join(sourcePlugins, name);
  // 插件壳/skills/入口统一用桌面 stage 树（已按 seed 白名单裁剪，避免把 tools/bin、src
  // 等开发产物带进镜像）；运行时插件的 dist 必须用仓库刚构建的版本 —— 桌面树可能落后于
  // 本次修复（例如 OCR 的 office_skill_lib Linux 路径）。
  const source = existsSync(fromDesktop) ? fromDesktop : fromRepo;
  if (!existsSync(source)) {
    throw new Error(`找不到插件源：${name}（桌面 stage 树与仓库源码都没有）`);
  }
  const target = join(targetRoot, name);
  process.stdout.write(`[web-image] stage plugin ${name}\n`);
  copyDirectory(source, target);
  const repoDist = join(fromRepo, "dist");
  if (RUNTIME_PLUGINS.has(name) && existsSync(join(repoDist, "mcp", "server.js"))) {
    // 只取 MCP server 产物：仓库 dist 下还有 sidecar/win 平台产物与 source map，
    // 它们不是插件 seed 资产（sidecar 由 ZCODE_DWG_TOOLS_ASSETS_ROOT 提供）。
    rmSync(join(target, "dist"), { recursive: true, force: true });
    mkdirSync(join(target, "dist"), { recursive: true });
    cpSync(join(repoDist, "mcp"), join(target, "dist", "mcp"), {
      recursive: true,
      filter: (path) => !path.endsWith(".map"),
    });
  }
  replaceAssets(name, target);
  // 内容型插件没有 dist/mcp/server.js；只对运行时插件做强校验。
  if (RUNTIME_PLUGINS.has(name)) {
    assertSeedFiles(name, target);
  }
}

const total = (function size(dir) {
  let sum = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    sum += info.isDirectory() ? size(full) : info.size;
  }
  return sum;
})(targetRoot);
console.log(
  `[web-image] 官方插件 staged → ${targetRoot}（${(total / 1024 / 1024).toFixed(0)} MiB）`,
);
