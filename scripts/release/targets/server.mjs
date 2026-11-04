/**
 * 服务端交付镜像（identity + gateway 共用一个 reactor-desktop-server:local）。
 *
 * 镜像上下文是仓库的 `server/` 目录（独立 pnpm workspace，有自己的 lockfile），
 * Dockerfile 在 `server/packages/server/Dockerfile`。
 *
 * ⚠ 两个坑：
 * 1. `node:22-alpine` 在国内直连 docker.io 会超时。脚本会先从 docker.1ms.run
 *    拉一份并 retag 成 `node:22-alpine`，再构建。
 * 2. 构建前必须在 `server/` 工作区编译 @reactor/shared、@reactor/server、
 *    @reactor/admin 三份 dist，否则镜像里是旧产物（记忆里踩过：
 *    直连 Key / 管理台修复没进镜像）。
 *
 * 另外两个镜像（openldap、pgvector）是第三方官方镜像，不需要构建，
 * 直接从本地导出即可。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { deliveryPaths, paths } from "../lib/context.mjs";
import { run } from "../lib/exec.mjs";
import { buildImage, imageExists, saveImageToGz } from "../lib/docker.mjs";
import { updateManifest } from "../lib/manifest.mjs";

/** 第三方镜像与交付文件名（交付包里的文件名不带 tag 前缀）。 */
export const SERVER_IMAGES = [
  { image: "reactor-desktop-server:local", file: "reactor-desktop-server.tar.gz", build: true },
  { image: "osixia/openldap:1.5.0", file: "openldap.tar.gz", build: false },
  { image: "pgvector/pgvector:pg16", file: "pgvector.tar.gz", build: false },
];

export function buildServerWorkspace() {
  console.log("\n== 1/4 编译服务端工作区 ==");
  run("pnpm", ["--filter", "@reactor/shared", "build"], {
    cwd: paths.serverWorkspace,
    label: "构建 @reactor/shared",
  });
  run("pnpm", ["--filter", "@reactor/server", "build"], {
    cwd: paths.serverWorkspace,
    label: "构建 @reactor/server",
  });
  run("pnpm", ["--filter", "@reactor/admin", "build"], {
    cwd: paths.serverWorkspace,
    label: "构建 @reactor/admin",
  });
}

/** 国内网络下准备 node:22-alpine 基础镜像。 */
export async function ensureBaseImage() {
  console.log("\n== 2/4 准备基础镜像 ==");
  if (await imageExists("node:22-alpine")) {
    console.log("  node:22-alpine 已在本地");
    return;
  }
  run("docker", ["pull", "docker.1ms.run/library/node:22-alpine"], { label: "拉取 node:22-alpine（国内源）" });
  run("docker", ["tag", "docker.1ms.run/library/node:22-alpine", "node:22-alpine"], {
    label: "重打 tag 为 node:22-alpine",
  });
}

/** 服务端完整打包（只构建与导出镜像，不动正在运行的容器）。 */
export async function packageServer(options) {
  const { deliveryRoot } = options;
  buildServerWorkspace();
  await ensureBaseImage();

  console.log("\n== 3/4 构建服务端镜像 ==");
  await buildImage({
    context: paths.serverWorkspace,
    dockerfile: "packages/server/Dockerfile",
    tag: "reactor-desktop-server:local",
    buildArgs: ["NPM_REGISTRY=https://registry.npmmirror.com"],
  });

  console.log("\n== 4/4 导出镜像 ==");
  const imagesDir = join(deliveryPaths.server(deliveryRoot), "images");
  mkdirSync(imagesDir, { recursive: true });
  const published = [];
  for (const item of SERVER_IMAGES) {
    if (!(await imageExists(item.image))) {
      throw new Error(`本地缺少镜像：${item.image}（第三方镜像请先 docker pull）`);
    }
    const tarball = join(imagesDir, item.file);
    await saveImageToGz(item.image, tarball);
    published.push(tarball);
  }
  const total = await updateManifest(deliveryRoot, published);
  console.log(`  MANIFEST 共 ${total} 项`);
  return published;
}
