/**
 * 工程执行门面：把「连接软件」与「跑 Python」串成一条可用的链路。
 *
 * 这是 Agent 实际调用的入口。它承担三件事：
 *   1. 连接目标软件并拿到函数清单
 *   2. 生成注入桩，与用户脚本拼在一起交给 Python 执行
 *   3. 把执行结果原样返回（只有 print 的内容是给用户看的）
 *
 * 设计边界：本模块不做业务判断，也不替用户修改脚本。
 */

import type { ConnectResult, DiscoveryOverrides } from "../mcp-link/types.js";
import {
  getActiveLink,
  connectToServer,
  getConnectedServers,
  isServerConnected,
  setEngineeringPortResolver,
} from "../mcp-link/registry.js";
import type { EngineeringPortResolver } from "../mcp-link/registry.js";
import type { GeneratedFunction } from "../mcp-link/injection.js";
import type { FunctionSearchAction } from "../mcp-link/function-search.js";
import { PythonWorkerPool } from "./python-pool.js";
import {
  renderEngineeringHelpers,
  renderInjectionPreamble,
  renderInjectionStubs,
} from "./inject-stubs.js";
import type { PythonRunResult } from "./types.js";
import { bridgeDirName, renderHostBridge, startHostBridge } from "./host-bridge.js";
import type { McpSession } from "../mcp-link/session.js";
import type { FunctionSearchRequest, FunctionSearchResult } from "../mcp-link/function-search.js";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

export interface EngineeringRunRequest {
  /** 目标软件的 server name，如 `bimbase`。 */
  server: string;
  /** 用户（或模型）写的 Python 脚本。 */
  code: string;
  /** 连接参数。 */
  connect?: DiscoveryOverrides;
  /** 执行通道 key，缺省取 server 名。 */
  key?: string;
  /** 超时（毫秒）。 */
  timeoutMs?: number;
}

export interface EngineeringRunResult {
  ok: boolean;
  /** 脚本 print 出来的内容。 */
  stdout: string;
  /** 失败原因；ok 为 true 时为空串。 */
  error: string;
  /** 本次注入的函数名，便于向用户说明「你能用什么」。 */
  injectedFunctions: string[];
  durationMs: number;
}

/**
 * 连接目标软件并执行一段脚本。
 *
 * 失败路径全部转成结果结构，不抛异常：Agent 需要把原因转述给用户，
 * 未捕获异常会中断整轮对话。
 */
export class EngineeringExecutor {
  private readonly pool: PythonWorkerPool;

  constructor(options: { interpreter?: string; workDir?: string; env?: Record<string, string> } = {}) {
    this.pool = new PythonWorkerPool({
      interpreter: options.interpreter,
      workDir: options.workDir,
      env: options.env,
    });
  }

  /** 连接目标软件。已连接时幂等。 */
  async connect(server: string, options: DiscoveryOverrides = {}): Promise<ConnectResult> {
    return connectToServer(server, options);
  }

  /**
   * 注入 MCP 端口解析器。
   *
   * MCP 系软件（bimbase / pkpmmcp）不在 HTTP 默认端口上，端口来源随厂商
   * 版本而异，本仓库无法在无实机时确定。宿主在实机验证出规则后通过本方法
   * 注入即可连接；未注入时连接会明确报「未取得端口」而不是静默失败。
   */
  setPortResolver(resolver: EngineeringPortResolver | undefined): void {
    setEngineeringPortResolver(resolver);
  }

  /** 取已注入的函数签名；未连接返回空数组。 */
  functions(server: string): GeneratedFunction[] {
    return getActiveLink(server)?.functionSignatures() ?? [];
  }

  /** 取连接简报；未连接返回空串。 */
  briefing(server: string): string {
    return getActiveLink(server)?.briefing() ?? "";
  }

  /** 检索已连接软件的函数；未连接时返回带指引的失败结果。 */
  searchFunctions(server: string, request: FunctionSearchRequest): FunctionSearchResult {
    const link = getActiveLink(server);
    if (!link) {
      return { ok: false, text: `尚未连接 ${server}，请先调用 connect。` };
    }
    return link.searchFunctions(request);
  }

  /**
   * 连接并在注入环境下执行脚本。
   *
   * 注入块放在用户脚本之前：同名函数后定义覆盖先定义，所以用户代码优先。
   */
  async run(request: EngineeringRunRequest): Promise<EngineeringRunResult> {
    const connected = await this.connect(request.server, request.connect ?? {});
    if (connected !== true) {
      return {
        ok: false,
        stdout: "",
        error: connected,
        injectedFunctions: [],
        durationMs: 0,
      };
    }

    const functions = this.functions(request.server);
    const preamble = renderInjectionPreamble(functions);
    const stubs = renderInjectionStubs(functions);
    // 辅助函数（connect_to_server / function_search / is_server_connected）是
    // 技能正文直接调用的入口，但它们是普通函数、不在 tools/list 里，必须单独注入。
    const helpers = renderEngineeringHelpers(request.server);

    // MCP 系（BIMBase/PKPM）有会话，COM 系（AutoCAD/SAP2000…）没有。
    const link = getActiveLink(request.server) as
      | { currentSession?: () => McpSession | undefined }
      | undefined;
    const session: McpSession | undefined = link?.currentSession?.();

    // 宿主桥始终装配：辅助函数（connect_to_server / function_search 等）
    // 走 registry，不依赖 MCP 会话；COM 系软件没有会话，但同样需要这些函数。
    // 只有注入桩的函数体（mcp_tool）才需要会话，无会话时给出明确错误而不是 NameError。
    const bridgeDir = bridgeDirName(tmpdir(), request.key ?? request.server);
    await mkdir(bridgeDir, { recursive: true }).catch(() => undefined);
    const bridgeCode = renderHostBridge(bridgeDir);
    const stopBridge = startHostBridge(bridgeDir, {
      mcpTool: async (name, args) => {
        if (!session) {
          throw new Error(
            `${request.server} 没有 MCP 会话（COM 系软件）。` +
              "请用技能脚本里的 COM 调用（如 win32com Dispatch），不要直接调用注入函数。",
          );
        }
        return session.callTool(name, args);
      },
      engineering: (op, payload) => this.handleEngineeringOp(op, payload),
    });

    const composed = [bridgeCode, preamble, helpers, stubs, request.code]
      .filter(Boolean)
      .join("\n\n");

    let result: PythonRunResult;
    try {
      result = await this.pool.run({
        code: composed,
        key: request.key ?? request.server,
        timeoutMs: request.timeoutMs,
      });
    } finally {
      stopBridge();
      await rm(bridgeDir, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      ok: result.ok,
      stdout: result.stdout,
      error: result.error,
      injectedFunctions: functions.map((fn) => fn.name),
      durationMs: result.durationMs,
    };
  }

  /** 中断指定通道上正在跑的任务。 */
  interrupt(key: string): void {
    this.pool.killWorker(key);
  }

  /**
   * 响应 Python 侧发起的工程环境操作。
   *
   * 对应注入的辅助函数：`connect_to_server` / `is_server_connected` /
   * `list_connected_servers` / `function_search`。这些不是 MCP 工具，
   * 所以由宿主直接分发到 registry 与 function-search。
   *
   * 失败一律转成可读错误文案：Python 侧会把它作为 RuntimeError 抛出，
   * 让脚本作者看到原因而不是静默拿到 None。
   */
  private async handleEngineeringOp(
    op: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const readString = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;

    switch (op) {
      case "connect": {
        const server = readString(payload.server);
        if (!server) throw new Error("connect 需要 server 参数。");
        const result = await connectToServer(server, {
          workDir: readString(payload.workDir),
          projectPath: readString(payload.cmdArgs),
        });
        // ConnectResult 是 true | string；字符串即错误原因。
        if (result !== true) throw new Error(result);
        return true;
      }

      case "is_connected": {
        const server = readString(payload.server);
        if (!server) throw new Error("is_connected 需要 server 参数。");
        return isServerConnected(server);
      }

      case "list_connected": {
        return getConnectedServers();
      }

      case "function_search": {
        const server = readString(payload.server);
        if (!server) throw new Error("function_search 需要 server 参数。");
        const action = readString(payload.action) as FunctionSearchAction | undefined;
        if (!action) {
          throw new Error("function_search 需要 action（GetType / GetName / GetDescription / GetClass）。");
        }
        const result = this.searchFunctions(server, {
          action,
          funcType: readString(payload.funcType),
          funcNames: Array.isArray(payload.funcNames)
            ? payload.funcNames.filter((item): item is string => typeof item === "string")
            : undefined,
        });
        if (!result.ok) throw new Error(result.text);
        return result.text;
      }

      default:
        throw new Error(`未知的工程操作：${op}`);
    }
  }

  /** 释放全部通道与临时资源。 */
  async dispose(): Promise<void> {
    await this.pool.dispose();
  }
}
