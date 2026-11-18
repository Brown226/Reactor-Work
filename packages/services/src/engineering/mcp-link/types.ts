/**
 * 工程连接层的共享类型。
 *
 * 单独成文件是为了打断 contract ↔ base/discovery/briefing 的循环：
 * 这些模块都只依赖 types，不互相依赖。
 */

export type ConnectResult = true | string;

/** 一次 MCP 握手后得到的能力快照。 */
export interface McpCapabilitySnapshot {
  /** MCP 服务名，与 registry 中的 key 一致。 */
  serverName: string;
  /** 可用函数类别（来自 tools/list 的分组，缺失时为空数组）。 */
  categories: string[];
  /** 可用函数名，按类别归组。 */
  functionsByCategory: Record<string, string[]>;
  /** 可用的数据结构名（pydantic/JSON Schema 定义）。 */
  dataStructures: string[];
}

/** 连接成功后注入执行环境的结果。 */
export interface InjectionResult {
  /** 已注入的函数名。 */
  injectedFunctions: string[];
  /** 已注入的数据结构名。 */
  injectedClasses: string[];
  /** 生成的连接简报文本，可直接追加到系统提示。 */
  briefing: string;
  /** 能力快照，供 function_search 使用。 */
  snapshot: McpCapabilitySnapshot;
}

/** 安装位置发现的可选覆盖项。 */
export interface DiscoveryOverrides {
  /** 显式指定的可执行文件路径，优先级最高。 */
  exePath?: string;
  /** 显式指定的工程文件/目录，仅本次连接有效。 */
  projectPath?: string;
  /** 工作目录，用于在无工程时放置临时工程。 */
  workDir?: string;
}
