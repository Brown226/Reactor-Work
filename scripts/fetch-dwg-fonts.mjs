/**
 * 下载 DWG 查看器（mlightcad）的最小中文字体集到 packages/web/public/dwg-fonts/。
 *
 * 为什么需要：mlightcad 默认从 cdn.jsdelivr.net 拉字体清单与字体文件，内网部署取不到
 * 时 TEXT/MTEXT 整体不渲染（几何正常）。字体有许可与体量问题（~3.7MB），不入库，
 * 由本脚本按需拉取；dev、web 构建与 web Docker 镜像都要先跑一次。
 *
 * 用法：node scripts/fetch-dwg-fonts.mjs [--force]
 * 幂等：目标文件已存在且非空时跳过（--force 重下）。
 * 源：mlightcad/cad-data（GitHub）经多个 jsDelivr 镜像与 raw 代理逐一尝试。
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = join(repoRoot, "packages", "web", "public", "dwg", "fonts");

const REPO_PATHS = "mlightcad/cad-data/main/fonts";
// 多源逐一尝试：jsDelivr 的国内友好域名在前，gh 代理兜底
const MIRRORS = [
  `https://fastly.jsdelivr.net/gh/${REPO_PATHS}`,
  `https://gcore.jsdelivr.net/gh/${REPO_PATHS}`,
  `https://testingcf.jsdelivr.net/gh/${REPO_PATHS}`,
  `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO_PATHS}`,
];

// 最小中文图纸字体集：基础 SHX + GB 大字体 + 宋体（mesh）。清单来自 cad-data fonts.json。
const FONT_FILES = [
  "fonts.json",
  "txt.shx",
  "simplex.shx",
  "hztxt.shx",
  "gbcbig.shx",
  "gbenor.shx",
  "gbeitc.shx",
  "simsun.woff",
];

const force = process.argv.includes("--force");

async function fetchFromMirrors(file) {
  let lastError = new Error("no mirror attempted");
  for (const mirror of MIRRORS) {
    try {
      const response = await fetch(`${mirror}/${file}`, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from ${mirror}`);
        continue;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      // 超时（AbortSignal）、连接重置等都只换下一个源，不让异常逃出脚本
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError;
}

await mkdir(outDir, { recursive: true });
let downloaded = 0;
let skipped = 0;
const missing = [];
for (const file of FONT_FILES) {
  const target = join(outDir, file);
  if (!force) {
    const info = await stat(target).catch(() => null);
    if (info?.isFile() && info.size > 0) {
      skipped += 1;
      continue;
    }
  }
  try {
    const buffer = await fetchFromMirrors(file);
    await writeFile(target, buffer);
    downloaded += 1;
    console.log(`[dwg-fonts] ${file} <- ${(buffer.length / 1024).toFixed(0)}KB`);
  } catch (error) {
    missing.push(file);
    console.warn(
      `[dwg-fonts] ${file} 全部镜像失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
console.log(`[dwg-fonts] 完成：下载 ${downloaded}、已存在跳过 ${skipped}，目录 ${outDir}`);
if (downloaded === 0 && skipped < FONT_FILES.length) {
  console.error("[dwg-fonts] 部分字体缺失，DWG 预览将只渲染几何不渲染文字");
  process.exitCode = 1;
}
