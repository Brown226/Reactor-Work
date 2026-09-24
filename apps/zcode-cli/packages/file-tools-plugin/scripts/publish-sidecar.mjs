/**
 * DWG sidecar（ACadSharp）发布脚本。
 *
 * 输出：apps/zcode-cli/packages/file-tools-plugin/dist/dwg-sidecar/<rid>/dwg-sidecar[.exe]
 * （开发态 MCP server 按 RID 解析；发布态由 scripts/prepare-file-tools-assets.mjs
 * 直接发布进 bundled-tools/<platformKey>/file-tools/dwg-sidecar/，安装包随包分发）。
 *
 * 用法：
 *   node scripts/publish-sidecar.mjs            # 发布当前平台（RID 自动推断）
 *   node scripts/publish-sidecar.mjs --rid linux-x64   # 显式指定
 * 退出码：0 成功；dotnet 不可用时 --required 才失败（CI 主链），否则仅告警跳过。
 */
import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const sidecarProject = join(packageRoot, "tools", "dwg-sidecar");

const RID_BY_PLATFORM = {
  "win32-x64": "win-x64",
  "win32-arm64": "win-arm64",
  "darwin-x64": "osx-x64",
  "darwin-arm64": "osx-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
};

const platformKey = `${process.platform}-${process.arch}`;
const ridArgIndex = process.argv.indexOf("--rid");
const rid = ridArgIndex !== -1 ? process.argv[ridArgIndex + 1] : RID_BY_PLATFORM[platformKey];
if (!rid) {
  console.error(`[sidecar] 不支持的平台：${platformKey}`);
  process.exit(1);
}

const outDir = process.argv.includes("--out")
  ? resolve(packageRoot, process.argv[process.argv.indexOf("--out") + 1])
  : resolve(packageRoot, "dist", "dwg-sidecar", rid);

function hasDotnet() {
  try {
    execFileSync(process.platform === "win32" ? "dotnet.exe" : "dotnet", ["--version"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

if (!hasDotnet()) {
  if (process.argv.includes("--required")) {
    console.error("[sidecar] 未找到 dotnet SDK，无法发布 DWG sidecar（CI 主链必须提供）");
    process.exit(1);
  }
  console.warn("[sidecar] 未找到 dotnet SDK，跳过 sidecar 开发态发布（dwg_modify 在运行时将报不可用）");
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
console.log(`[sidecar] publish ACadSharp sidecar: ${platformKey} -> ${rid}（${outDir}）`);
execFileSync(
  process.platform === "win32" ? "dotnet.exe" : "dotnet",
  [
    "publish",
    sidecarProject,
    "-c",
    "Release",
    "-r",
    rid,
    "--self-contained",
    "true",
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:EnableCompressionInSingleFile=true",
    "-o",
    outDir,
  ],
  { stdio: "inherit", cwd: packageRoot },
);
const exeName = process.platform === "win32" ? "dwg-sidecar.exe" : "dwg-sidecar";
if (!existsSync(join(outDir, exeName))) {
  console.error(`[sidecar] 发布产物缺失：${join(outDir, exeName)}`);
  process.exit(1);
}
console.log(`[sidecar] ok: ${join(outDir, exeName)}`);
