/**
 * MCP 连接抽象基类。
 *
 * 逆向自 PKPM Agent 的 BaseMCPLink：子类只实现「怎么启动目标软件 + MCP 服务」，
 * 「等端口」「握手」「状态维护」由基类统一处理。
 * connect 流程固定为三段，顺序不可颠倒：启动 → 等端口 → 握手。
 */

import type { ConnectResult, DiscoveryOverrides, InjectionResult } from "./types.js";
import { waitForPort } from "./common.js";
import { buildBriefing } from "./briefing.js";
import type { ConversionResult, GeneratedFunction, McpToolDescriptor } from "./injection.js";
import { convertTools, toCapabilitySnapshot } from "./injection.js";
import { functionSearch, type FunctionSearchRequest, type FunctionSearchResult } from "./function-search.js";

/** 等端口就绪的上限，与逆向样保持一致（100 秒，足够 CAD 类软件冷启动）。 */
const MCP_READY_TIMEOUT_MS = 100_000;
/** MCP 握手超时。 */
const HANDSHAKE_TIMEOUT_MS = 30_000;

export interface BaseMCPLinkOptions {
  /** MCP 服务名，同时作为 registry 的 key。 */
  serverName: string;
  /** MCP 服务监听地址，默认本机。 */
  host?: string;
}

export abstract class BaseMCPLink {
  protected readonly serverName: string;
  protected readonly host: string;
  protected port?: number;
  protected connected = false;
  /** 上次成功连接的可执行文件路径，仅本进程内有效，不写盘。 */
  protected verifiedExePath?: string;

  protected constructor(options: BaseMCPLinkOptions) {
    this.serverName = options.serverName;
    this.host = options.host ?? "127.0.0.1";
  }

  /**
   * 子类实现：定位并启动目标软件与其 MCP 服务。
   *
   * 返回数字表示已就绪的 MCP 端口；返回 `true` 表示端口已由子类写入 `this.port`；
   * 返回字符串表示失败原因，调用方转告用户，不再重试。
   */
  protected abstract startMcpServer(
    options: DiscoveryOverrides,
  ): Promise<number | true | string>;

  /** 子类实现：完成 MCP 握手并拉取能力快照。 */
  protected abstract connectMcp(timeoutMs: number): Promise<InjectionResult | string>;

  /** 断开连接，释放子类持有的资源。 */
  abstract disconnect(): void;

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 连接入口。幂等：已连接时直接返回成功。
   */
  async connect(options: DiscoveryOverrides = {}): Promise<ConnectResult> {
    if (this.connected) return true;

    const started = await this.startMcpServer(options);
    if (typeof started === "string") return started;

    // COM 系软件（AutoCAD/SAP2000/ETABS/Rhino）不提供 HTTP 端点，
    // startMcpServer 以 `true` 表示「无需端口等待」，能力改由本地 API 目录提供。
    // 原实现只处理 number/string，`true` 会被当成「端口未取到」直接失败，
    // 导致 COM 系软件在进程已确认可用的前提下仍报「未能确定 MCP 服务端口」。
    if (started !== true) {
      this.port = started;

      if (this.port === undefined) {
        return "已启动目标软件，但未能确定 MCP 服务端口";
      }

      try {
        await waitForPort(this.port, MCP_READY_TIMEOUT_MS, this.host);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    const handshake = await this.connectMcp(HANDSHAKE_TIMEOUT_MS);
    if (typeof handshake === "string") return handshake;

    this.connected = true;
    this.lastInjection = handshake;
    return true;
  }

  /** 最近一次握手注入的结果，供上层取简报与能力快照。 */
  protected lastInjection?: InjectionResult;
  /** 转换后的函数签名，供 function_search 使用。 */
  protected generatedFunctions: GeneratedFunction[] = [];

  /**
   * 由子类在握手拿到 tools/list 后调用：完成 Schema → 签名的转换、
   * 生成简报与能力快照。返回可交给执行器落地的注入结果。
   */
  protected prepareInjection(serverName: string, tools: McpToolDescriptor[]): InjectionResult {
    const conversion: ConversionResult = convertTools(tools);
    this.generatedFunctions = conversion.functions;
    const snapshot = toCapabilitySnapshot(serverName, conversion);
    const briefing = buildBriefing(snapshot);
    const result: InjectionResult = {
      injectedFunctions: conversion.functions.map((fn) => fn.name),
      injectedClasses: Object.keys(conversion.dataStructures),
      briefing,
      snapshot,
    };
    this.lastInjection = result;
    return result;
  }

  /** 取转换后的函数签名列表（含参数与返回类型），供执行器生成调用桩。 */
  functionSignatures(): GeneratedFunction[] {
    return this.generatedFunctions;
  }

  /**
   * 执行一次 function_search。未连接时返回失败结果而不是抛异常，
   * 让模型能自己判断下一步。
   */
  searchFunctions(request: FunctionSearchRequest): FunctionSearchResult {
    const snapshot = this.lastInjection?.snapshot;
    if (!snapshot) {
      return { ok: false, text: `尚未连接 ${this.serverName}，请先调用 connect。` };
    }
    return functionSearch(request, { snapshot, functions: this.generatedFunctions });
  }

  /** 取最近一次握手的能力快照。未连接时返回 undefined。 */
  capabilitySnapshot(): InjectionResult["snapshot"] | undefined {
    return this.lastInjection?.snapshot;
  }

  /** 取连接简报文本。未连接时返回空串。 */
  briefing(): string {
    return this.lastInjection?.briefing ?? "";
  }
}
