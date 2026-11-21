/**
 * 内置工程技能：定位与清单。
 *
 * 22 份工程软件操作技能内置在本模块的 `skills/` 下，每个技能是一个目录 +
 * SKILL.md。Reactor 的技能系统按 `.zcode/skills` 扫描，所以这里提供
 * 「内置技能根目录」供上层在启动时登记，而不是复制文件到用户目录。
 *
 * 为什么内置而不复制：
 *   - 复制会与用户自建技能混淆，删不干净；
 *   - 内置资源随包升级，复制出去的那份会变成陈旧副本；
 *   - 技能正文里有厂商声明，内置可保证不被意外改写。
 */

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 当前文件所在目录（编译后仍在同一相对位置）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 内置工程技能根目录。
 *
 * Bugfix 原因：本文件自身就在 `engineering/skills/` 下，技能目录（`PKPM-Link`、
 * `Abaqus-Link` …）是 HERE 的直接子目录。此前再拼一层 `skills` 得到
 * `engineering/skills/skills`，该路径不存在，导致 22 份技能一份都枚举不到。
 * 修复依据：`listBuiltinEngineeringSkills()` 实跑返回 0 条，而 HERE 下确有 22 个目录。
 */
export function builtinEngineeringSkillsRoot(): string {
  return HERE;
}

/** 一份内置技能的概要。 */
export interface BuiltinSkillSummary {
  /** 目录名，如 `PKPM-Link`。 */
  dir: string;
  /** 绝对路径，指向技能目录。 */
  path: string;
  /** SKILL.md 的绝对路径。 */
  skillFile: string;
}

/**
 * 列出全部内置工程技能。
 *
 * 只做目录枚举；是否可用、是否被用户禁用由上层技能系统判断。
 * 缺 SKILL.md 的目录跳过，不抛异常。
 */
export async function listBuiltinEngineeringSkills(): Promise<BuiltinSkillSummary[]> {
  const root = builtinEngineeringSkillsRoot();
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: BuiltinSkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 跳过点目录与已知的非技能目录
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    const skillFile = join(path, "SKILL.md");
    try {
      // 存在性检查用 readdir 的 stat 成本更低，但这里要确认是文件。
      const { stat } = await import("node:fs/promises");
      const info = await stat(skillFile);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    result.push({ dir: entry.name, path, skillFile });
  }

  result.sort((a, b) => a.dir.localeCompare(b.dir));
  return result;
}

/** 按目录名取一份内置技能；不存在返回 undefined。 */
export async function getBuiltinEngineeringSkill(
  dir: string,
): Promise<BuiltinSkillSummary | undefined> {
  const all = await listBuiltinEngineeringSkills();
  return all.find((item) => item.dir === dir);
}
