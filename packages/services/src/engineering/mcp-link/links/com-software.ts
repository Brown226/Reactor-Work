/**
 * COM 系软件（SAP2000 / ETABS / AutoCAD / Rhino）的通用连接基类。
 *
 * 与 MCP 系的差别：COM 软件通常不提供 HTTP 端点，Agent 的调用要经由
 * Python 的 COM 绑定完成，所以这里不建立 Node 侧会话，而是：
 *   1. 发现并确保目标进程在运行
 *   2. 把「连接参数」交给 Python 执行器（由技能脚本自己 Dispatch）
 *   3. 能力清单来自本地编译的 API 库，不是运行时 tools/list
 *
 * 这样设计的原因（逆向自各软件技能）：
 *   - Rhino 明确禁止直接 Dispatch("Rhino.Interface")，必须走封装层处理
 *     版本探测与 typelib；封装在 Python 侧更自然。
 *   - Excel 需要按路径锁定工作簿，不能依赖 ActiveWorkbook，同样在 Python 侧。
 */

import { existsSync } from "node:fs";

import { BaseMCPLink } from "../base.js";
import type { DiscoveryOverrides, InjectionResult } from "../types.js";
import type { McpToolDescriptor } from "../injection.js";
import { resolveExecutable, type CandidateRoot } from "../discovery.js";
import { loadApiCatalogTools, type ApiCatalogSpec } from "../api-catalog.js";

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
  /** 本地 API 目录的定位参数。 */
  catalog: ApiCatalogSpec;
  /** 平台限制：仅 Windows 可用的子类返回 false 时给出明确提示。 */
  windowsOnly?: boolean;
}

/**
 * COM 系连接。不建立 HTTP 会话；握手阶段改为「确认进程可用 + 载入 API 目录」。
 */
export class ComSoftwareLink extends BaseMCPLink {
  private readonly options: ComLinkOptions;

  constructor(options: ComLinkOptions, host?: string) {
    super({ serverName: options.serverName, host });
    this.options = options;
  }

  protected async startMcpServer(_options: DiscoveryOverrides): Promise<number | true | string> {
    if (this.options.windowsOnly && process.platform !== "win32") {
      return `${this.options.productName} 的 COM 接口仅在 Windows 上可用。`;
    }

    const resolved = await resolveExecutable(_options, {
      productName: this.options.productName,
      exeName: this.options.exeName,
      featurePaths: this.options.featurePaths,
      exeEnvVars: this.options.exeEnvVars,
      rootEnvVars: this.options.rootEnvVars,
      verifiedPath: () => this.verifiedExePath,
    });

    if (!resolved) {
      return (
        `未能自动定位 ${this.options.productName}。请先启动软件，` +
        `或在连接时传入 exePath。`
      );
    }

    // COM 系不需要等端口：进程在运行即可由 Python 侧 Dispatch。
    // 这里只校验可执行文件存在，避免把「装了但没启动」误判成可连接。
    if (!existsSync(resolved.path)) {
      return `${this.options.productName} 的可执行文件不存在：${resolved.path}`;
    }

    this.verifiedExePath = resolved.path;
    // 返回 true 表示无需端口等待；握手阶段直接载入 API 目录。
    return true;
  }

  protected async connectMcp(_timeoutMs: number): Promise<InjectionResult | string> {
    // COM 系没有运行时 tools/list，能力来自本地 API 目录。
    // 目录缺失不算连接失败：脚本仍可用 win32com 直接 Dispatch，
    // 只是 function_search 查不到函数清单。这里把这件事说清楚。
    const tools: McpToolDescriptor[] = await loadApiCatalogTools(this.options.catalog);
    if (tools.length === 0) {
      const result = this.prepareInjection(this.serverName, []);
      return {
        ...result,
        briefing:
          `已连接 ${this.options.productName}（COM）。\n` +
          "未找到本地 API 目录，function_search 查不到函数清单。\n" +
          `脚本里可直接用 win32com.client.Dispatch 调用 ${this.options.productName} 的 COM 接口。`,
      };
    }
    return this.prepareInjection(this.serverName, tools);
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
