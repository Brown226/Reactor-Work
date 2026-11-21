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
import { getActiveLink, connectToServer } from "../mcp-link/registry.js";
import type { GeneratedFunction } from "../mcp-link/injection.js";
import { PythonWorkerPool } from "./python-pool.js";
import { renderInjectionPreamble, renderInjectionStubs } from "./inject-stubs.js";
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

    // 有 MCP 会话时装配宿主桥，让 Python 里的调用能真的回到软件。
    // 没有会话（COM 系）时桩会抛错——这是对的：COM 调用由技能脚本自己
    // Dispatch，不走这条桩路径。
    const link = getActiveLink(request.server) as
      | { currentSession?: () => McpSession | undefined }
      | undefined;
    const session: McpSession | undefined = link?.currentSession?.();

    let bridgeCode = "";
    let stopBridge: (() => void) | undefined;
    let bridgeDir: string | undefined;

    if (session) {
      bridgeDir = bridgeDirName(tmpdir(), request.key ?? request.server);
      await mkdir(bridgeDir, { recursive: true }).catch(() => undefined);
      bridgeCode = renderHostBridge(bridgeDir);
      stopBridge = startHostBridge(bridgeDir, session);
    }

    const composed = [bridgeCode, preamble, stubs, request.code].filter(Boolean).join("\n\n");

    let result: PythonRunResult;
    try {
      result = await this.pool.run({
        code: composed,
        key: request.key ?? request.server,
        timeoutMs: request.timeoutMs,
      });
    } finally {
      stopBridge?.();
      if (bridgeDir) await rm(bridgeDir, { recursive: true, force: true }).catch(() => undefined);
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

  /** 释放全部通道与临时资源。 */
  async dispose(): Promise<void> {
    await this.pool.dispose();
  }
}
