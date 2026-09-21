/**
 * 工具参数纠错指引 + 别名读取（W2-④）—— 设计照搬 penguin `tool-arguments.ts`（Apache-2.0）。
 *
 * ## 为什么需要它
 *
 * 模型把参数写错时，一行「missing argument」**给不了它任何可比对的东西** ——
 * 它相信自己遵守了 schema，于是原样重发同一次调用，白烧一轮。penguin 的做法是把
 * **整段输出写成一份纠错指引**：
 *   ① 点名错在哪（缺失 / 类型不符 / 为空 / 不可用；经别名送达也一并说明）
 *   ② 列出**实际收到的参数名**，并点出工具**未声明**的名字
 *   ③ 按交给模型的 schema **重述全部参数**（名称、类型、必填、别名、说明）
 *   ④ 收尾给出**一次正确调用的形态**（含全部必填 + 出错的那个）
 *
 * 收尾句刻意重复工具名与参数名：服务端异常台账保留的是失败输出的**尾部**，
 * 尾部必须能独立说明出了什么错。
 *
 * ## 别名机制（同一份名单，三处共用）
 *
 * 参数可能以别名送达（`exec_command` 的 `command` 之于 `cmd`）。
 * **关键**：别名必须由「工具执行」「命令策略筛查」「调用预览」**读同一份名单** ——
 * 策略筛查的正是工具将执行的文本，两者看到的值不能有两个。
 *
 * ## 与本仓既有实现的边界
 *
 * 本模块是**纯函数**（零依赖、可单测）。接线点在 W2 后续：把 `describeArgumentError`
 * 接进工具参数校验失败路径（替换当前 Pi 的单行错误）。
 */

/** 从调用参数里按优先级取字符串：`names` 为「schema 名在前，别名在后」 */
export interface NamedString {
  /** 实际送达时用的名字 */
  name: string;
  value: string;
}

/**
 * 返回 `names` 中第一个携带字符串的项及其值；都不含则 undefined。
 *
 * `names` 按优先级排列（schema 名在前、别名在后），保证**所有消费方读到同一个值**
 * （工具与其命令策略不会各读一个）。
 */
export function stringArgument(
  args: Record<string, unknown>,
  names: readonly string[],
): NamedString | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string") return { name, value };
  }
  return undefined;
}

/** 一次调用某个参数的毛病 */
export type ArgumentFault =
  /** 必需参数缺失；指引会读 `args` 分辨是「没给」「类型不符」还是「空串」 */
  | { argument: string; kind: "missing" }
  /** 参数给了但不可用；`detail` 说明要求与实收，不带句号 */
  | { argument: string; kind: "invalid"; detail: string };

export interface ToolSchemaLike {
  name: string;
  parameters?: Record<string, unknown>;
}

export interface ArgumentErrorOptions {
  /** 参数除 schema 名外还接受的名字（不出现在「未声明」里，列在参数旁） */
  aliases?: Readonly<Record<string, readonly string[]>>;
  /** 追加在毛病句后的指引（如「改用另一个工具」） */
  hint?: string;
}

interface SchemaParameter {
  name: string;
  type: string;
  required: boolean;
  description: string | undefined;
}

/** 按**声明顺序**（即模型看到的顺序）取出 schema 声明的参数 */
function schemaParameters(definition: ToolSchemaLike): SchemaParameter[] {
  const params = definition.parameters;
  const properties = params?.["properties"];
  if (properties === null || typeof properties !== "object") return [];
  const required = params?.["required"];
  const requiredNames = new Set(
    Array.isArray(required) ? required.filter((n): n is string => typeof n === "string") : [],
  );
  return Object.entries(properties as Record<string, unknown>).map(([name, schema]) => {
    const s = schema !== null && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
    return {
      name,
      type: schemaType(s["type"]),
      required: requiredNames.has(name),
      description: typeof s["description"] === "string" ? s["description"] : undefined,
    };
  });
}

/** schema 的 `type` 转人话：单名 / 多名联合 / `any` */
function schemaType(type: unknown): string {
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    const names = type.filter((t): t is string => typeof t === "string");
    if (names.length > 0) return names.join(" | ");
  }
  return "any";
}

/** 实收值的类型，带冠词：`a number` / `an array` / `null` */
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

function withArticle(type: string): string {
  return /^[aeiou]/i.test(type) ? `an ${type}` : `a ${type}`;
}

/** 示例调用里该参数的占位值 */
function placeholder(parameter: SchemaParameter): string {
  switch (parameter.type) {
    case "number":
    case "integer":
      return "0";
    case "boolean":
      return "false";
    case "array":
      return "[]";
    case "object":
      return "{}";
    default:
      return `"<${parameter.name}>"`;
  }
}

/** 点名毛病的那句（含「经别名送达」的说明） */
function faultSentence(
  fault: ArgumentFault,
  args: Record<string, unknown>,
  parameters: SchemaParameter[],
  aliases: Readonly<Record<string, readonly string[]>>,
): string {
  const quoted = `"${fault.argument}"`;
  if (fault.kind === "invalid") return `argument ${quoted} is invalid: ${fault.detail}.`;
  const present = [fault.argument, ...(aliases[fault.argument] ?? [])].find((n) => n in args);
  if (present === undefined) return `required argument ${quoted} is missing.`;
  const as = present === fault.argument ? "" : ` (received as "${present}")`;
  const value = args[present];
  const expected = parameters.find((p) => p.name === fault.argument)?.type ?? "string";
  // 「要字符串、给字符串」只可能是空串问题；「要数字/布尔、给字符串」是类型不符
  if (typeof value === "string" && (expected === "string" || value.trim() === "")) {
    return `required argument ${quoted}${as} is empty.`;
  }
  if (expected === "any") {
    return `argument ${quoted}${as} cannot be used as received (${typeName(value)}).`;
  }
  return `argument ${quoted}${as} must be ${withArticle(expected)}, but ${typeName(value)} was received.`;
}

/** 列出实收参数名，并点出未声明的（写错名字就靠这行被抓住） */
function receivedLine(
  tool: string,
  args: Record<string, unknown>,
  parameters: SchemaParameter[],
  aliases: Readonly<Record<string, readonly string[]>>,
): string {
  const names = Object.keys(args);
  if (names.length === 0) return "Arguments received: none.";
  let line = `Arguments received: ${names.join(", ")}.`;
  if (parameters.length > 0) {
    const known = new Set(parameters.map((p) => p.name));
    for (const list of Object.values(aliases)) for (const alias of list) known.add(alias);
    const unknown = names.filter((n) => !known.has(n));
    if (unknown.length > 0) {
      const noun = unknown.length === 1 ? "a parameter" : "parameters";
      line += ` Not ${noun} of ${tool}: ${unknown.join(", ")}.`;
    }
  }
  return line;
}

/** 参数列表的一行：名称、类型、必填/可选、别名、说明 */
function parameterLine(parameter: SchemaParameter, aliases: readonly string[] | undefined): string {
  const facts = [parameter.type, parameter.required ? "required" : "optional"].join(", ");
  const alias =
    aliases !== undefined && aliases.length > 0
      ? `; also accepted as ${aliases.map((a) => `"${a}"`).join(", ")}`
      : "";
  const head = `- ${parameter.name} (${facts}${alias})`;
  return parameter.description === undefined ? head : `${head}: ${parameter.description}`;
}

/** 收尾指令：给出一次正确调用的形态（含全部必填 + 出错的那个） */
function closingLine(tool: string, fault: ArgumentFault, parameters: SchemaParameter[]): string {
  const fix =
    fault.kind === "missing"
      ? `with "${fault.argument}" provided`
      : `with a valid "${fault.argument}"`;
  const shown = parameters.filter((p) => p.required || p.name === fault.argument);
  if (shown.length === 0) {
    return `Call ${tool} again ${fix}, as one JSON object using the tool's parameter names.`;
  }
  const example = `{${shown.map((p) => `"${p.name}": ${placeholder(p)}`).join(", ")}}`;
  return `Call ${tool} again ${fix}, as one JSON object using exactly these parameter names, e.g. ${example}.`;
}

/**
 * 因参数被拒的调用的**整段输出**。
 *
 * `definition` 是被调用的工具条目（**与交给模型的是同一份 schema**），
 * 保证重述的参数列表就是模型能发的东西。
 */
export function describeArgumentError(
  definition: ToolSchemaLike,
  args: Record<string, unknown>,
  fault: ArgumentFault,
  options: ArgumentErrorOptions = {},
): string {
  const tool = definition.name;
  const parameters = schemaParameters(definition);
  const aliases = options.aliases ?? {};
  const hint = options.hint === undefined ? "" : ` ${options.hint}`;
  const lines = [
    `${tool} was not run: ${faultSentence(fault, args, parameters, aliases)}${hint}`,
    receivedLine(tool, args, parameters, aliases),
  ];
  if (parameters.length > 0) {
    lines.push(`Parameters of ${tool}:`);
    for (const parameter of parameters) lines.push(parameterLine(parameter, aliases[parameter.name]));
  }
  lines.push(closingLine(tool, fault, parameters));
  return lines.join("\n");
}

/**
 * 参数别名表（**单一事实源**）。
 *
 * ⚠️ 使用纪律（照 penguin）：别名必须由「工具执行」「命令策略筛查」「调用预览」
 * **读同一份名单** —— 策略筛查的正是工具将执行的文本，两者看到的值不能有两个。
 * 因此新增别名**只改这里**，不要在策略或 UI 里另抄一份。
 */
export const TOOL_ARGUMENT_ALIASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  // bash 的规范名是 command；模型常写 cmd / script
  bash: { command: ["cmd", "script"] },
  powershell: { command: ["cmd", "script"] },
  // 文件路径：规范名 path；模型常写 file_path / filePath
  read: { path: ["file_path", "filePath"] },
  write: { path: ["file_path", "filePath"] },
  edit: { path: ["file_path", "filePath"] },
  read_office: { path: ["file_path", "filePath"] },
};

/** 取某工具的别名表（无则空对象） */
export function aliasesForTool(toolName: string): Readonly<Record<string, readonly string[]>> {
  return TOOL_ARGUMENT_ALIASES[toolName] ?? {};
}

/**
 * 按「schema 名 → 别名」优先级归一参数：把别名键的值搬到规范名下。
 *
 * - **规范名已存在时以规范名为准**（别名不覆盖，与 penguin 一致）；
 * - 不改动未识别的键（交给上层按需处理/报错）。
 *
 * 返回新对象（纯函数，不修改入参）。
 */
export function normalizeArgumentAliases(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const spec = aliasesForTool(toolName);
  if (Object.keys(spec).length === 0) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [canonical, aliases] of Object.entries(spec)) {
    if (out[canonical] !== undefined) continue; // 规范名优先
    for (const alias of aliases) {
      if (out[alias] !== undefined) {
        out[canonical] = out[alias];
        delete out[alias];
        break;
      }
    }
  }
  return out;
}

/** 参数校验结果（供 `prepareToolArguments` 返回） */
export interface PreparedArguments {
  /** 归一后的参数（供执行与策略共用） */
  args: Record<string, unknown>;
  /** 非 null 时 = 纠错指引全文（调用方应把它当作工具输出返回给模型，不执行工具） */
  error: string | null;
}

/**
 * 必需的「非空」判定：None/空白串/空数组/空对象都算给了等于没给。
 *
 * 照 penguin `_is_present` 的语义 —— 模型交一个空串也算缺值，
 * 否则会在工具内部崩掉而不是得到一份可修正的指引。
 */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/**
 * 工具参数预处理：**先归别名，再查必需参数**。
 *
 * 这是 W2-④ 的接线核心 —— Pi 的 `ToolDefinition.prepareArguments` 在
 * `validateToolArguments` **之前**跑，且其内部 try/catch 会把**抛出的 message 原样**
 * 作为工具输出交给模型（见 pi-agent-core `prepareToolCall`）。所以：
 *  - 归一成功 → 验证器看到规范名 → 调用成立；
 *  - 必需参数确实缺失/为空 → 抛 `describeArgumentError` 全文 → 模型得到可修正的指引。
 *
 * 不做全量类型校验（那会与 Pi 的验证器重复）；只捕获「模型最常输错且原提示最无用」
 * 的两类：参数写错名字（→ 别名或「未声明」点名）与必需项没给（→ 重述 schema）。
 */
export function prepareToolArguments(
  definition: ToolSchemaLike,
  args: unknown,
  options: ArgumentErrorOptions = {},
): PreparedArguments {
  const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const normalized = normalizeArgumentAliases(definition.name, raw);
  const aliases = options.aliases ?? aliasesForTool(definition.name);

  for (const parameter of schemaParameters(definition)) {
    if (!parameter.required) continue;
    const present = [parameter.name, ...(aliases[parameter.name] ?? [])].find((n) => isPresent(normalized[n]));
    if (present === undefined) {
      return {
        args: normalized,
        error: describeArgumentError(definition, normalized, { argument: parameter.name, kind: "missing" }, options),
      };
    }
  }
  return { args: normalized, error: null };
}
