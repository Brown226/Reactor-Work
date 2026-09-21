/**
 * GenUI 容错归一（D4 第一刀）—— **纯函数**。
 *
 * 设计来源：LeAgent `services/gen_ui/schema.py` 的 `normalize_ui_tree` 家族
 * （`_coerce_legacy_type_to_kind` / `_lift_known_flat_props` / `_ensure_node_ids` /
 * `_coerce_number_token` / `_rename_prop`）（Apache-2.0）。规则逐条移植。
 *
 * ## 为什么需要它（而不是让模型严格照 schema 写）
 *
 * 这份载荷是**模型生成的**。模型几乎必然会犯这些错（LeAgent 逐条踩过）：
 *  - 用 React 风格的 `type` 而不是 `kind`；
 *  - 把组件字段**平铺在节点上**（`{kind:"Stat", label:"收入"}`）而不是放进 `props`；
 *  - 尺寸写成 `"md"` / `"12px"` 而不是数字；
 *  - 同一概念换名字（`text`/`label`/`content` 都指「要显示的文本」）；
 *  - 忘了 `nodeId`。
 *
 * 严格校验会把它们全部拒掉 → 用户看到一个错误而不是一个面板。归一层把**能猜准的**
 * 修好，**猜不准的**保留原样交给校验报错（**不静默吞掉任意垃圾** —— 这是 LeAgent
 * 的 `_lift_known_flat_props` 明确写下的分寸）。
 *
 * ## 与 LeAgent 的一处刻意收紧
 *
 * **未知 kind 直接丢弃该节点及其子树**（LeAgent 靠 json-schema 校验报错）。
 * 理由：我们的红线是不接受 3D/嵌入/交互表单类 kind，模型仍可能生成它们；
 * 若整棵树因此报错，用户什么也看不到。丢弃 + 在 `report` 里计数，让**能渲染的部分照常出现**，
 * 同时把「模型写了个不支持的 kind」变成可观测事实（而不是无声无息）。
 */

import {
  GENUI_KINDS,
  GENUI_LIMITS,
  GENUI_SCHEMA_VERSION,
  type GenUiKind,
  type GenUiNode,
  type NormalizeReport,
  type NormalizeResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// 数值 token
// ---------------------------------------------------------------------------

/** 尺寸 token 表（照 LeAgent `_SIZE_TOKENS`） */
export const GENUI_SIZE_TOKENS: Readonly<Record<string, number>> = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  base: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
};

/**
 * 把模型友好的尺寸写法转成渲染器要的数字（照 LeAgent `_coerce_number_token`）。
 *
 * 认：数字原样、`md` 这类 token、`12px`、`"12"`。不认的原样返回（**不猜**）。
 * 布尔要单独放过 —— 它是合法 prop 值，不能被当成数字 1/0。
 */
export function coerceNumberToken(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const raw = value.trim();
  if (raw === "") return value;
  let token = raw.toLowerCase();
  const fromTable = GENUI_SIZE_TOKENS[token];
  if (fromTable !== undefined) return fromTable;
  if (token.endsWith("px")) token = token.slice(0, -2).trim();
  const parsed = Number(token);
  if (!Number.isFinite(parsed) || token === "") return value;
  return Number.isInteger(parsed) ? parsed : parsed;
}

// ---------------------------------------------------------------------------
// prop 别名（照 LeAgent `_normalize_node_props` 的 `_rename_prop` 表）
// ---------------------------------------------------------------------------

/** `别名 → 目标名`（同目标内按数组顺序取第一个命中的别名；目标已存在则不覆盖） */
const PROP_ALIASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  Heading: { value: ["text", "title"] },
  Text: { value: ["text", "content", "label"] },
  Markdown: { content: ["text", "value"] },
  CodeBlock: { code: ["text", "content", "value"] },
  Stat: { label: ["title", "name"], value: ["text", "amount"] },
  Callout: { message: ["description", "text", "content"], title: ["heading"] },
  // —— 第二刀 ——
  SectionHeader: { value: ["text", "title", "label"] },
  MetricCard: { label: ["title", "name"], value: ["text", "amount"] },
  Progress: { value: ["percent", "text"], label: ["title", "name"] },
  Badge: { value: ["text", "label"] },
  Tag: { label: ["text", "value"] },
  TableCell: { value: ["text", "content"] },
  Alert: { message: ["description", "text", "content"], title: ["heading"] },
  Card: { title: ["heading", "name"], subtitle: ["description"] },
  HtmlFrame: { html: ["content", "body", "htmlContent", "frame"], height: ["maxHeight", "size"] },
  ScrollArea: { maxHeight: ["height", "max_height"] },
};

/** 需要做数值 token 归一的 prop（照 LeAgent 的键集合） */
const NUMERIC_PROPS = new Set([
  "gap",
  "padding",
  "size",
  "maxHeight",
  "columns",
  "level",
  // —— 第二刀 ——
  "height",
  "value",
  "max",
]);

/** 保留的节点级键（不会被 `lift` 搬进 props） */
const RESERVED_NODE_KEYS = new Set(["nodeId", "kind", "type", "props", "children"]);

// ---------------------------------------------------------------------------
// 归一
// ---------------------------------------------------------------------------

interface MutableReport {
  wrappedBareRoot: boolean;
  filledSchemaVersion: boolean;
  coercedTypeToKind: number;
  liftedFlatProps: number;
  coercedNumberTokens: number;
  renamedProps: number;
  generatedNodeIds: number;
  coercedChildren: number;
  droppedUnknownKind: number;
  unknownProps: string[];
  truncatedByDepth: number;
  notes: string[];
}

/** 判断载荷是不是「单个裸根节点」而不是信封（照 LeAgent `_looks_like_bare_root_node`） */
function looksLikeBareRoot(value: Record<string, unknown>): boolean {
  if ("root" in value) return false;
  return typeof value["kind"] === "string" || typeof value["type"] === "string";
}

/** 递归归一一个节点；返回 null 表示该 kind 未登记（连子树丢弃） */
function normalizeNode(raw: unknown, report: MutableReport, depth: number, idSeq: { n: number }): GenUiNode | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const node = raw as Record<string, unknown>;

  // ① `type` → `kind`（React 风格）
  const legacy = node["type"];
  if (typeof node["kind"] !== "string" || node["kind"].trim() === "") {
    if (typeof legacy === "string" && legacy.trim() !== "") {
      node["kind"] = legacy.trim();
      report.coercedTypeToKind += 1;
    }
  }
  delete node["type"];

  const kindRaw = typeof node["kind"] === "string" ? node["kind"].trim() : "";
  if (kindRaw === "" || !(kindRaw in GENUI_KINDS)) {
    report.droppedUnknownKind += 1;
    return null;
  }
  const kind = kindRaw as GenUiKind;
  const spec = GENUI_KINDS[kind];
  // 显式 `Set<string>`：`GENUI_KINDS` 用了 `as const satisfies`，props 会被推成字面量联合，
  // 直接用 `new Set(spec.props)` 会让 `known.has(key: string)` 报类型错。
  const known = new Set<string>(spec.props);

  // ② 把节点级扁平键搬进 props（**只搬目录里登记的**，其余留原地交给校验报错）
  const existingProps = node["props"];
  const props: Record<string, unknown> =
    typeof existingProps === "object" && existingProps !== null && !Array.isArray(existingProps)
      ? { ...(existingProps as Record<string, unknown>) }
      : {};
  /**
   * 上提节点级键 —— 比 LeAgent 宽一档（**刻意偏离**）：
   * LeAgent 只搬「目录登记的 prop 名」，而它的 prop 别名归一（`_rename_prop`）只看
   * `props` 内部 —— 于是模型写 `{kind:"Markdown", text:"…"}`（`text` 是 `content` 的别名、
   * 却被平铺在节点上）时**两处都救不到**，最终渲染成空白。
   * 这里把「该 kind 的别名键」也一并上提，让后续别名归一能接住它。
   * 未登记且非别名的键**不丢弃**（见 `unknownProps`）——不静默吞模型的错误。
   */
  const aliasKeys = new Set<string>(Object.values(PROP_ALIASES[kind] ?? {}).flat());
  for (const key of Object.keys(node)) {
    if (RESERVED_NODE_KEYS.has(key)) continue;
    const isCatalogProp = known.has(key);
    const isAlias = aliasKeys.has(key);
    if (isCatalogProp || isAlias) {
      // 显式写在 props 里的优先，不覆盖
      if (!(key in props)) {
        props[key] = node[key];
        report.liftedFlatProps += 1;
      }
      delete node[key];
      continue;
    }
    // 未登记：搬进 props（渲染端会忽略）但**记录**下来
    if (!(key in props)) props[key] = node[key];
    (report.unknownProps as string[]).push(`${kind}.${key}`);
    delete node[key];
  }

  // ③ prop 别名归一
  const aliases = PROP_ALIASES[kind];
  if (aliases !== undefined) {
    for (const [target, aliasList] of Object.entries(aliases)) {
      if (target in props) continue;
      for (const alias of aliasList) {
        if (alias in props) {
          props[target] = props[alias];
          report.renamedProps += 1;
          break;
        }
      }
    }
  }
  // `alignment` → `align`（照 LeAgent，对所有 kind 生效）
  if ("alignment" in props && !("align" in props)) {
    props["align"] = props["alignment"];
    report.renamedProps += 1;
  }

  // ④ 数值 token
  for (const key of Object.keys(props)) {
    if (!NUMERIC_PROPS.has(key)) continue;
    const before = props[key];
    const after = coerceNumberToken(before);
    if (after !== before) {
      props[key] = after;
      report.coercedNumberTokens += 1;
    }
  }

  // ⑤ 文本字段长度封顶（防一次塞进整本书；截断要留痕）
  for (const key of ["value", "content", "code", "message", "title"]) {
    const v = props[key];
    if (typeof v === "string" && v.length > GENUI_LIMITS.maxTextChars) {
      props[key] = `${v.slice(0, GENUI_LIMITS.maxTextChars)}…[truncated]`;
      report.notes.push(`节点的 ${key} 超过 ${GENUI_LIMITS.maxTextChars} 字符，已截断。`);
    }
  }

  /**
   * ⑤b `Table` 的 **children 形态 → header/rows**。
   *
   * 模型两种写法都会用（LeAgent 两种都支持）：
   *  ① 规范写法：`props: {header: [...], rows: [[...]]}`；
   *  ② 子节点写法：`children: [ {kind:"TableRow", children:[{kind:"TableCell", value:"…"}]}, … ]`。
   *
   * 而**共享表格引擎（W3）需要整表**才能算列类型/千分位/涨跌色/CJK 列宽 —— 逐个单元格
   * 渲染是算不出这些的。因此这里把形态②**上提**成形态①，让 `Table` 在渲染期恒为叶子。
   * 若模型两种都给了，以**显式 props 为准**（不覆盖）。
   */
  if (kind === "Table" && !Array.isArray(props["header"]) && !Array.isArray(props["rows"])) {
    const rowsRaw = Array.isArray(node["children"]) ? node["children"] : [];
    const hoisted: string[][] = [];
    for (const rowRaw of rowsRaw) {
      if (typeof rowRaw !== "object" || rowRaw === null) continue;
      const row = rowRaw as Record<string, unknown>;
      const rowKind = typeof row["kind"] === "string" ? row["kind"] : typeof row["type"] === "string" ? (row["type"] as string) : "";
      if (rowKind !== "TableRow") continue;
      const cellsRaw = Array.isArray(row["children"]) ? row["children"] : [];
      const cells: string[] = [];
      for (const cellRaw of cellsRaw) {
        if (typeof cellRaw !== "object" || cellRaw === null) continue;
        const cell = cellRaw as Record<string, unknown>;
        const cellKind = typeof cell["kind"] === "string" ? cell["kind"] : typeof cell["type"] === "string" ? (cell["type"] as string) : "";
        if (cellKind !== "TableCell") continue;
        const cellProps = typeof cell["props"] === "object" && cell["props"] !== null ? (cell["props"] as Record<string, unknown>) : {};
        const text = cellProps["value"] ?? cell["value"] ?? cell["text"] ?? "";
        cells.push(typeof text === "string" ? text : String(text));
      }
      if (cells.length > 0) hoisted.push(cells);
    }
    if (hoisted.length > 0) {
      // 首行是否算表头：显式 `header: true` 优先；否则按「第一行像表头」的保守启发式——不猜，
      // 一律把第一行当表头（办公表格的通行约定），并把原始行数记进 notes 便于核对。
      props["header"] = hoisted[0]!;
      props["rows"] = hoisted.slice(1);
      node["children"] = [];
      report.renamedProps += 1;
      report.notes.push(
        `Table 的子节点形态已上提为 header/rows（${hoisted.length} 行，首行作表头）——共享表格引擎需要整表才能算列类型与列宽。`,
      );
    }
  }

  // ⑥ nodeId（缺失即补，用确定性序号而非随机 —— 便于测试与缓存稳定）
  let nodeId = typeof node["nodeId"] === "string" ? node["nodeId"].trim() : "";
  if (nodeId === "") {
    idSeq.n += 1;
    nodeId = `n${idSeq.n}`;
    report.generatedNodeIds += 1;
  }

  // ⑦ children（模型有时给单个对象而不是数组）
  const children: GenUiNode[] = [];
  const rawChildren = node["children"];
  if (spec.children === "many") {
    if (rawChildren !== undefined && !Array.isArray(rawChildren)) {
      report.coercedChildren += 1;
    }
    const list = Array.isArray(rawChildren) ? rawChildren : rawChildren === undefined || rawChildren === null ? [] : [rawChildren];
    if (depth >= GENUI_LIMITS.maxDepth) {
      // 到达深度上限：**不递归**，但把「丢了多少」记下来（否则截断是无声的）
      if (list.length > 0) report.truncatedByDepth += list.length;
    } else {
      for (const child of list) {
        const normalized = normalizeNode(child, report, depth + 1, idSeq);
        if (normalized !== null) children.push(normalized);
      }
    }
  }

  return { nodeId, kind, props, children };
}

/** 统计节点数与深度（供上限校验） */
export function measureTree(root: GenUiNode): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  const walk = (n: GenUiNode, d: number): void => {
    nodes += 1;
    depth = Math.max(depth, d);
    for (const c of n.children) walk(c, d + 1);
  };
  walk(root, 1);
  return { nodes, depth };
}

/**
 * 归一 + 上限校验（**不抛异常**，除「根本不是对象」外一切都能产出可渲染的树）。
 *
 * 与 LeAgent 的差异：LeAgent 先 `normalize` 再 `jsonschema.validate` 再数深度/节点；
 * 我们把「未知 kind 丢弃」并入归一过程（见文件头说明），因此这里只有**规模**校验。
 */
export function normalizeUiTree(input: unknown): NormalizeResult {
  const report: MutableReport = {
    wrappedBareRoot: false,
    filledSchemaVersion: false,
    coercedTypeToKind: 0,
    liftedFlatProps: 0,
    coercedNumberTokens: 0,
    renamedProps: 0,
    generatedNodeIds: 0,
    coercedChildren: 0,
    droppedUnknownKind: 0,
    unknownProps: [],
    truncatedByDepth: 0,
    notes: [],
  };

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("ui tree 必须是 JSON 对象");
  }
  const raw = input as Record<string, unknown>;

  // 裸根节点 → 包成信封
  let envelope: Record<string, unknown>;
  if (looksLikeBareRoot(raw)) {
    envelope = { schemaVersion: GENUI_SCHEMA_VERSION, root: { ...raw } };
    report.wrappedBareRoot = true;
  } else {
    envelope = { ...raw };
  }
  let schemaVersion = envelope["schemaVersion"];
  if (typeof schemaVersion !== "string" || schemaVersion.trim() === "") {
    schemaVersion = GENUI_SCHEMA_VERSION;
    report.filledSchemaVersion = true;
  }

  const rootRaw = envelope["root"];
  if (typeof rootRaw !== "object" || rootRaw === null || Array.isArray(rootRaw)) {
    throw new Error("ui tree 缺少 root 节点（或 root 不是对象）");
  }
  const root = normalizeNode(rootRaw, report, 1, { n: 0 });
  if (root === null) {
    throw new Error("ui tree 的 root 节点 kind 未登记（无可渲染内容）");
  }

  const { nodes, depth } = measureTree(root);
  if (report.truncatedByDepth > 0) {
    report.notes.push(
      `树深度曾超过上限 ${GENUI_LIMITS.maxDepth}（保留后为 ${depth}），已丢弃 ${report.truncatedByDepth} 个过深节点。`,
    );
  }
  if (nodes > GENUI_LIMITS.maxNodes) {
    report.notes.push(`节点数 ${nodes} 超过上限 ${GENUI_LIMITS.maxNodes}（渲染端会按上限截断）。`);
  }
  if (report.droppedUnknownKind > 0) {
    report.notes.push(`丢弃 ${report.droppedUnknownKind} 个未登记的 kind 节点（含其子树）。`);
  }
  if (report.unknownProps.length > 0) {
    report.notes.push(`模型写了 ${report.unknownProps.length} 个未登记的 prop：${report.unknownProps.slice(0, 6).join("、")}（已保留在 props，渲染端忽略）。`);
  }

  return {
    tree: { schemaVersion: String(schemaVersion), root },
    report: { ...report, notes: [...report.notes] } as NormalizeReport,
  };
}

/**
 * 生成给模型的**写法说明**（由目录派生，因此永不与校验漂移）。
 *
 * 这替代了 LeAgent 单独的 `genui_guide` 工具：说明短到可以放进工具描述，
 * 不必让模型多花一次调用去取 —— 目录成为唯一事实源的直接收益。
 */
export function describeGenUiKinds(): string {
  return Object.entries(GENUI_KINDS)
    .map(([kind, spec]) => {
      const props = spec.props.length > 0 ? spec.props.join(" / ") : "（无 props）";
      const kids = spec.children === "many" ? "可带 children" : "叶子";
      return `- ${kind}（${kids}）：${spec.description}；props: ${props}`;
    })
    .join("\n");
}
