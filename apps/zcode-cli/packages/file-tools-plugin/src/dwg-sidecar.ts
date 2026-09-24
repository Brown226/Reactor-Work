/**
 * DWG sidecar（ACadSharp .NET，MIT）子进程客户端：dwg_modify 与 dwg_graph 共用。
 *
 * 协议：stdin 单发一行 JSON 请求，stdout 取最后一个非空行解析；退出码 0 正常、2 错误。
 * 资产解析候选链（env → resourcesPath → 包内 assets）与失败降级语义见
 * docs/文件解析OCR-CAD-集成方案.md §5。
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFileToolsAssets } from "./assets.js";

/** sidecar 可执行文件名：Windows 带 .exe。 */
function sidecarBinaryName(): string {
  return process.platform === "win32" ? "dwg-sidecar.exe" : "dwg-sidecar";
}

/** platformKey → .NET RID（sidecar 自包含发布按 RID 出品）。 */
function dotnetRid(platformKey: string): string | null {
  const map: Record<string, string> = {
    "win32-x64": "win-x64",
    "win32-arm64": "win-arm64",
    "darwin-x64": "osx-x64",
    "darwin-arm64": "osx-arm64",
    "linux-x64": "linux-x64",
    "linux-arm64": "linux-arm64",
  };
  return map[platformKey] ?? null;
}

function isFileSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveSidecarDir(): string {
  // ZCODE_DWG_SIDECAR_PATH 既可以是 sidecar 目录，也可以直接是可执行文件全路径。
  const override = process.env.ZCODE_DWG_SIDECAR_PATH?.trim();
  if (override) {
    if (override.toLowerCase().endsWith(sidecarBinaryName().toLowerCase())) {
      return dirname(override);
    }
    return override;
  }
  const assets = resolveFileToolsAssets();
  const rid = dotnetRid(`${process.platform}-${process.arch}`);
  // 开发态：`pnpm --filter @zcode/file-tools-plugin build` 的 dotnet publish 输出。
  // src/tools/*.ts 下运行是 ../../dist（src→包根），dist/mcp/server.js 里是 ../dist
  // （dist/mcp→包根）；两种形状都入候选。
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates: Array<string | null> = [
    // 桌面打包态（prepare 脚本按 RID 发布进 resources/tools/file-tools/dwg-sidecar）。
    assets.root ? join(assets.root, "dwg-sidecar") : null,
    resolve(moduleDir, "..", "dist", "dwg-sidecar"),
    resolve(moduleDir, "..", "..", "dist", "dwg-sidecar"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const withRid = rid ? join(candidate, rid) : candidate;
    if (isFileSafe(join(withRid, sidecarBinaryName()))) return withRid;
    if (isFileSafe(join(candidate, sidecarBinaryName()))) return candidate;
  }
  throw new Error(
    "未找到 DWG sidecar（dwg-sidecar 可执行文件）。file-tools 资产不完整：需运行 scripts/prepare-file-tools-assets.mjs（或包内 dotnet publish）。",
  );
}

/** 单发 JSON 调用 sidecar；传输层失败（缺二进制/无响应/输出不可解析）以异常抛出，由工具层转 failed。 */
export async function runSidecar<T = { ok: boolean; error?: string }>(
  request: Record<string, unknown>,
): Promise<T> {
  const dir = resolveSidecarDir();
  const binary = join(dir, sidecarBinaryName());
  return new Promise<T>((resolveRequest, rejectRequest) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectRequest);
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").pop() ?? "";
      if (!line) {
        rejectRequest(
          new Error(
            `DWG sidecar 无响应（exit=${code}）：${stderr.slice(0, 400) || "(无 stderr)"}`,
          ),
        );
        return;
      }
      try {
        resolveRequest(JSON.parse(line) as T);
      } catch {
        rejectRequest(new Error(`DWG sidecar 输出无法解析：${line.slice(0, 200)}`));
      }
    });
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}
