/**
 * 把注入的函数签名生成为 Python 调用桩。
 *
 * 逆向自 PKPM Agent 的 mcp_ptc 注入机制：
 *   连接成功后，MCP 工具被注入为执行环境里的普通函数，
 *   脚本里直接调用即可，不需要 import。
 *
 * 本模块只生成「调用桩代码」；真正把调用发回 MCP 服务的传输由宿主提供，
 * 函数体统一转发到宿主暴露的 `__zcode_mcp_call__`。
 */

import type { GeneratedFunction } from "../mcp-link/injection.js";

/** 宿主注入到 Python 环境里的转发入口名。 */
const HOST_CALL_ENTRY = "__zcode_mcp_call__";

/** Python 关键字，不能作为参数名。 */
const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
  "try", "while", "with", "yield",
]);

/** 把参数名规范成合法 Python 标识符。不合法时加前缀，不丢弃参数。 */
function safeParamName(name: string): string {
  let safe = name.replace(/[^0-9a-zA-Z_]/g, "_");
  if (!/^[a-zA-Z_]/.test(safe)) safe = `p_${safe}`;
  if (PYTHON_KEYWORDS.has(safe)) safe = `${safe}_`;
  return safe;
}

/** 生成单个函数的 Python 桩。 */
function renderFunction(fn: GeneratedFunction): string {
  // Python 不允许必填参数排在可选参数之后，按必填性稳定重排。
  const requiredNames = fn.parameters.filter((p) => p.required).map((p) => safeParamName(p.name));
  const optionalNames = fn.parameters.filter((p) => !p.required).map((p) => safeParamName(p.name));
  const ordered = [...requiredNames, ...optionalNames];
  const signature = ordered
    .map((name) => (optionalNames.includes(name) ? `${name}=None` : name))
    .join(", ");

  const body =
    `    return ${HOST_CALL_ENTRY}(${JSON.stringify(fn.name)}, {` +
    `${ordered.map((name) => `${JSON.stringify(name)}: ${name}`).join(", ")}})`;

  const doc = fn.summary ? `    """${fn.summary.replace(/"""/g, '\\"\\"\\"')}"""` : "";
  const lines = [`def ${fn.name}(${signature}):`];
  if (doc) lines.push(doc);
  lines.push(body);
  lines.push("");
  return lines.join("\n");
}

/**
 * 生成完整的注入代码块。
 *
 * 返回的代码可以直接和用户脚本拼在一起执行；同名函数后定义覆盖先定义，
 * 所以注入块应放在用户代码之前。
 */
export function renderInjectionStubs(
  functions: GeneratedFunction[],
  options: { header?: string } = {},
): string {
  if (functions.length === 0) return "";
  const header =
    options.header ??
    "# ── 已注入的工程软件函数（直接调用，不要 import）───────────────";
  const body = functions.map(renderFunction).join("\n");
  return `${header}\n${body}`;
}

/**
 * 生成调用桩，同时把每个函数的参数映射表暴露出来，
 * 供宿主在收到调用时把 Python 位置参数还原成 MCP 入参名。
 */
export function renderInjectionPreamble(functions: GeneratedFunction[]): string {
  const mapping: Record<string, string[]> = {};
  for (const fn of functions) {
    mapping[fn.name] = fn.parameters.map((p) => safeParamName(p.name));
  }
  return [
    "# 参数映射：函数名 → 参数名顺序",
    `__zcode_mcp_signatures__ = ${JSON.stringify(mapping)}`,
    "",
  ].join("\n");
}

/**
 * 生成工程环境的辅助函数块：`connect_to_server` / `is_server_connected` /
 * `function_search`。
 *
 * 这三个是技能正文里直接调用的入口，但它们是**普通函数**，不是 MCP 工具，
 * 所以不会出现在 tools/list 里，必须由宿主注入。此前只有 MCP 工具桩被注入，
 * `PKPM-Link/SKILL.md` 第一步的 `connect_to_server("pkpmmcp")` 和
 * `function_search(...)` 在脚本里都是 NameError。
 *
 * 实现走宿主桥：`__zcode_bridge_call__(op, payload)` 由宿主按 op 分发到
 * registry / function-search，Python 侧只做参数整形与结果美化。
 *
 * @param serverName 当前连接的 server，作为 connect_to_server 的缺省目标
 */
export function renderEngineeringHelpers(serverName: string): string {
  return `
# ── 工程环境辅助函数（直接调用，不要 import）─────────────────────
_DEFAULT_SERVER = ${JSON.stringify(serverName)}

def connect_to_server(name=None, work_dir=None, cmd_args=None):
    """连接工程软件。返回 True 表示成功，返回字符串表示错误原因。"""
    target = name or _DEFAULT_SERVER
    return __zcode_bridge_call__("connect", {
        "server": target,
        "workDir": work_dir,
        "cmdArgs": cmd_args,
    })

def is_server_connected(name=None):
    """判断指定软件当前是否已连接。"""
    return __zcode_bridge_call__("is_connected", {"server": name or _DEFAULT_SERVER})

def list_connected_servers():
    """列出当前已连接的软件。"""
    return __zcode_bridge_call__("list_connected", {})

def function_search(action, func_type=None, func_names=None):
    """检索已连接软件的函数。action: GetType / GetName / GetDescription / GetClass。"""
    return __zcode_bridge_call__("function_search", {
        "server": _DEFAULT_SERVER,
        "action": action,
        "funcType": func_type,
        "funcNames": func_names,
    })
`.trim();
}

export { HOST_CALL_ENTRY, safeParamName };
