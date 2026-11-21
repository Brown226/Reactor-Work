/**
 * MCP 连接层抽象基类
 * 照抄 PKPMAgent/software_link_kit 的设计：
 *   子类只实现 startMcpServer，其余通用
 */
export interface MCPLinkConfig {
  name: string;
  host?: string;
  port?: number;
}

export abstract class BaseMCPLink {
  protected port?: number;
  protected host = '127.0.0.1';
  protected connected = false;

  constructor(protected config: MCPLinkConfig) {}

  /** 子类实现：如何启动目标软件 + 它的 MCP 服务 */
  protected abstract startMcpServer(
    workDir?: string,
    cmdArgs?: string,
  ): Promise<boolean | string>;

  /** 连接入口 */
  async connect(workDir?: string, cmdArgs?: string, timeout = 30_000): Promise<boolean | string> {
    if (this.connected) return true;
    const started = await this.startMcpServer(workDir, cmdArgs);
    if (started !== true) return started;
    if (!this.port) return '未能确定 MCP 服务端口';
    try {
      await this.waitMcpReady(this.port, 100_000);
    } catch (e) {
      return `MCP 服务未在端口 ${this.port} 就绪：${(e as Error).message}`;
    }
    return this.connectMcp(timeout);
  }

  /** 通用：等端口可连 */
  protected async waitMcpReady(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isPortOpen(port)) return;
      await sleep(500);
    }
    throw new Error(`等待 ${timeoutMs}ms 超时`);
  }

  /** 通用：MCP 握手 */
  protected abstract connectMcp(timeout: number): Promise<boolean | string>;

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/** 端口探测 */
export async function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  // Node 侧实现：net.connect
  throw new Error('TODO: 用 net.Socket 实现');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
