/**
 * SKILL.md frontmatter 抽取（技能元数据的来源，**不引入 YAML 依赖**）。
 *
 * ## 为什么不用完整 YAML 解析器
 * 服务端要在 create/update 时把元数据落列（目录检索/分类/精选都靠它），shared 又是三端共用；
 * 为此把 `js-yaml` 提升成 shared 的运行时依赖会牵动依赖树与安装。而技能元数据实际只用到
 * 极少构造：标量、引号、行内数组、块列表、以及 `|`/`>` 折叠文本。故这里实现一个**容错子集**：
 *  - 认不出来的一律**忽略**（绝不抛）；
 *  - 解析失败/无 frontmatter/类型不符 → 对应字段为 undefined，调用方保留原值（不覆盖已有数据）。
 *
 * 客户端的「文件查看器 frontmatter 卡片」仍用 `file-viewer/lib/frontmatter.ts` 的完整
 * js-yaml 实现 —— 那处要**原样展示任意 frontmatter**（含嵌套 map、锚点），与本模块的
 * "只抽取已知键"是两种需求，刻意分开。
 *
 * ## 支持的键（camel 与 kebab 双写都认，Agent Skills 规范用 kebab）
 *   name / description / version / icon / category / tags
 *   disable-model-invocation | disableModelInvocation
 *   allowed-tools | allowedTools
 */

export interface SkillFrontmatterMeta {
  name?: string;
  description?: string;
  version?: string;
  /** 单个 emoji 或 http(s) 图标 URL */
  icon?: string;
  category?: string;
  tags?: string[];
  disableModelInvocation?: boolean;
  allowedTools?: string[];
}

export interface SkillFrontmatterResult {
  /** 原始 frontmatter 键值（可辨认的部分） */
  data: Record<string, unknown> | null;
  /** 映射后的技能元数据（只含能确定的字段） */
  meta: SkillFrontmatterMeta;
  /** frontmatter 之后的正文；无 frontmatter 时等于原文 */
  body: string;
}

const OPEN_RE = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\n|\r)/;

interface Block {
  yaml: string;
  body: string;
}

function extractBlock(markdown: string): Block | null {
  const open = OPEN_RE.exec(markdown);
  if (!open) return null;
  const closeRe = /^---[ \t]*(?:(?:\r\n|\n|\r)|$)/gm;
  closeRe.lastIndex = open[0].length;
  const close = closeRe.exec(markdown);
  if (!close) return null;
  return {
    yaml: markdown.slice(open[0].length, close.index).replace(/(?:\r\n|\n|\r)$/, ""),
    body: markdown.slice(close.index + close[0].length),
  };
}

/** 去掉成对引号（单/双），并还原 YAML 里常见的转义 */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner.replace(/''/g, "'");
  }
  return v;
}

/** 行内数组：`[a, b, "c d"]` */
function parseInlineList(value: string): string[] | undefined {
  const t = value.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return undefined;
  return t
    .slice(1, -1)
    .split(",")
    .map((part) => unquote(part))
    .filter((s) => s.length > 0);
}

/** 逗号/顿号分隔的退化写法：`a, b` → [a, b] */
function parseLooseList(value: string): string[] {
  return value
    .split(/[,，、]/)
    .map((s) => unquote(s))
    .filter((s) => s.length > 0);
}

function toBool(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

/**
 * 容错解析 frontmatter 文本（只认 `key: value` 顶层键；`|`/`>` 折叠取后续更缩进行）。
 */
function parseLooseYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    // 只处理**顶格**键：缩进行属于上一块的续行
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const inline = m[2] ?? "";

    // 折叠/字面量块：`|` `>` `|-` `>-` …
    if (/^[|>][-+]?\s*$/.test(inline.trim())) {
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j]!;
        if (next.trim() === "") { collected.push(""); continue; }
        if (!/^\s+/.test(next)) break;
        collected.push(next.replace(/^\s{1,}/, ""));
      }
      i = j - 1;
      const joined = inline.trim().startsWith(">")
        ? collected.join(" ").replace(/\s+/g, " ").trim()
        : collected.join("\n").replace(/\n+$/, "");
      out[key] = joined;
      continue;
    }

    // 块列表：后续 `- item` 行
    if (inline.trim() === "") {
      const items: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j]!;
        const item = /^\s*-\s+(.*)$/.exec(next);
        if (!item) break;
        const v = unquote(item[1] ?? "");
        if (v) items.push(v);
      }
      if (items.length > 0) {
        i = j - 1;
        out[key] = items;
      }
      continue;
    }

    const list = parseInlineList(inline);
    out[key] = list ?? unquote(inline);
  }
  return out;
}

const pick = (data: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) {
    const v = data[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};

const asString = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
};

const asStringList = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) {
    const list = v.map((x) => asString(x)).filter((x): x is string => x !== undefined);
    return list.length > 0 ? list : undefined;
  }
  const s = asString(v);
  if (!s) return undefined;
  const loose = parseLooseList(s);
  return loose.length > 0 ? loose : undefined;
};

/** 字典序去重（保持稳定，便于测试与展示） */
const dedupe = (list: string[]): string[] => [...new Set(list)];

export function parseSkillFrontmatter(content: string): SkillFrontmatterResult {
  const text = typeof content === "string" ? content : "";
  const block = extractBlock(text);
  if (!block) return { data: null, meta: {}, body: text };

  let data: Record<string, unknown> | null = null;
  try {
    const parsed = parseLooseYaml(block.yaml);
    data = Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    data = null;
  }

  const meta: SkillFrontmatterMeta = {};
  if (data) {
    const name = asString(pick(data, "name"));
    if (name) meta.name = name;

    const description = asString(pick(data, "description"));
    if (description) meta.description = description.replace(/\s+/g, " ").trim();

    const version = asString(pick(data, "version"));
    if (version) meta.version = version;

    const icon = asString(pick(data, "icon"));
    if (icon) meta.icon = icon;

    const category = asString(pick(data, "category"));
    if (category) meta.category = category.toLowerCase();

    const tags = asStringList(pick(data, "tags"));
    if (tags) meta.tags = dedupe(tags).slice(0, 10);

    const flag = pick(data, "disable-model-invocation", "disableModelInvocation");
    const bool = typeof flag === "boolean" ? flag : typeof flag === "string" ? toBool(flag) : undefined;
    if (bool !== undefined) meta.disableModelInvocation = bool;

    const tools = asStringList(pick(data, "allowed-tools", "allowedTools"));
    if (tools) meta.allowedTools = dedupe(tools);
  }

  return { data, meta, body: block.body };
}
