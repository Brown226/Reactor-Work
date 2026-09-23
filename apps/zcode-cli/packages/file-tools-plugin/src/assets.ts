/**
 * file-tools 资产定位：native 绑定 / ONNX 模型 / canvas / wasm 全部以只读产品资产
 * 随安装包分发（resources/tools/file-tools），MCP 子进程自解析，不改 bootstrap。
 *
 * 候选顺序与 packages/services/src/runtime-tools/runtimeToolResolver.ts 同思路：
 * 1. 环境变量 ZCODE_FILE_TOOLS_ASSETS_ROOT（部署 / 测试覆盖）
 * 2. process.resourcesPath/tools/file-tools（桌面打包态）
 * 3. 开发态：工作区内 packages/desktop/bundled-tools/<platformKey>/file-tools
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

interface FileToolsAssets {
  /** 资产根目录；null 表示未找到任何候选人。 */
  root: string | null;
  /** @firecrawl/anydoc 及其平台 napi 绑定（Node 目录布局）。 */
  anydocDir: string | null;
  /** onnxruntime-node（Node 目录布局）。 */
  onnxruntimeDir: string | null;
  /** PP-OCR ONNX 模型 + 字典。 */
  ocrModelsDir: string | null;
  /** libredwg-web 的 lib/ + wasm/（GPL-3.0）。 */
  libredwgDir: string | null;
  /** @napi-rs/canvas 及其平台 skia 绑定（Node 目录布局）。 */
  canvasDir: string | null;
}

function dirIfExists(path: string | null | undefined): string | null {
  if (!path) return null;
  return existsSync(path) ? path : null;
}

export function platformKey(platform: NodeJS.Platform = process.platform): string {
  return `${platform}-${process.arch}`;
}

/**
 * 解析资产根。每个候选按「canvas 目录存在」判定：canvas 是 OCR/栅格化链路
 * 必须的原生资产，缺它不算有效根，避免把半成品资产根当完整根用。
 */
function resolveAssetsRoot(env: NodeJS.ProcessEnv, cwd: string): string | null {
  const candidates: Array<string | null> = [];
  const override = env.ZCODE_FILE_TOOLS_ASSETS_ROOT?.trim();
  if (override) candidates.push(override);
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(join(resourcesPath, "tools", "file-tools"));
  // 开发态：从仓库根或任意子目录 cwd 都能找到 bundled-tools。
  candidates.push(join(cwd, "packages", "desktop", "bundled-tools", platformKey(), "file-tools"));
  // 开发态：包内 assets/<platformKey>/。src 下是 ../assets（src→包根），
  // dist bundle 下是 ../../assets（dist/mcp→包根）；两个形状都入候选。
  candidates.push(
    resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "assets", platformKey()),
  );
  candidates.push(
    resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", platformKey()),
  );
  for (const candidate of candidates) {
    const dir = dirIfExists(candidate);
    if (dir && existsSync(join(dir, "canvas"))) return dir;
  }
  // 资产根下没有 canvas（例如只做了 anydoc 的最小资产）时仍返回根，
  // 由各能力自行判定自身资产是否可用。
  for (const candidate of candidates) {
    const dir = dirIfExists(candidate);
    if (dir) return dir;
  }
  return null;
}

export function resolveFileToolsAssets(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): FileToolsAssets {
  const root = resolveAssetsRoot(env, cwd);
  if (!root) {
    return {
      root: null,
      anydocDir: null,
      onnxruntimeDir: null,
      ocrModelsDir: null,
      libredwgDir: null,
      canvasDir: null,
    };
  }
  return {
    root,
    anydocDir: dirIfExists(join(root, "anydoc")),
    onnxruntimeDir: dirIfExists(join(root, "onnxruntime")),
    ocrModelsDir: dirIfExists(join(root, "ocr-models")),
    libredwgDir: dirIfExists(join(root, "libredwg")),
    canvasDir: dirIfExists(join(root, "canvas")),
  };
}

/** anydoc 在资产目录中的 Node 布局：<root>/anydoc/node_modules/@firecrawl/<pkg>。 */
export function anydocEntryDir(anydocDir: string): string {
  return join(anydocDir, "node_modules", "@firecrawl", "anydoc");
}

export function onnxruntimeEntryDir(onnxruntimeDir: string): string {
  return join(onnxruntimeDir, "node_modules", "onnxruntime-node");
}

