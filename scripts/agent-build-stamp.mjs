import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * agent CLI 构建的源码指纹。
 *
 * 背景：`pnpm dev:desktop` 每次都全量重建 agent CLI（10+ 个 pnpm --filter build，
 * 每个都是独立 tsc 进程），Windows 上要 1-3 分钟；而绝大多数重启的原因是改了渲染层
 * 或 host 层，agent 产物根本没变。
 *
 * 这里的取舍：**只在源码真的没变时才允许跳过**。指纹覆盖两部分——
 * 1. agent 子 workspace 自身（apps/zcode-cli 的源码与脚本）；
 * 2. 它依赖的根 workspace 包源码（apps/zcode-cli 运行时依赖根 @zcode/shared 等，
 *    改了这些也必须重建，否则就是"改动没进 agent"的静默陈旧）。
 * 另外把参与生产的脚本本身也算进指纹：改了指纹算法或打包脚本，指纹必须失效。
 *
 * 宁可多算一次（指纹不匹配就重建），也不能漏算——漏算会把"代码没生效"伪装成"代码没用"。
 */

/** 参与 agent 产物的源码根（相对仓库根）。 */
const STAMP_SOURCE_ROOTS = [
  "apps/zcode-cli/packages",
  "packages/shared/src",
  "packages/rpc/src",
  "packages/provider/src",
  "packages/provider-node/src",
  "packages/services/src",
  "packages/client/src",
  "packages/server/src",
];

/** 参与 agent 产物的生产脚本（改了它们也必须重建）。 */
const STAMP_SCRIPTS = [
  "scripts/build-desktop-agent-cli.mjs",
  "scripts/builtin-provider-config.mjs",
  "packages/desktop/scripts/stage-agent-bundle.mjs",
];

/** 锁文件/工作区声明变化意味着依赖关系可能变了。 */
const STAMP_MANIFESTS = ["apps/zcode-cli/package.json", "apps/zcode-cli/pnpm-lock.yaml"];

const HASHED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"]);
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-cjs",
  "dist-esm",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
]);

function collectFiles(root, current, files) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") {
      continue;
    }
    if (SKIPPED_DIRS.has(entry.name)) {
      continue;
    }
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, absolute, files);
      continue;
    }
    if (!HASHED_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      continue;
    }
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    files.push(`${absolute.slice(root.length + 1)}:${stat.size}:${stat.mtimeMs}`);
  }
  return files;
}

/**
 * 计算源码指纹。
 *
 * 用 size+mtime 而不是内容哈希：全量内容哈希在这棵树上要读几千个文件，
 * 每次启动都做反而抵消了收益；mtime 变化即视为变更（git checkout / 编辑都会刷新 mtime）。
 */
export function computeAgentBuildStamp(repoRoot) {
  const files = [];
  for (const rel of STAMP_SOURCE_ROOTS) {
    collectFiles(repoRoot, resolve(repoRoot, rel), files);
  }
  for (const rel of STAMP_SCRIPTS) {
    const absolute = resolve(repoRoot, rel);
    if (!existsSync(absolute)) {
      files.push(`${rel}:missing`);
      continue;
    }
    files.push(`${rel}:${statSync(absolute).size}:${statSync(absolute).mtimeMs}`);
  }
  for (const rel of STAMP_MANIFESTS) {
    const absolute = resolve(repoRoot, rel);
    if (!existsSync(absolute)) {
      files.push(`${rel}:missing`);
      continue;
    }
    files.push(`${rel}:${statSync(absolute).size}:${statSync(absolute).mtimeMs}`);
  }
  files.sort();
  return createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 32);
}

export function resolveAgentBuildStampFile(repoRoot) {
  return resolve(repoRoot, ".cache", "desktop-agent-build-stamp.json");
}

/**
 * @typedef {{ stamp: string, builtAt: string }} AgentBuildStampState
 */

/**
 * @param {string} stampFile
 * @returns {AgentBuildStampState | null}
 */
export function readAgentBuildStamp(stampFile) {
  try {
    const parsed = JSON.parse(readFileSync(stampFile, "utf8"));
    if (typeof parsed?.stamp === "string" && parsed.stamp.length > 0) {
      return { stamp: parsed.stamp, builtAt: String(parsed.builtAt ?? "") };
    }
  } catch {
    // 指纹文件缺失或损坏一律视为"没有可用指纹"，调用方会退回全量构建。
  }
  return null;
}

export function writeAgentBuildStamp(stampFile, stamp) {
  const state = { stamp, builtAt: new Date().toISOString() };
  // 只覆盖这一个文件，不删整个目录：删了还要重建目录，属于没有收益的额外步骤。
  mkdirSync(dirname(stampFile), { recursive: true });
  writeFileSync(stampFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

/** agent 产物必须真实存在；缺失一律算"未构建"，不能只信指纹。 */
function agentArtifactsExist(repoRoot) {
  return (
    existsSync(resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs")) &&
    existsSync(
      resolve(repoRoot, "packages/desktop/bundled-agents", `${process.platform}-${process.arch}`),
    )
  );
}

export function isAgentBuildUpToDate(repoRoot, stampFile) {
  if (!agentArtifactsExist(repoRoot)) {
    return { upToDate: false, reason: "agent 产物缺失" };
  }
  const recorded = readAgentBuildStamp(stampFile);
  if (!recorded) {
    return { upToDate: false, reason: "没有构建指纹（首次或指纹已清理）" };
  }
  const current = computeAgentBuildStamp(repoRoot);
  if (current !== recorded.stamp) {
    return { upToDate: false, reason: "源码已变化" };
  }
  return { upToDate: true, reason: `源码未变化（构建于 ${recorded.builtAt || "未知时间"}）` };
}
