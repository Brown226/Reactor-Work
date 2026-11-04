/**
 * Web 端交付镜像（reactor-web:v<version>）。
 *
 * 镜像由「前端静态产物 + HTTP/WS 服务端 + agent bundle + 能力资产」组成，
 * 构建上下文在仓库内 `.tmp-web-image-context` 组装（Windows Temp 下会掉资产）。
 *
 * 流程：
 *   1. 重建 server-dist（tsup，必须带内置 provider 配置 env）
 *   2. 重建 web-dist（vite，Windows 上要加堆上限）
 *   3. 重建 agent bundle（core → CLI，与桌面端共用同一份）
 *   4. 组装构建上下文（含官方插件 seed 与能力资产）
 *   5. docker build → docker save | gzip → 交付目录 + MANIFEST
 *
 * 复用：`--reuse-assets` 跳过能力资产准备（bundled-tools 有 300MB，重新拉很慢），
 * 只在没改过资产时用。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { deliveryPaths, nodeMemoryEnv, paths, providerEnv } from "../lib/context.mjs";
import { run } from "../lib/exec.mjs";
import { buildImage, saveImageToGz } from "../lib/docker.mjs";
import { updateManifest } from "../lib/manifest.mjs";
import { buildCliBundle } from "./desktop.mjs";

const CONTEXT = paths.webImageContext;

/** 复制目录（目标存在则先清空，避免旧资产残留）。 */
function copyDir(source, target) {
  if (!existsSync(source)) throw new Error(`资产缺失：${source}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
}

export function buildServerDist() {
  console.log("\n== 1/5 重建 server-dist ==");
  run("pnpm", ["--filter", "@zcode/server", "build"], {
    label: "构建 @zcode/server",
    env: providerEnv(),
  });
}

export function buildWebDist() {
  console.log("\n== 2/5 重建 web-dist ==");
  run("pnpm", ["--filter", "@zcode/web", "build"], {
    label: "构建 @zcode/web",
    env: nodeMemoryEnv(),
  });
}

/**
 * 组装构建上下文。
 *
 * 资产来源：
 * - 官方插件：优先桌面已 stage 的 `packages/desktop/dist/win-unpacked/resources/glm/packages`
 *   （含构建好的 dist），没有则退回仓库源码（需要先构建插件）。
 * - DWG sidecar：仓库 `apps/zcode-cli/packages/dwg-tools-plugin/assets/linux-x64`。
 * - bundled-tools：`scripts/prepare-web-image-linux-tools.mjs`（npm 平台包，慢）。
 */
export function prepareContext({ reuseAssets = false } = {}) {
  console.log("\n== 4/5 组装构建上下文 ==");
  mkdirSync(CONTEXT, { recursive: true });

  // 清掉历史构建日志：Dockerfile 是 COPY . 全量拷，日志会被带进镜像
  for (const name of readdirSync(CONTEXT)) {
    if (name.endsWith(".log")) rmSync(join(CONTEXT, name), { force: true });
  }

  // 编排文件与依赖清单
  copyFileInto(join(paths.webDeploy, "Dockerfile"), join(CONTEXT, "Dockerfile"));
  copyFileInto(join(paths.webDeploy, "runtime-package.json"), join(CONTEXT, "runtime-package.json"));

  // 产物
  copyDir(join(paths.repoRoot, "packages", "server", "dist"), join(CONTEXT, "server-dist"));
  copyDir(join(paths.repoRoot, "packages", "web", "dist"), join(CONTEXT, "web-dist"));

  // agent runtime
  copyFileInto(paths.cliBundle, join(CONTEXT, "agent", "zcode.cjs"));

  // DWG sidecar（linux-x64 自包含）
  // 源结构是 assets/linux-x64/dwg-sidecar/linux-x64/dwg-sidecar，整目录拷到
  // agent/dwg-tools/dwg-sidecar（容器内依赖 /app/agent/dwg-tools/dwg-sidecar/linux-x64）。
  const sidecarSource = join(
    paths.repoRoot,
    "apps",
    "zcode-cli",
    "packages",
    "dwg-tools-plugin",
    "assets",
    "linux-x64",
    "dwg-sidecar",
  );
  copyDir(sidecarSource, join(CONTEXT, "agent", "dwg-tools", "dwg-sidecar"));

  // 能力资产（bundled-tools）：已有且允许复用时跳过，避免重新下载 npm 平台包
  const bundledTools = join(CONTEXT, "bundled-tools", "linux-x64");
  if (reuseAssets && existsSync(bundledTools)) {
    console.log("  复用已有 bundled-tools/linux-x64");
  } else {
    run("node", ["scripts/prepare-web-image-linux-tools.mjs", CONTEXT], {
      label: "准备 bundled-tools（linux-x64）",
    });
  }

  // 官方插件 seed：脚本自己处理「桌面 stage 树优先、仓库源码兜底」
  run("node", ["scripts/prepare-web-image-linux-plugins.mjs", CONTEXT], {
    label: "准备官方插件 seed（15 个）",
  });

  // 关键资产自检：缺一项构建出的镜像会在运行时报 404/模块缺失
  const required = [
    "Dockerfile",
    "runtime-package.json",
    "server-dist/entry-http.js",
    "web-dist/index.html",
    "agent/zcode.cjs",
    "agent/dwg-tools/dwg-sidecar/linux-x64/dwg-sidecar",
    "bundled-tools/linux-x64/file-tools",
    "agent/packages",
  ];
  const missing = required.filter((item) => !existsSync(join(CONTEXT, item)));
  if (missing.length > 0) {
    throw new Error(`构建上下文缺少关键资产：\n  - ${missing.join("\n  - ")}`);
  }
  console.log("  关键资产自检通过");
}

function copyFileInto(source, target) {
  if (!existsSync(source)) throw new Error(`文件缺失：${source}`);
  mkdirSync(join(target, ".."), { recursive: true });
  cpSync(source, target, { recursive: true });
}

/** Web 端完整打包。 */
export async function packageWeb(options) {
  const { version, deliveryRoot } = options;
  buildServerDist();
  buildWebDist();
  buildCliBundle();
  prepareContext({ reuseAssets: options.reuseAssets === true });

  const tag = `reactor-web:v${version}`;
  console.log("\n== 5/5 构建并导出镜像 ==");
  await buildImage({ context: CONTEXT, tag });

  const imagesDir = join(deliveryPaths.web(deliveryRoot), "images");
  mkdirSync(imagesDir, { recursive: true });
  const tarball = join(imagesDir, `reactor-web-v${version}.tar.gz`);
  await saveImageToGz(tag, tarball);
  const total = await updateManifest(deliveryRoot, [tarball]);
  console.log(`  MANIFEST 共 ${total} 项`);
  return [tarball];
}
