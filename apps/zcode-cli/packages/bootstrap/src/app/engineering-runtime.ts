/**
 * 工程能力的运行时资产解析：MCP server 入口 + 技能根。
 *
 * 产物由 `packages/services` 构建，随 CLI / 桌面端分发（见 docs/design/v2/engineering-mcp.md）。
 * 本模块只做只读探测，不创建、不移动任何文件；产物缺失时静默不注册，
 * 让 `node_repl`、插件等其他能力不受影响。
 *
 * 说明：CLI 不依赖 `@zcode/services`，这里只按路径约定查找，不 import 其代码。
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Logger, McpServerConfig, SkillRoot } from "@zcode/contracts";

import { bundleBaseDirs } from "./official-plugin-runtime.js";

export const ENGINEERING_MCP_SERVER_NAME = "engineering";

const SERVER_ENTRY_FILE = "mcp-server-main.js";
const SKILLS_DIRECTORY = "skills";
const MCP_TIMEOUT_MS = 600_000;

/**
 * 技能根优先级：低于插件根（从 FIRST_PLUGIN_PRIORITY 起步），
 * 高于随 CLI 内置的技能包（1_000_000）。用户/项目/插件同名技能应压过内置工程技能。
 */
const SKILL_ROOT_PRIORITY = 999_000;

/** monorepo 开发态与远端 stage 文档同款布局。 */
const MONOREPO_RELATIVE_ROOT = ["packages", "services", "dist", "engineering"] as const;
/** 桌面打包态：prepare-agent-node-bundle 把产物 stage 到 glm/packages/engineering。 */
const STAGED_RELATIVE_ROOT = ["packages", "engineering"] as const;
/** 与入口同级的扁平布局（未来 SEA 解压目录可直接复用）。 */
const FLAT_RELATIVE_ROOT = ["engineering"] as const;

/**
 * 回溯层数只用于覆盖 monorepo 入口深度差异：
 * cli/dist 需要 5 层到仓库根，bootstrap/dist/app 与 tsx 直跑 src/app 需要 6 层
 * （app → src → bootstrap → packages → zcode-cli → apps → 仓库根）。留 6 层是实测下限。
 */
const MAX_ANCESTOR_DEPTH = 6;

export interface EngineeringRuntime {
  /** MCP 入口绝对路径，便于诊断与日志。 */
  serverEntryPath: string;
  /** 直接并入 builtInMcpServers 的 server 配置。 */
  mcpServer: McpServerConfig;
  /** 直接并入 extraResolvedRoots 的技能根。 */
  skillRoot: SkillRoot;
}

export interface ResolveEngineeringRuntimeOptions {
  logger?: Logger;
}

export function resolveEngineeringRuntime(
  options: ResolveEngineeringRuntimeOptions = {},
): EngineeringRuntime | undefined {
  const root = findEngineeringRuntimeRoot({
    ancestorBases: bundleBaseDirs(),
    flatBases: [process.cwd()],
  });
  if (!root) {
    // 用 debug：绝大多数用户（全局安装的 CLI、未构建 services 的开发态）本来就没有该产物，
    // 每次启动 warn 只会变成噪音；真正连不上时由 MCP 连接层报错，对模型可见。
    options.logger?.debug("Engineering runtime not found", {
      module: "bootstrap.engineering_runtime",
      searchedRelativeRoots: [
        MONOREPO_RELATIVE_ROOT.join("/"),
        STAGED_RELATIVE_ROOT.join("/"),
        FLAT_RELATIVE_ROOT.join("/"),
      ],
    });
    return undefined;
  }

  const serverEntryPath = join(root, SERVER_ENTRY_FILE);
  return {
    serverEntryPath,
    mcpServer: {
      type: "stdio",
      command: process.execPath,
      args: [serverEntryPath],
      // 桌面打包态 process.execPath 是 ZCode Helper；缺该变量会误进 Electron main。
      env: { ELECTRON_RUN_AS_NODE: "1" },
      timeoutMs: MCP_TIMEOUT_MS,
    },
    skillRoot: {
      path: join(root, SKILLS_DIRECTORY),
      priority: SKILL_ROOT_PRIORITY,
      scope: "system",
      source: "bundled",
    },
  };
}

export interface EngineeringRuntimeSearchPaths {
  /** 随包资产起点：允许向上回溯，覆盖 monorepo 的 cli/dist、bootstrap/dist/app、tsx 直跑 src。 */
  ancestorBases: readonly string[];
  /** 工作区兜底：只看当前层，不向上回溯，避免命中工作区里任意深度的同名目录。 */
  flatBases: readonly string[];
}

export function findEngineeringRuntimeRoot(
  search: EngineeringRuntimeSearchPaths,
): string | undefined {
  // 随包资产优先：同一份产物里入口与技能必然同源，先命中先返回。
  for (const baseDir of search.ancestorBases) {
    const found = searchAncestors(baseDir);
    if (found) return found;
  }
  for (const baseDir of search.flatBases) {
    const found = matchCandidateRoot(baseDir);
    if (found) return found;
  }
  return undefined;
}

function searchAncestors(baseDir: string): string | undefined {
  let current = resolve(baseDir);
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    const found = matchCandidateRoot(current);
    if (found) return found;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function matchCandidateRoot(baseDir: string): string | undefined {
  for (const relativeRoot of [MONOREPO_RELATIVE_ROOT, STAGED_RELATIVE_ROOT, FLAT_RELATIVE_ROOT]) {
    const candidate = resolve(baseDir, ...relativeRoot);
    if (isEngineeringRoot(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 入口与技能目录必须同时存在。
 * 只有入口没有 skills 时技能根会指向空目录，模型读到「技能存在但正文为空」，
 * 比完全不注册更难诊断，因此按未命中处理。
 */
function isEngineeringRoot(candidateRoot: string): boolean {
  return (
    existsSync(join(candidateRoot, SERVER_ENTRY_FILE)) &&
    existsSync(join(candidateRoot, SKILLS_DIRECTORY))
  );
}
