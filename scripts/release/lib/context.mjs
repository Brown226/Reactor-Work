/**
 * 交付打包的公共上下文：仓库根、版本号、交付目录、各端产物路径。
 *
 * 交付目录约定：`E:\工作\Reactor-版本更新\V<version>`（可用环境变量
 * `REACTOR_DELIVERY_ROOT` 覆盖）。目录结构与 V1.1.1 保持一致：
 *
 *   V<version>/
 *     desktop/   Reactor-<version>-win-x64.exe + blockmap + latest.yml
 *     web/       images/reactor-web-v<version>.tar.gz + compose + build/
 *     server/    images/{reactor-desktop-server,reactor-portal,openldap,pgvector}.tar.gz
 *     docs/      更新说明
 *     MANIFEST.sha256
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 仓库根 package.json 的版本号——桌面安装包与镜像 tag 的唯一来源。 */
export function repoVersion() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!version) throw new Error("根 package.json 缺少 version");
  return version;
}

/**
 * 交付目录。优先级：显式参数 > 环境变量 > `E:\工作\Reactor-版本更新\V<version>`。
 * 环境变量用于把交付物放到别处（例如现场机器只产出 web 镜像）。
 */
export function deliveryRoot(version, explicit) {
  const fromEnv = process.env.REACTOR_DELIVERY_ROOT?.trim();
  const base = explicit || fromEnv || join("E:\\工作\\Reactor-版本更新", `V${version}`);
  return resolve(base);
}

/** 各端的产物子目录。 */
export const deliveryPaths = {
  desktop: (root) => join(root, "desktop"),
  web: (root) => join(root, "web"),
  server: (root) => join(root, "server"),
  docs: (root) => join(root, "docs"),
};

export const paths = {
  repoRoot,
  desktopPackage: join(repoRoot, "packages", "desktop"),
  webDeploy: join(repoRoot, "deploy", "web"),
  serverWorkspace: join(repoRoot, "server"),
  serverDockerDir: join(repoRoot, "server", "packages", "server", "docker"),
  portal: join(repoRoot, "portal"),
  cliPackage: join(repoRoot, "apps", "zcode-cli", "packages", "cli"),
  corePackage: join(repoRoot, "apps", "zcode-cli", "packages", "core"),
  /** CLI bundle 产物：桌面内置 agent 与 Web 镜像里的 agent 都是它。 */
  cliBundle: join(repoRoot, "apps", "zcode-cli", "packages", "cli", "dist", "zcode.cjs"),
  /** 桌面内置 agent 目录（win x64 是唯一受支持的桌面平台）。 */
  desktopAgentDir: join(repoRoot, "packages", "desktop", "bundled-agents", "win32-x64", "glm"),
  /** Web 镜像构建上下文（仓库内，避免 Windows Temp 下资产丢失）。 */
  webImageContext: join(repoRoot, ".tmp-web-image-context"),
  /** 仓库内置 provider 配置：server/CLI 构建缺它会报 schema 校验失败。 */
  providerConfig: "config/provider/zcode-builtin.json",
};

/** 构建内置 provider 配置必须带的环境变量。 */
export function providerEnv(extra = {}) {
  return {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: paths.providerConfig,
    ...extra,
  };
}

/**
 * Vite/Rolldown 在 Windows 上的堆上限。默认堆不够会 `memory allocation failed`
 * 或 segfault（exit 139）；8192 反而更容易崩，6144 是实测可用值。
 */
export function nodeMemoryEnv(extra = {}) {
  return {
    NODE_OPTIONS: process.env.NODE_OPTIONS?.trim() || "--max-old-space-size=6144",
    ...extra,
  };
}

export function fileExists(path) {
  return existsSync(path);
}
