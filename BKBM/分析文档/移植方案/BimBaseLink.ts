/**
 * BIMBase / PKPM 连接实现
 * 四路安装发现策略（照抄 plants.pyd 还原结果）
 */
import { BaseMCPLink } from './BaseMCPLink';

export class BimBaseLink extends BaseMCPLink {
  private exePath?: string;

  /** 四路候选，按优先级 */
  protected async candidateRoots(): Promise<string[]> {
    const roots: string[] = [];

    // ① 卸载表
    roots.push(...(await this.registryInstallRoots()));

    // ② 自家配置键
    roots.push(...(await this.registryConfigRoots()));

    // ③ 文件关联
    roots.push(...(await this.registryAssociationRoots()));

    // ④ 环境变量
    for (const env of ['BIMBASE_HOME', 'BIMBASE_ROOT', 'PLANTS_HOME', 'PLANTS_ROOT']) {
      const v = process.env[env];
      if (v) roots.push(v);
    }

    // 去重 + 校验
    return [...new Set(roots)].filter((r) => this.isValidRoot(r));
  }

  /** 校验：必须有启动器 + MCP 脚本 */
  protected isValidRoot(root: string): boolean {
    // 检查 <root>/BIMBase.exe 或 <root>/.../StartBimBaseMCPServer.py
    throw new Error('TODO: 实现校验');
  }

  /** 解析可执行文件：显式 > 环境变量 > 上次成功 > 自动发现 */
  protected async resolveExePath(explicit?: string): Promise<string | null> {
    if (explicit) return this.normalize(explicit);
    if (process.env.BIMBASE_EXE_PATH) return this.normalize(process.env.BIMBASE_EXE_PATH);
    const persisted = await this.readPersistedExe();
    if (persisted) return persisted;
    const roots = await this.candidateRoots();
    return roots.length ? this.normalize(roots[0]) : null;
  }

  protected async startMcpServer(workDir?: string): Promise<boolean | string> {
    const exe = await this.resolveExePath();
    if (!exe) {
      return '未能自动定位 PKPM。请先启动 PKPM，或调用 connect(exePath=...) 指定位置。';
    }
    // 1. 先看是否已有进程
    const running = await this.findRunningProcess(exe);
    if (running) {
      this.port = await this.pidToMcpPort(running);
      return true;
    }
    // 2. 复制模板工程（如需）
    const project = await this.resolveProject(workDir);
    // 3. 启动
    const pid = await this.spawn(exe, project);
    this.port = await this.pidToMcpPort(pid);
    return true;
  }

  protected async connectMcp(_timeout: number): Promise<boolean | string> {
    // httpx streamable_http + JSON-RPC
    this.connected = true;
    return true;
  }

  private normalize(p: string): string { return p; }
  private async readPersistedExe(): Promise<string | null> { return null; } // TODO
  private async registryInstallRoots(): Promise<string[]> { return []; } // TODO
  private async registryConfigRoots(): Promise<string[]> { return []; } // TODO
  private async registryAssociationRoots(): Promise<string[]> { return []; } // TODO
  private async findRunningProcess(_exe: string): Promise<number | null> { return null; } // TODO
  private async pidToMcpPort(_pid: number): Promise<number> { throw new Error('TODO'); }
  private async resolveProject(_workDir?: string): Promise<string | null> { return null; } // TODO
  private async spawn(_exe: string, _proj: string | null): Promise<number> { throw new Error('TODO'); }
}
