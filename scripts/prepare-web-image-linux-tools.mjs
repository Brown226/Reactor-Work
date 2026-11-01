#!/usr/bin/env node
/**
 * Web 镜像（linux-x64）的 agent 能力资产 staging：对齐桌面安装包 bundled-tools 的能力面。
 *
 * 产出（<outRoot>/bundled-tools/linux-x64/）：
 * - file-tools/  anydoc + canvas（Node 目录布局，与 scripts/prepare-file-tools-assets.mjs 同构）；
 *   Linux 平台 napi 包（anydoc/canvas 的 gnu+musl 变体）从 npm 镜像源拉取，版本钉死在
 *   桌面资产树已随包的 JS 包 optionalDependencies 上（anydoc 0.2.4 / canvas 1.0.9）。
 * - office-engines/  fonts + ocr-models 直接复用桌面资产树（平台无关）；
 *   python/ 只建目录骨架 + office_skill_lib（纯 Python），二方依赖由 Dockerfile
 *   在构建期用 apt python3 + pip（国内镜像）装进 site-packages——Debian 的 CPython
 *   与 manylinux wheel 天然匹配，不需要桌面侧的 embeddable+cp312-win 机制。
 *
 * 运行时解析依据（无需额外约定）：
 * - file-tools 资产根：ZCODE_FILE_TOOLS_ASSETS_ROOT（Dockerfile 注入）；
 * - office 引擎根：ZCODE_SKILL_ENGINE_ROOT（Dockerfile 注入）；
 * - LibreOffice / ripgrep / ugrep：Dockerfile apt 安装，走 PATH 解析。
 *
 * 用法：node scripts/prepare-web-image-linux-tools.mjs <构建上下文目录>
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const outRoot = resolve(process.argv[2] ?? "");
if (!outRoot) {
  console.error("用法：node scripts/prepare-web-image-linux-tools.mjs <构建上下文目录>");
  process.exit(1);
}
const repoRoot = resolve(import.meta.dirname, "..");
const winTree = join(repoRoot, "packages", "desktop", "bundled-tools", "win32-x64");
const targetRoot = join(outRoot, "bundled-tools", "linux-x64");
const NPM_REGISTRY = "https://registry.npmmirror.com";

for (const required of [
  join(winTree, "file-tools", "anydoc"),
  join(winTree, "office-engines", "fonts"),
]) {
  if (!existsSync(required)) {
    console.error(`桌面资产树缺失：${required}（先跑桌面打包的 prepare 脚本）`);
    process.exit(1);
  }
}

/** 从 npm 镜像源拉平台包 tgz 并解到 <dest>/（tarball 顶层 package/ 剥掉）。 */
async function fetchNpmPackage(name, version, dest) {
  const scoped = name.startsWith("@") ? `${name.split("/")[0]}%2F${name.split("/")[1]}` : name;
  const url = `${NPM_REGISTRY}/${scoped}/-/${name.split("/").pop()}-${version}.tgz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${url}：HTTP ${response.status}`);
  mkdirSync(dest, { recursive: true });
  const tgz = join(dest, "pkg.tgz");
  writeFileSync(tgz, Buffer.from(await response.arrayBuffer()));
  const result = spawnTar(tgz, dest);
  if (result !== 0) throw new Error(`解包失败：${dest}`);
  rmSync(tgz, { force: true });
  // tarball 内容在 package/ 下，上提一层
  const inner = join(dest, "package");
  if (existsSync(inner)) {
    for (const entry of readdirSync(inner)) {
      cpSync(join(inner, entry), join(dest, entry), { recursive: true });
    }
    rmSync(inner, { recursive: true, force: true });
  }
  return join(dest, "package.json");
}

function spawnTar(tgz, dest) {
  // Windows 自带 bsdtar 会把 "C:\..." 解析成远程主机路径，必须在 dest 里用相对路径
  const result = spawnSync("tar", ["-xzf", "pkg.tgz"], { cwd: dest, stdio: "pipe" });
  if (result.status !== 0) {
    console.error(String(result.stderr));
  }
  return result.status;
}

async function stageFileTools() {
  const root = join(targetRoot, "file-tools");
  rmSync(root, { recursive: true, force: true });
  // JS 包（平台无关）直接复用桌面资产树里的 node_modules 布局
  cpSync(join(winTree, "file-tools", "anydoc"), join(root, "anydoc"), { recursive: true });
  cpSync(join(winTree, "file-tools", "canvas"), join(root, "canvas"), { recursive: true });
  // Linux 平台 napi 包按 optionalDependencies 钉的版本拉取（JS wrapper 按包名 require）
  const anydocPkg = join(root, "anydoc", "node_modules", "@firecrawl", "anydoc", "package.json");
  const canvasPkg = join(root, "canvas", "node_modules", "@napi-rs", "canvas", "package.json");
  const anydocVersion = JSON.parse(readFileSync(anydocPkg, "utf8")).version;
  const canvasVersion = JSON.parse(readFileSync(canvasPkg, "utf8")).version;
  const fetches = [
    [
      "@firecrawl/anydoc-linux-x64-gnu",
      anydocVersion,
      join(root, "anydoc", "node_modules", "@firecrawl", "anydoc-linux-x64-gnu"),
    ],
    [
      "@napi-rs/canvas-linux-x64-gnu",
      canvasVersion,
      join(root, "canvas", "node_modules", "@napi-rs", "canvas-linux-x64-gnu"),
    ],
    // linux 上 js-binding 按 libc 选变体，gnu + musl 都要（对齐桌面 prepare 脚本）
    [
      "@napi-rs/canvas-linux-x64-musl",
      canvasVersion,
      join(root, "canvas", "node_modules", "@napi-rs", "canvas-linux-x64-musl"),
    ],
  ];
  for (const [name, version, dest] of fetches) {
    process.stdout.write(`[web-image] fetch ${name}@${version}\n`);
    await fetchNpmPackage(name, version, dest);
  }
  // 复用桌面树带过来的 win32 napi 对 linux 无用，剪掉省 ~20MB
  rmSync(join(root, "anydoc", "node_modules", "@firecrawl", "anydoc-win32-x64-msvc"), {
    recursive: true,
    force: true,
  });
  rmSync(join(root, "canvas", "node_modules", "@napi-rs", "canvas-win32-x64-msvc"), {
    recursive: true,
    force: true,
  });
  writeFileSync(
    join(root, "SOURCES.json"),
    `${JSON.stringify(
      {
        platform: "linux-x64",
        components: [
          {
            component: "@firecrawl/anydoc",
            license: "MIT",
            source: `npm @firecrawl/anydoc@${anydocVersion}`,
          },
          {
            component: "@napi-rs/canvas",
            license: "MIT",
            source: `npm @napi-rs/canvas@${canvasVersion}`,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function stageOfficeEngines() {
  const root = join(targetRoot, "office-engines");
  rmSync(root, { recursive: true, force: true });
  // 字体与 OCR 模型平台无关，直接复用桌面资产树
  cpSync(join(winTree, "office-engines", "fonts"), join(root, "fonts"), { recursive: true });
  cpSync(join(winTree, "office-engines", "ocr-models"), join(root, "ocr-models"), {
    recursive: true,
  });
  // Python 骨架：bin/python3 由 Dockerfile 链到系统 python3；三方依赖由 Dockerfile pip 装
  const sitePackages = join(root, "python", "lib", "python3.11", "site-packages");
  mkdirSync(sitePackages, { recursive: true });
  mkdirSync(join(root, "python", "bin"), { recursive: true });
  // office_skill_lib 是纯 Python，直接进 site-packages
  cpSync(join(repoRoot, "scripts", "office_skill_lib"), join(sitePackages, "office_skill_lib"), {
    recursive: true,
  });
  // 二方依赖钉版清单（与桌面 wheels 同版本，Linux 由 pip 解 manylinux wheel）
  writeFileSync(
    join(root, "python", "requirements-linux.txt"),
    [
      "numpy==2.2.6",
      "onnxruntime==1.25.1",
      "flatbuffers",
      "protobuf",
      "latex2mathml==3.81.1",
      "python-pptx==1.0.2",
      "cryptography",
      "pillow",
    ].join("\n"),
  );
  return root;
}

function dirSizeMB(path) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else total += info.size;
    }
  };
  walk(path);
  return (total / 1024 / 1024).toFixed(0);
}

const fileToolsRoot = await stageFileTools();
const officeRoot = stageOfficeEngines();
console.log(`[web-image] file-tools: ${dirSizeMB(fileToolsRoot)}MB`);
console.log(`[web-image] office-engines: ${dirSizeMB(officeRoot)}MB`);
console.log(`[web-image] 完成：${targetRoot}`);
