/**
 * 桌面软件（COM / .NET / 本地 HTTP / Ruby 插件 / 自带 Python）的通用连接基类。
 *
 * 与 MCP 系的差别：这些软件不提供 MCP over HTTP 端点，Agent 的调用要经由
 * Python 侧的桥接完成，所以这里不建立 Node 侧会话，而是：
 *   1. 发现并确保目标进程在运行
 *   2. 把「连接参数」交给 Python 执行器（由技能脚本自己建立桥接）
 *   3. 能力清单来自本地编译的 API 库，不是运行时 tools/list
 *
 * 这样设计的原因（逆向自各软件技能）：
 *   - Rhino 明确禁止直接 Dispatch("Rhino.Interface")，必须走封装层处理
 *     版本探测与 typelib；封装在 Python 侧更自然。
 *   - Excel 需要按路径锁定工作簿，不能依赖 ActiveWorkbook，同样在 Python 侧。
 *   - Tekla 走 .NET 程序集、SketchUp 走内嵌 Ruby 插件、MIDAS 走本地 HTTP +
 *     MAPI-Key，都不是 COM；这些差异同样只在 Python 侧才有意义。
 */

import { existsSync } from "node:fs";

import { BaseMCPLink } from "../base.js";
import type { DiscoveryOverrides, InjectionResult } from "../types.js";
import type { McpToolDescriptor } from "../injection.js";
import { resolveExecutable, type CandidateRoot } from "../discovery.js";
import { loadApiCatalogTools, type ApiCatalogSpec } from "../api-catalog.js";
import { isComProgIdRegistered, resolveComProgIdExe } from "../win-registry.js";

export interface ComLinkOptions {
  serverName: string;
  /** 产品显示名，用于错误文案。 */
  productName: string;
  /** 启动器文件名。 */
  exeName: string;
  /** 安装根特征路径。 */
  featurePaths: string[];
  /** 环境变量名。 */
  exeEnvVars?: string[];
  rootEnvVars?: string[];
  /** 注册表候选安装根提供者；不提供时候选根只剩环境变量与上次成功路径。 */
  registryRoots?: () => Promise<CandidateRoot[]>;
  /** COM ProgID：注册表已注册时视为可连接，不强制先定位 exe。 */
  progId?: string;
  /** 本地 API 目录的定位参数。 */
  catalog: ApiCatalogSpec;
  /** 平台限制：仅 Windows 可用的子类返回 false 时给出明确提示。 */
  windowsOnly?: boolean;
  /** 桥接方式的中文名（COM / .NET / 本地 HTTP API / Ruby 插件 / 自带 Python），用于提示文案。 */
  bridgeLabel?: string;
  /** 已知限制或使用前提，连接后写进简报。 */
  note?: string;
}

/**
 * 桌面软件连接。不建立 MCP 会话；握手阶段改为「确认进程可用 + 载入 API 目录」。
 */
export class ComSoftwareLink extends BaseMCPLink {
  private readonly options: ComLinkOptions;

  constructor(options: ComLinkOptions, host?: string) {
    super({ serverName: options.serverName, host });
    this.options = options;
  }

  /** 桥接方式；未指定时按 COM 处理。 */
  private get bridge(): string {
    return this.options.bridgeLabel ?? "COM";
  }

  protected async startMcpServer(options: DiscoveryOverrides): Promise<number | true | string> {
    if (this.options.windowsOnly && process.platform !== "win32") {
      return `${this.options.productName} 的${this.bridge}接口仅在 Windows 上可用。`;
    }

    // 1. 安装位置发现：显式路径 > 环境变量 > 上次成功路径 > 注册表候选根。
    const resolved = await resolveExecutable(options, {
      productName: this.options.productName,
      exeName: this.options.exeName,
      featurePaths: this.options.featurePaths,
      exeEnvVars: this.options.exeEnvVars,
      rootEnvVars: this.options.rootEnvVars,
      registryRoots: this.options.registryRoots,
      verifiedPath: () => this.verifiedExePath,
    });

    if (resolved) {
      // 桌面软件不需要等端口：进程在运行即可由 Python 侧建立桥接。
      // 这里只校验可执行文件存在，避免把「装了但没启动」误判成可连接。
      if (!existsSync(resolved.path)) {
        return `${this.options.productName} 的可执行文件不存在：${resolved.path}`;
      }
      this.verifiedExePath = resolved.path;
      // 返回 true 表示无需端口等待；握手阶段直接载入 API 目录。
      return true;
    }

    // 2. 注册表兜底：featurePaths 为空时候选根恒为空，自动发现必然失败。
    //    但 COM 软件只要 ProgID 已注册，Python 侧 Dispatch 就能拉起进程，
    //    不必先定位 exe。Office 兼容层（WPS）走 InprocServer32，本就没有 exe。
    if (this.options.progId) {
      const registered = await isComProgIdRegistered(this.options.progId);
      if (registered) {
        // exe 仅用于诊断展示，取不到不影响连接。
        this.verifiedExePath = await resolveComProgIdExe(this.options.progId);
        return true;
      }
    }

    const envHint = this.options.exeEnvVars?.length
      ? `，或设置环境变量 ${this.options.exeEnvVars.join(" / ")}`
      : "";
    return (
      `未能自动定位 ${this.options.productName}。请先启动软件，` +
      `或在连接时传入 exePath${envHint}。`
    );
  }

  protected async connectMcp(_timeoutMs: number): Promise<InjectionResult | string> {
    // 这类软件没有运行时 tools/list，能力来自本地 API 目录。
    // 目录缺失不算连接失败：脚本仍可自行建立桥接，只是 function_search
    // 查不到函数清单。这里把这件事说清楚。
    const tools: McpToolDescriptor[] = await loadApiCatalogTools(this.options.catalog);
    if (tools.length === 0) {
      const result = this.prepareInjection(this.serverName, []);
      return {
        ...result,
        briefing:
          `已连接 ${this.options.productName}（${this.bridge}）。\n` +
          "未找到本地 API 目录，function_search 查不到函数清单。\n" +
          `请参照技能正文用 ${this.bridge} 方式调用 ${this.options.productName}。` +
          (this.options.note ? `\n注意：${this.options.note}` : ""),
      };
    }
    const result = this.prepareInjection(this.serverName, tools);
    return this.options.note
      ? { ...result, briefing: `${result.briefing}\n注意：${this.options.note}` }
      : result;
  }

  disconnect(): void {
    this.verifiedExePath = undefined;
  }

  /** 供诊断：当前解析到的可执行文件。 */
  resolvedExecutable(): string | undefined {
    return this.verifiedExePath;
  }
}

export type { CandidateRoot };
