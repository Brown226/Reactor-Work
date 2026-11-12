/**
 * 工具 schema → 类型化节点（W5-①）—— **纯函数层**。
 *
 * 设计来源：LeAgent `workflow/io/schema_bridge.py`（`json_schema_to_inputs`）+
 * `workflow/nodes/tool_factory.py`（`_build_schema`）（Apache-2.0）。映射规则逐条照抄。
 *
 * ## 解决什么问题
 *
 * 工具的参数字段是 JSON Schema，而「编排/表单/参数面板」需要的是一串**带类型的输入描述**
 * （该渲染成下拉还是文本框、是否必填、上下限多少）。手写这份映射必然与工具定义漂移 ——
 * 工具加了参数而面板没跟上，用户就填不出那个参数。
 * 这里做**单向自动派生**：schema 是唯一事实源，节点/表单由它生成。
 *
 * ## 两条纪律（照 LeAgent）
 *
 * ① **永不抛异常**：畸形 schema 一律降级为「任意类型」输入。工具作者的一个笔误
 *    不该让整个面板/工作流加载失败。
 * ② **未知形状降级而非猜测**：`oneOf`/`anyOf`/无 `type` → `any`。
 */

// ---------------------------------------------------------------------------
// 类型化输入
// ---------------------------------------------------------------------------

/** 输入控件类型（决定渲染成什么；`any` = 通配） */
export type ToolInputKind = "combo" | "string" | "int" | "float" | "boolean" | "array" | "object" | "any";

/** 一个派生出来的类型化输入 */
export interface ToolInput {
  readonly id: string;
  readonly kind: ToolInputKind;
  /** 非必填 */
  readonly optional: boolean;
  readonly tooltip?: string;
  readonly default?: unknown;
  /** 仅 `combo`：枚举候选项（**统一转成字符串**，照 LeAgent） */
  readonly choices?: readonly string[];
  /** 仅 `string`：多行（`multiline: true`，或 description 含换行） */
  readonly multiline?: boolean;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** 仅数值类型 */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

/** `buildToolNode` 的产物：一个由工具定义自动生成的节点描述 */
export interface ToolNodeSchema {
  /** `Tool.<toolName>`（照 LeAgent `_NODE_ID_PREFIX`） */
  readonly nodeId: string;
  readonly displayName: string;
  /** `tools/<category>` */
  readonly category: string;
  readonly description: string;
  readonly inputs: readonly ToolInput[];
  readonly outputs: readonly { readonly id: string; readonly kind: ToolInputKind }[];
  /** 由执行器提供、不由用户填的输入 */
  readonly hidden: readonly string[];
  /** 非幂等（写类工具）：编排层据此决定能否重放 */
  readonly notIdempotent: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * 控制面输入 id：它们**不属于工具自己的参数**，而是每个生成节点都带的执行控制。
 *
 * 生成前要从工具 schema 里**剔除**同名属性 —— 否则工具自带一个叫 `output` 的参数时，
 * 会和「把结果存到哪个变量」这个控制项**撞名**（照 LeAgent `_RESERVED_INPUT_IDS`）。
 */
export const RESERVED_INPUT_IDS: readonly string[] = ["retry_count", "retry_delay_sec", "output"];

/** 节点 id 前缀（照 LeAgent） */
export const TOOL_NODE_ID_PREFIX = "Tool.";

/** 隐藏输入（照 LeAgent `Hidden.UNIQUE_ID / TOOL_CONTEXT / WORKFLOW_STATE`） */
export const TOOL_NODE_HIDDEN_INPUTS: readonly string[] = ["UNIQUE_ID", "TOOL_CONTEXT", "WORKFLOW_STATE"];

// ---------------------------------------------------------------------------
// 派生
// ---------------------------------------------------------------------------

/** 解析出唯一确定的 JSON Schema 类型；有歧义 → null（照 LeAgent `_resolve_type`） */
export function resolveSchemaType(prop: Record<string, unknown>): string | null {
  const t = prop["type"];
  if (Array.isArray(t)) {
    // `["string","null"]` → string（可空不算歧义）；多类型 → 歧义
    const nonNull = t.filter((x) => x !== "null");
    return nonNull.length === 1 ? String(nonNull[0]) : null;
  }
  if (typeof t === "string") return t;
  return null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 单个属性 → 最贴切的类型化输入（照 LeAgent `_build_input`）。
 *
 * 判定顺序**必须先 enum 后 type**：`{type:"string", enum:[...]}` 应该渲染成下拉，
 * 而不是自由文本框（否则用户会填出枚举外的值）。
 */
export function buildToolInput(id: string, propSchema: unknown, required: boolean): ToolInput {
  const prop = (typeof propSchema === "object" && propSchema !== null ? propSchema : {}) as Record<string, unknown>;
  const description = typeof prop["description"] === "string" && prop["description"] !== "" ? prop["description"] : undefined;
  const hasDefault = Object.prototype.hasOwnProperty.call(prop, "default");
  const defaultValue = prop["default"];
  const optional = !required;
  const base = {
    id,
    optional,
    ...(description !== undefined ? { tooltip: description } : {}),
  };

  // ① enum 优先 → combo（候选统一转字符串，避免 number/boolean 枚举渲染成空）
  const enumValues = prop["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return { ...base, kind: "combo", choices: enumValues.map((v) => String(v)), ...(hasDefault ? { default: defaultValue } : {}) };
  }

  const jstype = resolveSchemaType(prop);

  if (jstype === "string") {
    // 多行：显式 `multiline: true`，或 description 含换行（照 LeAgent）
    const multiline = prop["multiline"] === true || (description !== undefined && description.includes("\n"));
    const dflt =
      defaultValue === undefined
        ? undefined
        : typeof defaultValue === "string"
          ? defaultValue
          : defaultValue === null
            ? null
            : String(defaultValue);
    return {
      ...base,
      kind: "string",
      ...(dflt !== undefined ? { default: dflt } : {}),
      ...(multiline ? { multiline: true } : {}),
      ...(typeof prop["pattern"] === "string" ? { pattern: prop["pattern"] } : {}),
      ...(asNumber(prop["minLength"]) !== undefined ? { minLength: asNumber(prop["minLength"]) } : {}),
      ...(asNumber(prop["maxLength"]) !== undefined ? { maxLength: asNumber(prop["maxLength"]) } : {}),
    };
  }

  if (jstype === "integer") {
    const multiple = asNumber(prop["multipleOf"]);
    const step = Math.max(1, multiple === undefined ? 1 : Math.trunc(multiple));
    const dflt = typeof defaultValue === "number" && Number.isInteger(defaultValue) ? defaultValue : undefined;
    return {
      ...base,
      kind: "int",
      step,
      ...(dflt !== undefined ? { default: dflt } : {}),
      ...(asNumber(prop["minimum"]) !== undefined ? { min: asNumber(prop["minimum"]) } : {}),
      ...(asNumber(prop["maximum"]) !== undefined ? { max: asNumber(prop["maximum"]) } : {}),
    };
  }

  if (jstype === "number") {
    const multiple = asNumber(prop["multipleOf"]);
    const dflt = typeof defaultValue === "number" ? defaultValue : undefined;
    return {
      ...base,
      kind: "float",
      step: multiple === undefined ? 0.01 : multiple,
      ...(dflt !== undefined ? { default: dflt } : {}),
      ...(asNumber(prop["minimum"]) !== undefined ? { min: asNumber(prop["minimum"]) } : {}),
      ...(asNumber(prop["maximum"]) !== undefined ? { max: asNumber(prop["maximum"]) } : {}),
    };
  }

  if (jstype === "boolean") {
    return { ...base, kind: "boolean", ...(typeof defaultValue === "boolean" ? { default: defaultValue } : {}) };
  }

  if (jstype === "array") {
    return { ...base, kind: "array", ...(Array.isArray(defaultValue) ? { default: defaultValue } : {}) };
  }

  if (jstype === "object") {
    return {
      ...base,
      kind: "object",
      ...(typeof defaultValue === "object" && defaultValue !== null && !Array.isArray(defaultValue) ? { default: defaultValue } : {}),
    };
  }

  // 未识别（oneOf/anyOf/无 type/其它）→ any，**不抛异常**
  return { ...base, kind: "any", ...(hasDefault ? { default: defaultValue } : {}) };
}

/**
 * JSON Schema 对象 → 类型化输入列表（照 LeAgent `json_schema_to_inputs`）。
 *
 * 非 object schema → 空数组（不是错误）；`drop` 用于剔除已被控制面占用的 id。
 * **属性顺序即输入顺序**（照 Python dict 保序），保证同 schema 同输出。
 */
export function jsonSchemaToInputs(
  schema: unknown,
  options: { drop?: readonly string[] } = {},
): ToolInput[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return [];
  const root = schema as Record<string, unknown>;
  const rootType = root["type"];
  if (rootType !== undefined && rootType !== null && rootType !== "object") return [];

  const props = root["properties"];
  if (typeof props !== "object" || props === null || Array.isArray(props)) return [];

  const requiredRaw = root["required"];
  const required = new Set(Array.isArray(requiredRaw) ? requiredRaw.map((r) => String(r)) : []);
  const drop = new Set(options.drop ?? []);

  const inputs: ToolInput[] = [];
  for (const [propId, propSchema] of Object.entries(props as Record<string, unknown>)) {
    if (drop.has(propId)) continue;
    inputs.push(buildToolInput(propId, propSchema, required.has(propId)));
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

/** 工具的分类 slug（照 LeAgent `_tool_category_slug`，缺省 `util`） */
export function toolCategorySlug(category: string | undefined): string {
  const value = (category ?? "").trim();
  return value === "" ? "util" : value;
}

/**
 * Python `str.title()` 的等价实现。
 *
 * 规则（与 CPython 一致，不是「按空格分段首字母大写」那么简单）：**前一个字符不是字母**
 * 时当前字母才大写，其余字母小写。所以：
 *  - `"data_clean"` → `"Data_Clean"`（下划线也是分隔符）
 *  - `"DATA"` → `"Data"`
 *  - `"a1b"` → `"A1B"`（数字后也算新词首）
 *
 * LeAgent 用 `tool.name.replace("_", " ").title()`，所以 `data_clean` 最终显示为
 * `Data Clean` —— 先替换再 title，两步都不能省。
 */
export function pythonTitle(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const prev = i === 0 ? "" : text[i - 1]!;
    const atWordStart = prev === "" || !/[a-zA-Z]/.test(prev);
    out += atWordStart ? ch.toUpperCase() : ch.toLowerCase();
  }
  return out;
}

/** 节点描述：`<工具描述> (category=…[, aliases=…])`（照 LeAgent `_describe_tool`） */
export function describeToolNode(tool: { description?: string; category?: string; aliases?: readonly string[] }): string {
  const base = (tool.description ?? "").trim();
  const meta = [`category=${toolCategorySlug(tool.category)}`];
  if (tool.aliases !== undefined && tool.aliases.length > 0) meta.push(`aliases=${tool.aliases.join(", ")}`);
  const suffix = `(${meta.join(", ")})`;
  return base === "" ? suffix : `${base} ${suffix}`;
}

export interface ToolNodeSource {
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly aliases?: readonly string[];
  /** 工具的 JSON Schema 参数定义 */
  readonly parameters?: unknown;
  readonly version?: string;
  readonly isReadOnly?: boolean;
  readonly isDestructive?: boolean;
}

/**
 * 由工具定义生成节点描述（照 LeAgent `_build_schema`）。
 *
 * `notIdempotent = !isReadOnly`：写类工具不能安全重放，编排层需要知道这件事
 * （重试一次写操作与重试一次读操作，后果完全不同）。
 */
export function buildToolNode(tool: ToolNodeSource): ToolNodeSchema {
  const typed = jsonSchemaToInputs(tool.parameters, { drop: RESERVED_INPUT_IDS });
  const categorySlug = toolCategorySlug(tool.category);
  const display = pythonTitle(tool.name.replace(/_/g, " "));

  const controlInputs: ToolInput[] = [
    {
      id: "retry_count",
      kind: "int",
      optional: true,
      default: 0,
      min: 0,
      max: 10,
      tooltip: "瞬时失败的重试次数（指数退避）",
    },
    {
      id: "retry_delay_sec",
      kind: "float",
      optional: true,
      default: 1,
      min: 0,
      max: 60,
      step: 0.5,
      tooltip: "重试基础间隔（秒），每次翻倍",
    },
    {
      id: "output",
      kind: "string",
      optional: true,
      tooltip: "可选：把结果存到该工作流变量",
    },
  ];

  return {
    nodeId: `${TOOL_NODE_ID_PREFIX}${tool.name}`,
    displayName: `Tool: ${display}`,
    category: `tools/${categorySlug}`,
    description: describeToolNode(tool),
    inputs: [...typed, ...controlInputs],
    outputs: [{ id: "result", kind: "any" }],
    hidden: TOOL_NODE_HIDDEN_INPUTS,
    notIdempotent: tool.isReadOnly !== true,
    metadata: {
      tool_name: tool.name,
      tool_category: categorySlug,
      tool_version: tool.version,
      tool_aliases: [...(tool.aliases ?? [])],
      tool_is_read_only: tool.isReadOnly === true,
      tool_is_destructive: tool.isDestructive === true,
      auto_generated: true,
    },
  };
}

/**
 * 反向：节点输入 → 工具参数（照 LeAgent `_collect_tool_params`）。
 *
 * 规则：剔除控制面字段；**缺失的键不传**；`null` 且可选也不传 ——
 * 这样「用户没填」与「用户填了空」在工具侧语义一致（都走工具的默认值），
 * 而不是把一堆 `null` 灌进参数里。
 */
export function collectToolParams(
  inputs: readonly ToolInput[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const reserved = new Set(RESERVED_INPUT_IDS);
  const params: Record<string, unknown> = {};
  for (const input of inputs) {
    if (reserved.has(input.id)) continue;
    if (!Object.prototype.hasOwnProperty.call(values, input.id)) continue;
    const value = values[input.id];
    if (value === null && input.optional) continue;
    params[input.id] = value;
  }
  return params;
}
