/**
 * 能力总览：把「已登记的软件能做什么」整理成一份只读清单。
 *
 * 为什么需要它：诊断面板只回答「缺什么」（Python 有没有、COM 注册有没有），
 * 用户看完仍然不知道「装了之后能干什么」。这个模块补的就是另一半：
 * 每个软件能调用多少函数、走什么接口、对应哪个技能包、可以怎么开口。
 *
 * 设计边界：
 *   - 只读：不启动软件、不建连接、不改配置。
 *   - 与 `diagnose()` 一样由 main 进程执行，结果经同一条 IPC 返回，不新增通道。
 *   - 探测全部并行，避免 COM 注册表逐条串行把页面拖慢。
 */

import { readFileSync } from "node:fs";

import { resolveApiCatalogPath } from "./api-catalog.js";
import { resolveExecutable } from "./discovery.js";
import { MODELING_CORE_SPECS, listDesktopServerSpecs } from "./registry.js";
import type { DesktopServerSpec } from "./registry.js";
import { isComProgIdRegistered } from "./win-registry.js";

/** 一个软件的能力条目；与 shared 侧 EngineeringCapability 字段一一对应。 */
export interface EngineeringCapability {
  server: string;
  productName: string;
  bridge: string;
  installed: boolean;
  exePath?: string;
  functionCount: number;
  skillDir?: string;
  hint?: string;
}

/** 桥接方式的中文标签，与 registry 里 FACTORIES 用的是同一套措辞。 */
const BRIDGE_TEXT: Record<DesktopServerSpec["bridge"], string> = {
  com: "COM",
  dotnet: ".NET",
  http: "本地 HTTP API",
  ruby: "Ruby 插件",
  python: "自带 Python",
};

/** 生成一条能力所需的输入：两类来源（建模内核 / 桌面软件）归一到这里。 */
interface CapabilityInput {
  server: string;
  productName: string;
  bridge: string;
  exeName: string;
  /** 空字符串表示没有本地 API 目录（建模内核走 MCP tools/list）。 */
  catalogId: string;
  progId?: string;
  featurePaths?: string[];
  exeEnvVars?: string[];
  rootEnvVars?: string[];
  skillDir?: string;
  hint?: string;
}

/**
 * 统计本地 API 目录里的可调用函数数。
 *
 * 只读文件长度而不是走 `loadApiCatalogTools`：后者会为每条记录生成入参 Schema，
 * 十几万条记录在页面上完全没必要。解析失败按 0 处理，能力缺失不该让页面报错。
 */
function countCatalogEntries(path: string | undefined): number {
  if (!path) return 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** 从目录文件路径反推技能目录名：<skillsRoot>/<目录名>/references/api.catalog.json。 */
function skillDirOfCatalogPath(path: string): string | undefined {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts.length >= 3 ? parts[parts.length - 3] : undefined;
}

async function capabilityOf(input: CapabilityInput): Promise<EngineeringCapability> {
  const catalogPath = input.catalogId ? resolveApiCatalogPath(input.catalogId) : undefined;
  const functionCount = countCatalogEntries(catalogPath);

  // COM 系以 ProgID 注册为安装判据：exe 可能因进程内服务器或自定义安装位置取不到，
  // 但那不代表没装，用 exe 判断会误报未安装。
  let installed: boolean;
  let exePath: string | undefined;
  if (input.progId) {
    installed = await isComProgIdRegistered(input.progId);
  } else {
    const resolved = await resolveExecutable(
      {},
      {
        productName: input.productName,
        exeName: input.exeName,
        featurePaths: input.featurePaths ?? [],
        exeEnvVars: input.exeEnvVars,
        rootEnvVars: input.rootEnvVars,
      },
    );
    installed = resolved !== undefined;
    exePath = resolved?.path;
  }

  return {
    server: input.server,
    productName: input.productName,
    bridge: input.bridge,
    installed,
    exePath,
    functionCount,
    skillDir: (catalogPath ? skillDirOfCatalogPath(catalogPath) : undefined) ?? input.skillDir,
    hint: input.hint,
  };
}

/**
 * 列出全部能力条目：建模内核（MCP 系）在前，桌面软件在后。
 *
 * 全并行：COM 注册表查询是本函数里最慢的一步，串行会明显拖慢页面。
 */
export async function listCapabilities(): Promise<EngineeringCapability[]> {
  const core = MODELING_CORE_SPECS.map((spec) =>
    capabilityOf({
      server: spec.serverName,
      productName: spec.productName,
      bridge: spec.bridgeLabel,
      exeName: spec.exeName,
      // 建模内核没有本地 API 目录，函数数由 MCP tools/list 提供。
      catalogId: "",
      featurePaths: spec.featurePaths,
      exeEnvVars: spec.exeEnvVars,
      rootEnvVars: spec.rootEnvVars,
      skillDir: spec.skillDir,
      hint: spec.hint,
    }),
  );

  const desktop = listDesktopServerSpecs().map((spec) =>
    capabilityOf({
      server: spec.serverName,
      productName: spec.productName,
      bridge: BRIDGE_TEXT[spec.bridge],
      exeName: spec.exeName,
      catalogId: spec.catalogId,
      progId: spec.progId,
      featurePaths: spec.featurePaths,
      exeEnvVars: spec.exeEnvVars,
      rootEnvVars: spec.rootEnvVars,
      hint: spec.hint,
    }),
  );

  return await Promise.all([...core, ...desktop]);
}
