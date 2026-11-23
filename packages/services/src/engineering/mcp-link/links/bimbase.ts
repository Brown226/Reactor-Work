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
import { openMcpSession, type McpSession } from "../session.js";
import { findProcessesByExecutable } from "../process-discovery.js";
import { findMcpPortByPid, waitForMcpPortByPid } from "../port-lookup.js";
import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join as joinPath } from "node:path";

/** 安装根的特征目录：缺了它就不是 BIMBase 的安装位置。 */
const FEATURE_PATHS = ["PlantSPythonEnv"];
/** 启动器文件名。 */
const EXE_NAME = "BIMBase.exe";

export class BimBaseLink extends BaseMCPLink {
  private session?: McpSession;
  private runningPid?: number;
  private launchedPid?: number;
  private portResolver?: (pid?: number) => number | undefined;

  constructor(options: { serverName?: string; host?: string } = {}) {
    super({ serverName: options.serverName ?? "bimbase", host: options.host });
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
    // 逆向依据：原厂 `_find_running_plants` 命中后走 `_wait_for_mcp_ready(pid)`，
    // 即「找到就等它自己就绪」，不另起一个实例。
    const running = await this.findRunningInstance(resolved.path);
    if (running.running) {
      if (running.port !== undefined) return running.port;
      if (this.runningPid !== undefined) {
        const waited = await waitForMcpPortByPid(this.runningPid, { host: this.host });
        if (waited !== undefined) return waited;
      }
      return (
        "已检测到 BIMBase 正在运行，但未能取得 MCP 服务端口。" +
        "请确认软件已进入工程主界面（启动画面阶段不会监听），" +
        "以及内嵌 MCP 脚本已加载后重试。"
      );
    }

    // 未运行：拉起进程，端口由 PID 反查补齐。
    const project = await this.resolveProjectPath(options, resolved.path);
    if (project === undefined) {
      return "未能准备可用的工程文件：请先手动打开一个工程，或指定 projectPath。";
    }

    const launchError = await this.launch(resolved.path, project);
    if (launchError) return launchError;

    const port = await this.resolveMcpPortAfterLaunch(resolved.path);
    if (port === undefined) {
      return "已启动 BIMBase，但未能在约定时间内取得 MCP 服务端口。";
    }
    return port;
  }

  protected async connectMcp(timeoutMs: number): Promise<InjectionResult | string> {
    if (this.port === undefined) return "尚未确定 MCP 服务端口，无法握手。";

    const session = await openMcpSession({
      host: this.host,
      port: this.port,
      timeoutMs,
    });
    if (typeof session === "string") return session;

    let tools;
    try {
      tools = await session.listTools();
    } catch (error) {
      await session.close();
      return `已连上 MCP 服务，但拉取工具清单失败：${
        error instanceof Error ? error.message : String(error)
      }`;
    }

    this.session = session;
    // 转换 Schema → 函数签名，生成简报与能力快照。
    return this.prepareInjection(this.serverName, tools);
  }

  /** 取当前 MCP 会话；未连接时为 undefined。供执行器发起实际调用。 */
  currentSession(): McpSession | undefined {
    return this.session;
  }

  disconnect(): void {
    void this.session?.close();
    this.session = undefined;
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

  /**
   * 查找已运行实例的 MCP 端口。
   *
   * 复用已启动的软件比新起一个更符合用户预期（模型可能已经在里面），
   * 所以「找到了进程」与「拿到了端口」必须分开表达：
   * 找到进程但端口没开（软件还停在启动画面/未进入工程主界面）时，
   * 不能退化成再启动一个实例——那会出现两个软件抢同一份工程。
   */
  private async findRunningInstance(
    exePath: string,
  ): Promise<{ running: boolean; port?: number }> {
    const processes = await findProcessesByExecutable(exePath);
    if (processes.length === 0) return { running: false };
    const first = processes[0];
    if (!first) return { running: false };
    this.runningPid = first.pid;
    return { running: true, port: await this.readMcpPortForPid(first.pid) };
  }

  /**
   * 从运行实例反查 MCP 端口。
   *
   * 逆向结论：原厂 `common_tools.pid_to_mcp_port(pid)` 是以 PID 为键向实例要端口，
   * 不是解析厂商配置文件（配置格式随版本变化，PID 才稳定）。
   * 所以这里按 PID 列出该进程的监听端口并做连通确认。
   * 拿不到时返回 undefined，由调用方决定是轮询等待还是报错。
   */
  private async readMcpPortForPid(pid: number): Promise<number | undefined> {
    return await findMcpPortByPid(pid, { host: this.host });
  }

  /**
   * 解析本次可用的工程文件路径。
   *
   * 优先级：显式路径 > 工作目录下的临时工程（从安装模板复制）。
   * 显式路径必须是 .p3d；扩展名不对直接返回 undefined，不做猜测替换。
   */
  private async resolveProjectPath(
    options: DiscoveryOverrides,
    exePath: string,
  ): Promise<string | undefined> {
    if (options.projectPath) {
      return options.projectPath.toLowerCase().endsWith(".p3d") ? options.projectPath : undefined;
    }

    const workDir = options.workDir;
    if (!workDir) return undefined;

    // 模板工程位于安装根的模板目录下；复制一份到工作目录再打开，
    // 避免直接改到安装目录里的原件。
    const template = joinPath(dirname(exePath), "PlantSPythonEnv", "..", "Interface", "P3DTemplate", "temp.p3d");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = joinPath(workDir, `agent-${stamp}.p3d`);
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(template, target);
      return target;
    } catch {
      // 模板不存在时不阻塞：让软件自己打开空工程。
      return workDir;
    }
  }

  /**
   * 拉起目标进程。
   *
   * 用 detached 让软件独立于本进程存活：关闭 Agent 不应该连带关掉用户
   * 正在用的建模软件。启动后立刻返回，端口由 waitForPort 轮询。
   */
  private async launch(exePath: string, projectPath: string): Promise<string | undefined> {
    try {
      const child = spawn(exePath, [projectPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
      this.launchedPid = child.pid;
      return undefined;
    } catch (error) {
      return `启动 BIMBase 失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * 启动后取 MCP 端口。
   *
   * 优先级：调用方注入的解析器（可按实际版本/端口约定覆盖）> PID 反查。
   * 冷启动时内嵌 MCP 脚本要等软件进入工程主界面才开始监听，
   * 因此 PID 反查要轮询等待，而不是只查一次。
   * 两条路径都拿不到时返回 undefined，让上层给出「已启动但未取得端口」的明确提示，
   * 而不是假装连上。
   */
  private async resolveMcpPortAfterLaunch(_exePath: string): Promise<number | undefined> {
    const injected = this.portResolver?.(this.launchedPid);
    if (injected !== undefined) return injected;

    if (this.launchedPid === undefined) return undefined;
    return await waitForMcpPortByPid(this.launchedPid, { host: this.host });
  }

  /** 注入端口解析器；便于按实际版本对接。 */
  setPortResolver(resolver: (pid?: number) => number | undefined): void {
    this.portResolver = resolver;
  }
}

export type { CandidateRoot, DiscoverySource };
export { existsSync, join };
