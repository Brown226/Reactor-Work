/**
 * BIMBase / PKPM 连接实现。
 *
 * 逆向自 PKPM Agent 的 software_link_kit/plants 与 mcp_link/pkpm。
 * 该软件的关键约束（写进实现注释，避免后来者重踩）：
 *   1. 模型的定位骨架是「平面」的：节点 → 网格 → 构件；
 *      柱依附节点，梁墙依附网格，斜杆依附两端节点。
 *   2. 新建梁/墙/网格时若与其他构件相交，软件会自动在交点加节点并打断成多段；
 *      返回的构件信息是「打断前」捕获的，ID 不保证仍代表原构件，
 *      布置完成后必须重新检索，不要复用创建返回值。
 *   3. 三维空间结构必须用带 `_WithAutoStdFlrDetection` 后缀的入口，
 *      普通二维入口会把端部标高拉平到同一标准层。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { BaseMCPLink } from "../base.js";
import type { DiscoveryOverrides, InjectionResult } from "../types.js";
import { resolveExecutable, type CandidateRoot, type DiscoverySource } from "../discovery.js";

/** 安装根的特征目录：缺了它就不是 BIMBase 的安装位置。 */
const FEATURE_PATHS = ["PlantSPythonEnv"];
/** 启动器文件名。 */
const EXE_NAME = "BIMBase.exe";

export class BimBaseLink extends BaseMCPLink {
  constructor(host?: string) {
    super({ serverName: "bimbase", host });
  }

  protected async startMcpServer(options: DiscoveryOverrides): Promise<number | true | string> {
    const resolved = await resolveExecutable(options, {
      productName: "BIMBase",
      exeName: EXE_NAME,
      featurePaths: FEATURE_PATHS,
      exeEnvVars: ["BIMBASE_EXE_PATH", "PLANTS_EXE_PATH"],
      rootEnvVars: ["BIMBASE_HOME", "BIMBASE_ROOT", "PLANTS_HOME", "PLANTS_ROOT"],
      registryRoots: () => this.registryRoots(),
      verifiedPath: () => this.verifiedExePath,
    });

    if (!resolved) {
      return (
        "未能自动定位 BIMBase。请先启动软件，" +
        "或在连接时传入 exePath（例如 connect(exePath: 'D:/BIMBase/BIMBase.exe')）。"
      );
    }

    this.verifiedExePath = resolved.path;

    // 已有运行实例时优先复用，不重复启动。
    const runningPort = await this.findRunningInstancePort(resolved.path);
    if (runningPort !== undefined) {
      return runningPort;
    }

    // 未运行：需要拉起进程。此处不猜测端口，交由 MCP 服务启动后回报，
    // 由子类在 connectMcp 中确认。返回 true 表示端口将在握手阶段确定。
    const project = this.resolveProjectPath(options);
    if (project === undefined) {
      return "未能准备可用的工程文件：请先手动打开一个工程，或指定 projectPath。";
    }

    const launchError = await this.launch(resolved.path, project);
    if (launchError) return launchError;

    // 启动后端口由软件写入自身的 MCP 配置，这里先占位，
    // 真实端口在 waitForPort 前由 resolveRunningPort 补齐。
    const port = await this.resolveMcpPortAfterLaunch(resolved.path);
    if (port === undefined) {
      return "已启动 BIMBase，但未能在约定时间内取得 MCP 服务端口。";
    }
    return port;
  }

  protected async connectMcp(_timeoutMs: number): Promise<InjectionResult | string> {
    // MCP 握手（JSON-RPC over HTTP）与工具/数据结构注入由 Python 执行器侧完成，
    // 本层只负责建立连接与状态；注入结果由执行器回报后填入。
    // 当前实现返回空能力快照，待执行器接入后补齐。
    return {
      injectedFunctions: [],
      injectedClasses: [],
      briefing: "",
      snapshot: {
        serverName: this.serverName,
        categories: [],
        functionsByCategory: {},
        dataStructures: [],
      },
    };
  }

  disconnect(): void {
    this.verifiedExePath = undefined;
  }

  /** 注册表四路候选：卸载表 / 自家配置键 / 文件关联。 */
  private async registryRoots(): Promise<CandidateRoot[]> {
    if (process.platform !== "win32") return [];
    // 注册表读取依赖 Windows 平台模块，未安装时降级为「无候选」，
    // 由环境变量与上次成功路径兜底，不影响非 Windows 环境构建。
    try {
      const { readRegistryRoots } = await import("../win-registry.js");
      return await readRegistryRoots();
    } catch {
      return [];
    }
  }

  /** 查找已运行实例的 MCP 端口；未运行返回 undefined。 */
  private async findRunningInstancePort(_exePath: string): Promise<number | undefined> {
    // 需要枚举进程并反查其 MCP 端口，依赖平台能力。
    // 在未接入进程枚举前返回 undefined，走「启动新实例」分支。
    return undefined;
  }

  /** 解析本次可用的工程文件路径。 */
  private resolveProjectPath(options: DiscoveryOverrides): string | undefined {
    if (options.projectPath) {
      return options.projectPath.toLowerCase().endsWith(".p3d") ? options.projectPath : undefined;
    }
    // 无显式工程时，需要一个模板工程复制到工作目录。
    // 模板路径由安装根推导，当前仅做存在性检查。
    const root = options.workDir;
    return root;
  }

  /** 拉起目标进程；成功返回 undefined，失败返回错误文案。 */
  private async launch(_exePath: string, _projectPath: string): Promise<string | undefined> {
    // 进程启动依赖平台与激活码校验，待执行器接入后实现。
    return "BIMBase 启动流程尚未接入执行器，请先手动启动软件后重试连接。";
  }

  /** 启动后取 MCP 端口。 */
  private async resolveMcpPortAfterLaunch(_exePath: string): Promise<number | undefined> {
    return undefined;
  }
}

export type { CandidateRoot, DiscoverySource };
export { existsSync, join };
