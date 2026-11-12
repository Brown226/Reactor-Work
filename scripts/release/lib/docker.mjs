/**
 * Docker 镜像操作封装：构建、导出（tar.gz）、tag 查询。
 *
 * 导出用「docker save → gzip 流」而不是先落 2GB 中间 tar：Web 镜像展开后 2.35GB，
 * 中间文件既占磁盘又拖慢流程。gzip 走 zlib 流式，不把整个 tar 读进内存。
 */
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

import { formatDuration } from "./exec.mjs";

/** 镜像是否存在于本地。 */
export async function imageExists(image) {
  return new Promise((resolvePromise) => {
    const child = spawn("docker", ["image", "inspect", image], { stdio: "ignore" });
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });
}

/** 镜像 ID（用于「升级后页面没变」的排查：比对容器 .Image 与 tag 的 .Id）。 */
export async function imageId(image) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`读取镜像 ID 失败：${image}`));
        return;
      }
      resolvePromise(out.trim());
    });
  });
}

/**
 * 构建镜像。`context` 为构建上下文目录，`dockerfile` 相对该目录。
 */
export async function buildImage({ context, dockerfile, tag, buildArgs = [] }) {
  const args = ["build", "-t", tag];
  if (dockerfile) args.push("-f", dockerfile);
  for (const arg of buildArgs) args.push("--build-arg", arg);
  args.push(context);
  const startedAt = Date.now();
  console.log(`\n▶ docker build ${tag}`);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`docker build ${tag} 失败（退出码 ${code}）`));
        return;
      }
      resolvePromise();
    });
  });
  console.log(`✔ docker build ${tag}（${formatDuration(Date.now() - startedAt)}）`);
}

/**
 * 导出镜像为 `.tar.gz`：`docker save <image> | gzip -9`。
 *
 * @param image 镜像引用（会原样写进 tar，load 回来还是同一个 tag）
 * @param outFile 输出的 .tar.gz 路径
 */
export async function saveImageToGz(image, outFile) {
  await mkdir(dirname(outFile), { recursive: true });
  const startedAt = Date.now();
  console.log(`\n▶ docker save ${image} → ${outFile}`);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", ["save", image], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`docker save ${image} 失败（退出码 ${code}）\n${stderr.slice(-1500)}`));
      }
    });
    pipeline(child.stdout, createGzip({ level: 9 }), createWriteStream(outFile)).then(
      () => resolvePromise(),
      rejectPromise,
    );
  });
  console.log(`✔ 导出完成（${formatDuration(Date.now() - startedAt)}）`);
}

/** 重新打 tag（本地验证用：临时 tag → 正式 tag）。 */
export async function tagImage(source, target) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", ["tag", source, target], { stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`docker tag 失败：${source} → ${target}`)),
    );
  });
}
