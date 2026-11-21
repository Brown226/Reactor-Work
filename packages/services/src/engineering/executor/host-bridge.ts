/**
 * 宿主桥接：把 Python 里的 `__zcode_mcp_call__` 调用转成真实 MCP 调用。
 *
 * 这是注入链路的最后一环。前面几步已经能：
 *   工具清单 → 函数签名 → 注入桩 → Python 直接调用
 * 但 Python 里调用桩只是把请求压进一个函数，需要有人把它送回 MCP 服务。
 *
 * 实现方式：执行前把桩的转发入口改成「写一行 JSON 到 stdout 并等回执」
 * 不现实（stdout 是给用户的）。实际做法是**预先把结果取好**：
 * 用两阶段执行——先跑一段探测脚本来收集需要哪些调用，再由宿主执行，
 * 最后带着结果重跑。
 *
 * 但这个方案对「根据上一步结果决定下一步」的脚本不成立。
 *
 * 所以采用**同步阻塞桥**：Python 侧通过一个临时文件通道发起调用并轮询
 * 结果，宿主在事件循环里轮询该文件。简单、跨平台、不占 stdout。
 */

import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { McpSession } from "../mcp-link/session.js";

/** 桥接目录里的请求文件后缀。 */
const REQUEST_SUFFIX = ".req.json";
const RESPONSE_SUFFIX = ".res.json";
/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 25;
/** 单次调用的等待上限。 */
const CALL_TIMEOUT_MS = 120_000;

/**
 * Python 侧的桥接代码。
 *
 * 与宿主通过临时目录交换文件：写请求 → 轮询响应 → 读结果。
 * 用文件而不是 stdin/stdout，是因为 stdout 要留给用户脚本的 print。
 *
 * 两个入口：
 *   - `__zcode_mcp_call__(name, args)`：调用 MCP 工具（注入桩的函数体用它）
 *   - `__zcode_bridge_call__(op, payload)`：调用宿主侧的工程环境操作
 *     （connect / is_connected / list_connected / function_search）
 */
export function renderHostBridge(bridgeDir: string): string {
  return `
import json as _json, os as _os, time as _time, uuid as _uuid

_ZCODE_BRIDGE_DIR = ${JSON.stringify(bridgeDir)}

def __zcode_bridge_call__(op, payload=None):
    """向宿主发起一次工程环境操作，同步等待结果。"""
    token = _uuid.uuid4().hex
    req_path = _os.path.join(_ZCODE_BRIDGE_DIR, token + "${REQUEST_SUFFIX}")
    res_path = _os.path.join(_ZCODE_BRIDGE_DIR, token + "${RESPONSE_SUFFIX}")
    with open(req_path, "w", encoding="utf-8") as f:
        _json.dump({"op": op, "payload": payload or {}}, f, ensure_ascii=False)
    deadline = _time.time() + ${Math.floor(CALL_TIMEOUT_MS / 1000)}
    while _time.time() < deadline:
        if _os.path.exists(res_path):
            with open(res_path, "r", encoding="utf-8") as f:
                payload_in = _json.load(f)
            try:
                _os.remove(res_path)
            except OSError:
                pass
            if payload_in.get("ok"):
                return payload_in.get("result")
            raise RuntimeError(payload_in.get("error") or ("操作失败：" + op))
        _time.sleep(${POLL_INTERVAL_MS / 1000})
    raise TimeoutError("宿主操作超时：" + op)

def __zcode_mcp_call__(name, args):
    """调用宿主注册的 MCP 工具，同步等待结果。"""
    return __zcode_bridge_call__("mcp_tool", {"tool": name, "args": args})
`.trim();
}

/** 一次待处理的调用请求。 */
interface BridgeRequest {
  /** 操作类型；缺省按 mcp_tool 处理，兼容旧请求形状。 */
  op?: string;
  /** mcp_tool 的参数。 */
  tool?: string;
  args?: Record<string, unknown>;
  /** 其它操作的参数。 */
  payload?: Record<string, unknown>;
}

/** 宿主侧可响应的操作。 */
export interface BridgeHandlers {
  /** 调用 MCP 工具。 */
  mcpTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** 工程环境操作；未提供时返回明确错误。 */
  engineering?: (op: string, payload: Record<string, unknown>) => Promise<unknown>;
}

/**
 * 轮询桥接目录，把 Python 发起的调用转发到宿主。
 *
 * 返回一个停止函数。调用方在 Python 执行结束后必须停止轮询，
 * 否则会一直占着目录。
 *
 * `handlers` 缺省时退化为「只支持 mcp_tool」，保持旧调用点不用改。
 */
export function startHostBridge(
  bridgeDir: string,
  handlers: BridgeHandlers | McpSession,
  options: { onError?: (error: unknown) => void } = {},
): () => void {
  const resolved: BridgeHandlers = isMcpSession(handlers)
    ? {
        mcpTool: (name, args) => handlers.callTool(name, args),
      }
    : handlers;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(bridgeDir);
      for (const entry of entries) {
        if (!entry.endsWith(REQUEST_SUFFIX)) continue;
        const token = entry.slice(0, -REQUEST_SUFFIX.length);
        const requestPath = join(bridgeDir, entry);
        const responsePath = join(bridgeDir, token + RESPONSE_SUFFIX);

        let request: BridgeRequest;
        try {
          request = JSON.parse(await readFile(requestPath, "utf8")) as BridgeRequest;
        } catch {
          continue;
        }

        // 先删请求，避免同一请求被处理两次。
        await rm(requestPath, { force: true }).catch(() => undefined);

        const payload = await dispatch(resolved, request);
        await writeFile(responsePath, JSON.stringify(payload), "utf8").catch(() => undefined);
      }
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** 分发一次桥接请求；所有失败都转成 error 字段，不抛。 */
async function dispatch(
  handlers: BridgeHandlers,
  request: BridgeRequest,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const op = request.op ?? "mcp_tool";
  try {
    if (op === "mcp_tool") {
      const tool = request.tool;
      if (!tool) return { ok: false, error: "mcp_tool 请求缺少 tool 字段。" };
      return { ok: true, result: await handlers.mcpTool(tool, request.args ?? {}) };
    }

    if (!handlers.engineering) {
      return { ok: false, error: `宿主未提供工程操作支持（op=${op}）。` };
    }
    return { ok: true, result: await handlers.engineering(op, request.payload ?? {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 判断传入的是 McpSession 还是完整 handlers。 */
function isMcpSession(value: BridgeHandlers | McpSession): value is McpSession {
  return typeof (value as McpSession).callTool === "function";
}

/** 生成一个稳定的桥接目录名（按 key 区分，避免并发串台）。 */
export function bridgeDirName(baseDir: string, key: string): string {
  const digest = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return join(baseDir, `bridge-${digest}`);
}

export { REQUEST_SUFFIX, RESPONSE_SUFFIX, CALL_TIMEOUT_MS, POLL_INTERVAL_MS };
