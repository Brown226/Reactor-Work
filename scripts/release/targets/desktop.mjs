/**
 * 桌面端（Windows x64）交付打包。
 *
 * 只支持 win x64——这是当前唯一受支持的桌面平台（macOS/Linux 不再出包）。
 *
 * 流程（顺序固定，每一步都是上一步的前提）：
 *   1. 重建 core → 重建 CLI bundle（--desktop-agent，minified 17.4MB）
 *   2. 把 bundle 同步进桌面内置 agent 目录（bundled-agents/win32-x64/glm/zcode.cjs）
 *   3. 构建桌面产物（build:no-runtime-assets）
 *   4. 打包（bundle win x64 --skip-prepare --skip-build）
 *   5. 拷贝 exe/blockmap/latest.yml 到交付目录并更新 MANIFEST
 *
 * 两个必踩的坑（自动化掉，避免再打第二遍）：
 *   - CLI bundle 的 esbuild alias 指向 `@zcode/core` 的 dist，**改过 core 源码必须先重建 core**；
 *   - 桌面自带 agent bundle 有两份来源（bundled-agents 与 mock-cdn/releases/<版本>），
 *     只换其一会导致桌面端仍用旧 bundle；本脚本两份一起换。
 */
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { deliveryPaths, nodeMemoryEnv, paths, providerEnv } from "../lib/context.mjs";
import { run } from "../lib/exec.mjs";
import { updateManifest } from "../lib/manifest.mjs";

/** 重建 CLI bundle（桌面与 Web 镜像共用同一份产物）。 */
export function buildCliBundle() {
  console.log("\n== 1/5 重建 agent bundle（core → CLI） ==");
  run("pnpm", ["--dir", paths.corePackage, "build"], {
    label: "构建 @zcode/core（tsc）",
    env: providerEnv(),
  });
  run("pnpm", ["--dir", paths.cliPackage, "run", "build", "--", "--desktop-agent"], {
    label: "构建 CLI bundle（--desktop-agent）",
    env: providerEnv(),
  });
  if (!existsSync(paths.cliBundle)) throw new Error(`CLI bundle 缺失：${paths.cliBundle}`);
}

/**
 * 把新 bundle 同步到桌面内置 agent 目录。
 * mock-cdn/releases/<版本>/glm/* 属于「远端 agent 资产」，Windows 包用不到，
 * 但为避免以后打其它平台时再踩坑，这里一并同步（存在才写）。
 */
export async function syncDesktopAgentBundle(version) {
  console.log("\n== 2/5 同步桌面内置 agent bundle ==");
  const targets = [join(paths.desktopAgentDir, "zcode.cjs")];
  const mockCdn = join(paths.desktopPackage, "mock-cdn", "releases", version, "glm");
  for (const platformDir of ["win32-x64", "darwin-arm64"]) {
    const candidate = join(mockCdn, platformDir, "zcode.cjs");
    if (existsSync(candidate)) targets.push(candidate);
  }
  for (const target of targets) {
    await mkdir(join(target, ".."), { recursive: true });
    await copyFile(paths.cliBundle, target);
    console.log(`  已更新 ${target}`);
  }
}

/** 构建桌面产物（main/host/preload + renderer）。 */
export function buildDesktopArtifacts() {
  console.log("\n== 3/5 构建桌面产物 ==");
  run(
    "pnpm",
    ["--filter", "@zcode/desktop", "run", "build:no-runtime-assets"],
    {
      label: "build:no-runtime-assets",
      env: providerEnv(nodeMemoryEnv()),
    },
  );
}

/**
 * 打包 Windows x64 安装包。
 *
 * `--skip-prepare` 跳过运行时资产准备（会为 4 个平台构建 mock-cdn 组件，
 * 对 Windows 包无用且极慢）；`--skip-build` 跳过重复 build（上面已单独构建）。
 */
export function bundleDesktop() {
  console.log("\n== 4/5 打包 Windows x64 ==");
  run("node", ["scripts/bundle.mjs", "win", "x64", "--skip-prepare", "--skip-build"], {
    cwd: paths.desktopPackage,
    label: "bundle win x64",
    env: providerEnv(),
  });
}

/** 把安装包拷进交付目录并更新清单。 */
export async function publishDesktop({ version, deliveryRoot }) {
  console.log("\n== 5/5 交付 ==");
  const targetDir = deliveryPaths.desktop(deliveryRoot);
  await mkdir(targetDir, { recursive: true });
  const artifacts = [
    `Reactor-${version}-win-x64.exe`,
    `Reactor-${version}-win-x64.exe.blockmap`,
    "latest.yml",
  ];
  const published = [];
  for (const name of artifacts) {
    const source = join(paths.desktopPackage, "dist", name);
    if (!existsSync(source)) throw new Error(`打包产物缺失：${source}`);
    const target = join(targetDir, name);
    await copyFile(source, target);
    published.push(target);
    console.log(`  已交付 ${target}`);
  }
  const total = await updateManifest(deliveryRoot, published);
  console.log(`  MANIFEST 共 ${total} 项`);
  return published;
}

/** 桌面端完整打包。 */
export async function packageDesktop(options) {
  const { version, deliveryRoot } = options;
  buildCliBundle();
  await syncDesktopAgentBundle(version);
  if (!options.skipBuild) {
    buildDesktopArtifacts();
    bundleDesktop();
  }
  return publishDesktop({ version, deliveryRoot });
}
