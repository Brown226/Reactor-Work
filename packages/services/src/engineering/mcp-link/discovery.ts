/**
 * 安装位置发现：按优先级解析目标软件的可执行文件。
 *
 * 逆向自 PKPM Agent 的 discovery 逻辑，优先级：
 *   显式路径 > 环境变量 > 上次成功路径 > 自动发现（注册表四路）
 * 每个候选项必须通过 isValidRoot 校验，不合格静默跳过。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { DiscoveryOverrides } from "./types.js";

/** 候选来源，用于诊断「为什么没找到」。 */
export type DiscoverySource =
  | "explicit"
  | "environment"
  | "verified"
  | "uninstall-registry"
  | "product-registry"
  | "file-association"
  | "install-root-env";

export interface CandidateRoot {
  path: string;
  source: DiscoverySource;
}

export interface DiscoverOptions {
  /** 产品名，用于组织错误文案与注册表键名。 */
  productName: string;
  /** 启动器文件名，如 `BIMBase.exe`。 */
  exeName: string;
  /** 用于校验安装根的特征文件（相对路径），如 `Interface/P3DTemplate/temp.p3d`。 */
  featurePaths: string[];
  /** 环境变量名列表，按顺序尝试。 */
  exeEnvVars?: string[];
  /** 安装根环境变量名列表，按顺序尝试。 */
  rootEnvVars?: string[];
  /** 读注册表候选根目录；平台不支持时返回空数组。 */
  registryRoots?: () => Promise<CandidateRoot[]>;
  /** 上次成功路径提供者。 */
  verifiedPath?: () => string | undefined;
}

/** 判断一个目录是否像目标软件的安装根。 */
export function isValidRoot(root: string, featurePaths: string[]): boolean {
  if (!root || !existsSync(root)) return false;
  return featurePaths.every((feature) => existsSync(join(root, feature)));
}

function fromEnv(names: string[] | undefined): string | undefined {
  for (const name of names ?? []) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * 收集全部候选安装根，按优先级排序。
 * 不存在的路径也保留，便于错误文案说明「试过哪些位置」。
 */
export async function candidateRoots(options: DiscoverOptions): Promise<CandidateRoot[]> {
  const roots: CandidateRoot[] = [];

  const fromExeEnv = fromEnv(options.exeEnvVars);
  if (fromExeEnv) roots.push({ path: fromExeEnv, source: "environment" });

  const verified = options.verifiedPath?.();
  if (verified) roots.push({ path: verified, source: "verified" });

  const fromRootEnv = fromEnv(options.rootEnvVars);
  if (fromRootEnv) roots.push({ path: fromRootEnv, source: "install-root-env" });

  if (options.registryRoots) {
    roots.push(...(await options.registryRoots()));
  }

  return roots;
}

export interface ResolvedExecutable {
  path: string;
  source: DiscoverySource;
}

/**
 * 解析可执行文件路径。命中即停；全部失败返回 undefined。
 * 显式路径不做存在性校验以外的加工，避免把用户输入改错。
 */
export async function resolveExecutable(
  overrides: DiscoveryOverrides,
  options: DiscoverOptions,
): Promise<ResolvedExecutable | undefined> {
  if (overrides.exePath) {
    return { path: overrides.exePath, source: "explicit" };
  }

  const roots = await candidateRoots(options);
  for (const root of roots) {
    // 环境变量可能直接给 exe，也可能给安装根。
    if (root.path.toLowerCase().endsWith(".exe")) {
      if (existsSync(root.path)) return { path: root.path, source: root.source };
      continue;
    }
    if (!isValidRoot(root.path, options.featurePaths)) continue;
    const exe = join(root.path, options.exeName);
    if (existsSync(exe)) return { path: exe, source: root.source };
  }

  return undefined;
}
