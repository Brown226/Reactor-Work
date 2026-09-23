#!/usr/bin/env node
/**
 * file-tools 资产 staging：把桌面端开箱即用所需的 native 绑定 / ONNX 模型 / wasm
 * 收进一个只读资产树，供 electron-builder 打进安装包（bundled-tools/<platformKey>，
 * 见 packages/desktop/electron-builder.config.js 的 extraResources），并同步一份到
 * apps/zcode-cli/packages/file-tools-plugin/assets/<platformKey> 供开发态 MCP 子进程解析。
 *
 * 固定策略（对齐 scripts/native-search-tools-config.mjs）：
 * - npm 依赖（anydoc / onnxruntime-node / @napi-rs/canvas / libredwg-web）一律
 *   从**本工作区 node_modules** 拷贝，版本即 lockfile 锁定的版本；
 * - PP-OCR 模型从 HuggingFace 镜像下载，sha256 固定（见 OCR_MODEL_FILES）；
 * - libredwg 包内部是「无后缀相对导入」（TS 编译残留），Node ESM 解析不了，
 *   staging 时把导入改写成显式路径（唯一被改写的第三方代码，逐条注释）。
 *
 * 用法：node scripts/prepare-file-tools-assets.mjs [--platform win32-x64] [--from-workspace <path>]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative as relativePath, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const platformKey = readArg("--platform") ?? `${process.platform}-${process.arch}`;
const workspaceRoot = readArg("--from-workspace") ?? repoRoot;
const pluginRoot = join(repoRoot, "apps", "zcode-cli", "packages", "file-tools-plugin");
const bundledRoot = join(repoRoot, "packages", "desktop", "bundled-tools", platformKey, "file-tools");
const devAssetsRoot = join(pluginRoot, "assets", platformKey);

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

/** PP-OCRv5 mobile 模型（repo：x3zvawq/paddleocr-js-onnx，Apache-2.0；字典不得 trimEnd，见 ocr-engine.ts）。 */
const OCR_MODEL_REPO = "https://hf-mirror.com/x3zvawq/paddleocr-js-onnx/resolve/main";
const OCR_MODEL_FILES = [
  {
    path: "ppocr_v5_mobile/PP-OCRv5_mobile_det_infer.onnx",
    sha256: "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae",
  },
  {
    path: "ppocr_v5_mobile/PP-OCRv5_mobile_rec_infer.onnx",
    sha256: "86b1f8bffa31748e0d6364a98af983bbd33b92523141d4a02fa587b4b66b54af",
  },
  {
    path: "ppocr_v5_mobile/ppocrv5_dict.txt",
    sha256: "7680a8a77c6617aba27bc9c52d320f451ae7871613a43b5358ac4a68c88d87c0",
  },
];

/** 运行时 platformKey → npm/napi 平台包后缀。 */
const NPM_PLATFORM_SUFFIX = {
  "win32-x64": "win32-x64-msvc",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
};

/** 布局：<assets>/<name>/node_modules/<scope>/<pkg>（Node require 目录解析）。 */
const FILE_TOOLS_LICENSES = [
  { component: "@firecrawl/anydoc", license: "MIT", source: "npm @firecrawl/anydoc" },
  { component: "onnxruntime-node", license: "MIT", source: "npm onnxruntime-node" },
  { component: "@napi-rs/canvas", license: "MIT", source: "npm @napi-rs/canvas" },
  {
    component: "PP-OCRv5 mobile ONNX models",
    license: "Apache-2.0",
    source: "https://huggingface.co/x3zvawq/paddleocr-js-onnx",
  },
  {
    component: "libredwg-web (@mlightcad)",
    license: "GPL-3.0",
    source: "npm @mlightcad/libredwg-web（LibreDWG，附带源码获取声明）",
  },
];

function copyDirectory(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      writeFileSync(targetPath, readFileSync(sourcePath));
    }
  }
}

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * libredwg 包内 TS 编译残留的「无后缀相对导入」→ 显式路径。只改 import 语句里的
 * 说明符，不改任何执行代码；改前逐条写入 staging 日志保证可审计。
 */
function rewriteLibreDwgImports(treeRoot) {
  const rewrites = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const before = readFileSync(full, "utf8");
      const after = before.replace(
        /(from\s+["'])(\.\.?\/[^"']+?)(["'])/g,
        (match, head, specifier, tail) => {
          if (specifier.endsWith(".js") || specifier.includes(".wasm")) return match;
          const candidates = [
            join(dirname(full), `${specifier}.js`),
            join(dirname(full), specifier, "index.js"),
          ];
          const resolved = candidates.find((candidate) => existsSync(candidate));
          if (!resolved) {
            throw new Error(`libredwg 导入改写无法解析：${specifier}（${full}）`);
          }
          const relative = relativePath(dirname(full), resolved).replace(/\\/g, "/");
          rewrites.push(`${full.slice(treeRoot.length + 1)}: ${specifier} -> ${relative}`);
          return `${head}${relative.startsWith(".") ? relative : `./${relative}`}${tail}`;
        },
      );
      if (after !== before) writeFileSync(full, after);
    }
  };
  walk(treeRoot);
  return rewrites;
}

function resolveWorkspacePackage(name) {
  const base = join(workspaceRoot, "node_modules");
  const direct = join(base, ...name.split("/"));
  if (existsSync(direct)) return direct;
  // pnpm 布局：node_modules/.pnpm/<name>@<ver>/node_modules/<name>
  const pnpmDir = join(base, ".pnpm");
  if (!existsSync(pnpmDir)) return null;
  const prefix = `${name.replace("/", "+")}@`;
  const hit = readdirSync(pnpmDir).find((entry) => entry.startsWith(prefix));
  if (!hit) return null;
  const candidate = join(pnpmDir, hit, "node_modules", ...name.split("/"));
  return existsSync(candidate) ? candidate : null;
}

function stageNpmPackage(packageName, assetsPackagePath) {
  const source = resolveWorkspacePackage(packageName);
  if (!source) throw new Error(`workspace node_modules 里找不到 ${packageName}`);
  const target = join(assetsPackagePath, ...packageName.split("/"));
  copyDirectory(source, target);
  return target;
}

/**
 * onnxruntime-node 的 bin/napi-v6/<os>/<arch>/：只保留本平台组合。
 * 原包带全平台全架构，白占 ~200MB。
 */
function pruneOnnxruntimePlatforms(packageDir, runtimePlatformKey) {
  const [os, arch] = runtimePlatformKey.split("-");
  const napiDir = join(packageDir, "bin", "napi-v6");
  if (!existsSync(napiDir)) return;
  for (const osEntry of readdirSync(napiDir)) {
    const osDir = join(napiDir, osEntry);
    if (!statSync(osDir).isDirectory()) continue;
    if (osEntry !== os) {
      rmSync(osDir, { recursive: true, force: true });
      continue;
    }
    for (const archEntry of readdirSync(osDir)) {
      const archDir = join(osDir, archEntry);
      if (!statSync(archDir).isDirectory()) continue;
      if (archEntry !== arch) rmSync(archDir, { recursive: true, force: true });
    }
  }
}

async function downloadOcrModels(targetDir, cacheDir = null) {
  mkdirSync(targetDir, { recursive: true });
  const results = [];
  for (const model of OCR_MODEL_FILES) {
    const fileName = model.path.split("/").pop();
    const target = join(targetDir, fileName);
    if (existsSync(target) && sha256OfFile(target) === model.sha256) {
      results.push({ file: fileName, sha256: model.sha256, cached: true });
      continue;
    }
    // dev 缓存复用：重复构建（或换目标平台重跑）不重复下载 21MB 模型。
    const cachedCopy = cacheDir ? join(cacheDir, fileName) : null;
    if (cachedCopy && existsSync(cachedCopy) && sha256OfFile(cachedCopy) === model.sha256) {
      writeFileSync(target, readFileSync(cachedCopy));
      results.push({ file: fileName, sha256: model.sha256, cached: true });
      continue;
    }
    const url = `${OCR_MODEL_REPO}/${model.path}`;
    process.stdout.write(`[file-tools] download ${fileName}\n`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载失败 ${url}：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== model.sha256) {
      throw new Error(`sha256 不匹配：${fileName}（${digest} ≠ ${model.sha256}）`);
    }
    writeFileSync(target, bytes);
    results.push({ file: fileName, sha256: digest, cached: false });
  }
  return results;
}

function writeStagingMeta(outRoot, meta) {
  writeFileSync(
    join(outRoot, ".bundle-meta.json"),
    `${JSON.stringify({ ...meta, platform: platformKey }, null, 2)}\n`,
  );
  writeFileSync(
    join(outRoot, "SOURCES.json"),
    `${JSON.stringify(
      {
        platform: platformKey,
        components: FILE_TOOLS_LICENSES.map((item) => ({ ...item, sha256: meta.sha256[item.component] ?? null })),
      },
      null,
      2,
    )}\n`,
  );
  const notices = [
    "THIRD-PARTY NOTICES — file-tools bundled assets",
    "",
    ...FILE_TOOLS_LICENSES.flatMap((item) => [
      `* ${item.component} — ${item.license}`,
      `  Source: ${item.source}`,
      ...(item.license.toUpperCase().startsWith("GPL")
        ? [
            "  This package contains GPL-licensed components. The complete corresponding source code",
            "  is available from the source listed above; written offers for the source are also",
            "  honored via the product maintainer.",
          ]
        : []),
    ]),
    "",
  ].join("\n");
  writeFileSync(join(outRoot, "THIRD-PARTY-NOTICES.txt"), notices);
}

function stageAssets(targetRoot) {
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  const sha256 = {};

  // 1) anydoc（napi + 平台包）
  const anydocRoot = join(targetRoot, "anydoc");
  stageNpmPackage("@firecrawl/anydoc", join(anydocRoot, "node_modules"));
  // @firecrawl/anydoc 的 JS wrapper require 平台包名；把本平台包一起放进同一 node_modules。
  const platformSuffix = NPM_PLATFORM_SUFFIX[platformKey];
  if (!platformSuffix) throw new Error(`不支持的平台：${platformKey}`);
  const platformPackage = `@firecrawl/anydoc-${platformSuffix}`;
  const platformSource = resolveWorkspacePackage(platformPackage);
  if (!platformSource) throw new Error(`workspace node_modules 里找不到 ${platformPackage}`);
  copyDirectory(platformSource, join(anydocRoot, "node_modules", platformPackage));
  sha256["@firecrawl/anydoc"] = null; // 版本即 lockfile；平台包逐文件哈希见 staging 日志

  // 2) onnxruntime-node（bin/napi-v6 只保留本平台；原包带全平台，白占 ~200MB）
  const onnxruntimeRoot = join(targetRoot, "onnxruntime");
  const onnxruntimeDir = stageNpmPackage("onnxruntime-node", join(onnxruntimeRoot, "node_modules"));
  pruneOnnxruntimePlatforms(onnxruntimeDir, platformKey);

  // 3) @napi-rs/canvas + 本平台 skia 绑定（linux 同时带 musl 变体，js-binding 按 libc 选择）
  const canvasRoot = join(targetRoot, "canvas");
  stageNpmPackage("@napi-rs/canvas", join(canvasRoot, "node_modules"));
  const canvasVariants = platformKey.startsWith("linux-")
    ? [`${platformSuffix}`, platformSuffix.replace("-gnu", "-musl")]
    : [platformSuffix];
  for (const variant of canvasVariants) {
    const packageName = `@napi-rs/canvas-${variant}`;
    stageNpmPackage(packageName, join(canvasRoot, "node_modules"));
  }

  // 4) libredwg-web（lib/ + wasm/ 保留相对结构；导入改写）
  const libredwgSource = resolveWorkspacePackage("@mlightcad/libredwg-web");
  if (!libredwgSource) throw new Error("workspace node_modules 里找不到 @mlightcad/libredwg-web");
  const libredwgRoot = join(targetRoot, "libredwg");
  mkdirSync(libredwgRoot, { recursive: true });
  copyDirectory(join(libredwgSource, "lib"), join(libredwgRoot, "lib"));
  copyDirectory(join(libredwgSource, "wasm"), join(libredwgRoot, "wasm"));
  const rewrites = rewriteLibreDwgImports(join(libredwgRoot, "lib"));
  const wasmFile = join(libredwgRoot, "wasm", "libredwg-web.wasm");
  sha256["libredwg-web (@mlightcad)"] = sha256OfFile(wasmFile);

  writeStagingMeta(targetRoot, { sha256, modelFiles: "prepared", libredwgImportRewrites: rewrites.length });
  return { rewrites: rewrites.length };
}

function stageDevCopy(fromRoot) {
  rmSync(devAssetsRoot, { recursive: true, force: true });
  copyDirectory(fromRoot, devAssetsRoot);
}

async function main() {
  process.stdout.write(`[file-tools] staging platform: ${platformKey}\n`);
  // 1) 先保留旧 dev 模型缓存（stageDevCopy 会整树重建 dev 副本）；sha256 不匹配自动回退下载。
  const legacyModelCache = join(devAssetsRoot, "ocr-models");
  const modelCacheDir = existsSync(legacyModelCache) ? legacyModelCache : null;

  // 2) npm 原生依赖 staging（anydoc / onnxruntime / canvas / libredwg）。
  const result = stageAssets(bundledRoot);

  // 3) OCR 模型（网络，sha256 固定；有缓存则不重复下载）。
  const modelResults = await downloadOcrModels(join(bundledRoot, "ocr-models"), modelCacheDir);

  // 4) dev 副本（随插件 seed 覆盖开发态资产解析）。
  stageDevCopy(bundledRoot);

  const total = sumDirectorySize(bundledRoot);
  process.stdout.write(
    `[file-tools] staged → ${bundledRoot}\n[file-tools] dev copy → ${devAssetsRoot}\n` +
      `[file-tools] libredwg import rewrites: ${result.rewrites}; models: ${modelResults.length}; total ${(total / 1024 / 1024).toFixed(1)} MiB\n`,
  );
}

function sumDirectorySize(root) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  walk(root);
  return total;
}

await main();
