/**
 * 构建脚本共用的「下载 + 校验 + 解包」工具。
 *
 * 背景：scripts/ 下多个 prepare-* 脚本各自手写了 download/sha256/解包循环
 * （审计结论 #8），镜像源切换、重试策略、哈希校验修一处漏四处。新逻辑一律
 * 引用本模块；存量脚本按触及顺序渐进迁移。
 *
 * 约定：
 * - 多镜像按序回退，全部失败抛最后一个错误（调用方决定是否致命）；
 * - 带 sha256 期望值时不匹配即抛错，禁止漂移（对齐 prepare-office-engines 策略）；
 * - tar 解包必须在目标目录内用相对路径：Windows 自带 bsdtar 会把
 *   "C:\..." 当远程主机名（实测坑，见 prepare-web-image-linux-tools）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 按镜像顺序下载文件并写入 dest。返回写入字节数。
 * @param {Array<string>} urls 按序尝试的镜像地址
 * @param {string} dest 目标文件路径
 * @param {{sha256?: string, timeoutMs?: number}} [options]
 */
export async function downloadFile(urls, dest, options = {}) {
  const { sha256, timeoutMs = 120_000 } = options;
  mkdirSync(resolve(dest, ".."), { recursive: true });
  let lastError = new Error("no mirror attempted");
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256) {
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== sha256) {
          throw new Error(`sha256 不匹配：${url}（${digest} ≠ ${sha256}）`);
        }
      }
      writeFileSync(dest, bytes);
      return bytes.length;
    } catch (error) {
      // 超时/连接重置/哈希不符都换下一个源，不让异常逃出
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError;
}

/**
 * 从 npm 镜像源拉包 tarball 并解到 destDir（剥掉 tarball 顶层 package/）。
 * 返回解出的 package.json 路径。
 */
export function fetchNpmTarballInto(
  name,
  version,
  destDir,
  { registry = "https://registry.npmmirror.com", timeoutMs = 180_000 } = {},
) {
  const scoped = name.startsWith("@") ? `${name.split("/")[0]}%2F${name.split("/")[1]}` : name;
  const url = `${registry}/${scoped}/-/${name.split("/").pop()}-${version}.tgz`;
  mkdirSync(destDir, { recursive: true });
  const tgz = join(destDir, "pkg.tgz");
  const download = spawnSync("curl", ["-fsSL", "-m", String(Math.floor(timeoutMs / 1000)), "-o", tgz, url], {
    stdio: "pipe",
  });
  if (download.status !== 0 || !existsSync(tgz)) {
    rmSyncSafe(tgz);
    throw new Error(`下载失败 ${url}（curl exit ${download.status}）`);
  }
  // Windows 自带 bsdtar 会把 "C:\..." 解析成远程主机路径，必须在 destDir 里用相对路径
  const extract = spawnSync("tar", ["-xzf", "pkg.tgz"], { cwd: destDir, stdio: "pipe" });
  if (extract.status !== 0) {
    rmSyncSafe(tgz);
    throw new Error(`解包失败 ${destDir}：${String(extract.stderr)}`);
  }
  const inner = join(destDir, "package");
  if (existsSync(inner)) {
    for (const entry of readdirSync(inner)) {
      cpSync(join(inner, entry), join(destDir, entry), { recursive: true });
    }
    rmSync(inner, { recursive: true, force: true });
  }
  rmSyncSafe(tgz);
  return join(destDir, "package.json");
}

function rmSyncSafe(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // 清理失败不影响主流程
  }
}
