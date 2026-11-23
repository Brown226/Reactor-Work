/**
 * 本地 API 目录：把厂商 API 文档编译成可按需检索的入口。
 *
 * 逆向自 PKPM Agent 的 references/*.db（10 个 SQLite 库，约 3.6 万条记录）。
 * 这里不重复实现 SQLite 读取——库文件与查询脚本在 skills 里已有，
 * 本模块只负责把「目录里的函数清单」映射成注入用的工具描述。
 *
 * 为什么需要它：COM 系软件（SAP2000/ETABS/Rhino/Tekla）没有运行时
 * tools/list，Agent 能调用什么由本地 API 目录决定。
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { builtinEngineeringSkillsRoot } from "../skills/builtin-skills.js";
import type { McpToolDescriptor } from "./injection.js";

/** 一个本地 API 目录的定位参数。 */
export interface ApiCatalogSpec {
  /** 目录名，如 `sap2000`、`etabs`。 */
  id: string;
  /** 目录文件的绝对路径；缺省由上层按技能目录推导。 */
  path?: string;
}

/** 目录里的单条函数记录（与逆向出的表结构对齐）。 */
interface CatalogRow {
  name: string;
  purpose?: string;
  syntax?: string;
  parameters?: string;
  module?: string;
}

/** 缓存：同一进程内同一路径只读一次。 */
const cache = new Map<string, McpToolDescriptor[]>();

/** 技能目录里 API 目录文件的固定文件名。 */
const CATALOG_FILE_NAME = "api.catalog.json";

/**
 * 按软件标识定位内置技能里的 API 目录文件。
 *
 * 为什么需要：注册表只登记了软件标识（`sap2000`、`etabs`…），而目录文件在
 * `<技能目录>/references/api.catalog.json` 里，技能目录名是 `SAP2000-Link`。
 * 此前 `catalog.path` 恒为 undefined，`loadApiCatalogTools` 直接返回空数组，
 * 导致 COM 系软件注入的可用函数为 0——连接看似成功，function_search 却查不到任何函数。
 *
 * 匹配规则：技能目录名与标识大小写无关地相等，或等于 `<标识>-Link`。
 * 找不到文件返回 undefined，交由上层按「无本地目录」降级，不抛异常。
 */
export function resolveApiCatalogPath(
  id: string,
  skillsRoot: string = builtinEngineeringSkillsRoot(),
): string | undefined {
  const target = id.trim().toLowerCase();
  if (!target) return undefined;

  let dirs: string[];
  try {
    dirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }

  for (const dir of dirs) {
    const name = dir.toLowerCase();
    if (name !== target && name !== `${target}-link`) continue;
    const path = join(skillsRoot, dir, "references", CATALOG_FILE_NAME);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * 读取一个本地 API 目录并转成工具描述。
 *
 * 目录文件缺失或格式不认识时返回空数组而不是抛异常：能力缺失应该是
 * 「这个软件暂时用不了」，不能让整个连接流程炸掉。
 */
export async function loadApiCatalogTools(spec: ApiCatalogSpec): Promise<McpToolDescriptor[]> {
  if (!spec.path) return [];
  const cached = cache.get(spec.path);
  if (cached) return cached;

  let raw: string;
  try {
    raw = await readFile(spec.path, "utf8");
  } catch {
    return [];
  }

  const rows = parseCatalog(raw);
  if (rows.length === 0) return [];

  const tools: McpToolDescriptor[] = rows.map((row) => ({
    name: row.name,
    description: row.purpose ?? "",
    group: row.module,
    inputSchema: schemaFromSyntax(row.syntax, row.parameters),
  }));

  cache.set(spec.path, tools);
  return tools;
}

/**
 * 解析目录文本。
 *
 * 支持两种形态：JSON 数组，以及「每行一条」的 TSV/CSV 简表。
 * 两种都能覆盖逆向出的库导出形式，不必依赖 SQLite 驱动。
 */
function parseCatalog(raw: string): CatalogRow[] {
  const text = raw.trim();
  if (!text) return [];

  // JSON 形态
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : undefined;
      if (list) {
        return list
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .map((item) => ({
            name: String(item.name ?? ""),
            purpose: item.purpose ? String(item.purpose) : undefined,
            syntax: item.syntax ? String(item.syntax) : undefined,
            parameters: item.parameters ? String(item.parameters) : undefined,
            module: item.module ? String(item.module) : undefined,
          }))
          .filter((row) => row.name.length > 0);
      }
    } catch {
      return [];
    }
  }

  // 行式形态：name<TAB>purpose<TAB>syntax<TAB>module
  const rows: CatalogRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cells = trimmed.split(/\t|\s{2,}/);
    const [name, purpose, syntax, module] = cells;
    if (!name) continue;
    rows.push({ name, purpose, syntax, module });
  }
  return rows;
}

/**
 * 从语法串推导一个宽松的入参 Schema。
 *
 * 这里不追求精确：拿不到结构化参数时给空 properties，让调用方按位置传参。
 * 假装能解析任意语法串只会制造错误的类型约束。
 */
function schemaFromSyntax(
  syntax: string | undefined,
  parameters: string | undefined,
): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: "object", properties: {} };
  const source = parameters ?? syntax;
  if (!source) return schema;

  // 只识别最保守的形态：逗号分隔的标识符列表。
  const names = source
    .replace(/^[^(]*\(/, "")
    .replace(/\).*$/, "")
    .split(",")
    .map((item) => item.trim().split(/[\s:=]/)[0] ?? "")
    .filter((item): item is string => /^[A-Za-z_][A-Za-z0-9_]*$/.test(item));

  if (names.length > 0) {
    const properties: Record<string, unknown> = {};
    for (const name of names) properties[name] = {};
    schema.properties = properties;
  }
  return schema;
}

/** 清空缓存，供测试或目录更新后重载。 */
export function clearApiCatalogCache(): void {
  cache.clear();
}
