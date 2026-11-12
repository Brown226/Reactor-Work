/**
 * 产品门户交付镜像（reactor-portal:v<version>）。
 *
 * 门户是 nginx 托管的纯静态站（官网 + 说明书），镜像本身很轻（~100MB，tar ~30MB），
 * 因此这一段是四个目标里最快的：说明书生成 + 构建 + 导出通常 1 分钟内完成。
 *
 * 关键点：
 * - 构建前必须先 `node portal/manual/build.mjs`（把 pages/*.md 渲染成 HTML）；
 * - 门户的「更新日志 / 下载页」内容来自 identity 数据库 + updates 卷，
 *   **不在这镜像里**，换镜像不会自动带出版本说明；
 * - 交付包里门户镜像归在 `server/images/reactor-portal.tar.gz`（历史命名）。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { deliveryPaths, paths } from "../lib/context.mjs";
import { run } from "../lib/exec.mjs";
import { buildImage, saveImageToGz } from "../lib/docker.mjs";
import { updateManifest } from "../lib/manifest.mjs";

export function buildPortalSite() {
  console.log("\n== 1/3 生成说明书站点 ==");
  run("node", ["manual/build.mjs"], {
    cwd: paths.portal,
    label: "portal/manual/build.mjs",
  });
}

export function checkPortalSite() {
  console.log("\n== 2/3 校验说明书产物 ==");
  run("node", ["manual/check.mjs"], {
    cwd: paths.portal,
    label: "portal/manual/check.mjs",
  });
}

/** 门户完整打包。 */
export async function packagePortal(options) {
  const { version, deliveryRoot } = options;
  buildPortalSite();
  checkPortalSite();

  console.log("\n== 3/3 构建并导出镜像 ==");
  const tag = `reactor-portal:v${version}`;
  await buildImage({ context: paths.portal, tag });

  const imagesDir = join(deliveryPaths.server(deliveryRoot), "images");
  mkdirSync(imagesDir, { recursive: true });
  const tarball = join(imagesDir, "reactor-portal.tar.gz");
  await saveImageToGz(tag, tarball);
  const total = await updateManifest(deliveryRoot, [tarball]);
  console.log(`  MANIFEST 共 ${total} 项`);
  return [tarball];
}
