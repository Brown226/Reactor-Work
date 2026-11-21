/**
 * MCP 连接注册表：按 server name 管理运行时连接实例。
 *
 * 逆向自 PKPM Agent 的 mcp_link/registry。约定：
 *   - 连接状态是唯一真相，本模块持有；配置持久化归 mcp-sync，不在此处。
 *   - 同一 server name 只允许一个活动实例，重复 connect 幂等。
 *   - 实例不落盘，进程重启后重建。
 */

import type { BaseMCPLink } from "./base.js";
import type { ConnectResult, DiscoveryOverrides } from "./types.js";
import { BimBaseLink } from "./links/bimbase.js";
import { ComSoftwareLink } from "./links/com-software.js";

type LinkFactory = () => BaseMCPLink;

/**
 * 端口解析器：由宿主注入，把「进程」映射到「MCP 服务端口」。
 *
 * 为什么做成可插拔而不是写死读某个文件：各厂商、各版本的端口落盘位置与
 * 格式都不同，且无法在没有实机的情况下确定。宿主用实际环境里验证过的
 * 方式（配置文件、日志、命名管道、netstat）实现它即可。
 */
export type EngineeringPortResolver = (serverName: string, pid?: number) => number | undefined;

let portResolver: EngineeringPortResolver | undefined;

/**
 * 注入端口解析器；传 undefined 清除。
 *
 * 注入后只影响之后创建的连接实例，已存在的实例保持原样——避免中途换解析器
 * 导致同一连接出现两个端口来源。
 */
export function setEngineeringPortResolver(resolver: EngineeringPortResolver | undefined): void {
  portResolver = resolver;
}

/** 当前是否已注入端口解析器。 */
export function hasEngineeringPortResolver(): boolean {
  return portResolver !== undefined;
}

/** 把全局解析器绑定到具体连接实例。 */
function bindPortResolver<T extends BaseMCPLink>(link: T, serverName: string): T {
  if (portResolver && link instanceof BimBaseLink) {
    link.setPortResolver((pid?: number) => portResolver?.(serverName, pid));
  }
  return link;
}

/** COM 系软件的连接配置；工厂与诊断共用，避免两处漂移。 */
export interface ComServerSpec {
  productName: string;
  exeName: string;
  progId: string;
  catalogId: string;
}

/**
 * 已登记的 COM 系软件。
 *
 * ProgID 用于注册表判断「是否已安装」：autocad 经本机 2021 实测；
 * sap2000 / etabs / rhino 取自厂商公开文档，本机未安装，未验证。
 */
export const COM_SERVER_SPECS: Record<string, ComServerSpec> = {
  sap2000: {
    productName: "SAP2000",
    exeName: "SAP2000.exe",
    progId: "CSI.SAP2000.API.SapObject",
    catalogId: "sap2000",
  },
  etabs: {
    productName: "ETABS",
    exeName: "ETABS.exe",
    progId: "CSI.ETABS.API.ETABSObject",
    catalogId: "etabs",
  },
  autocad: {
    productName: "AutoCAD",
    exeName: "acad.exe",
    progId: "AutoCAD.Application",
    catalogId: "autocad",
  },
  rhino: {
    productName: "Rhino",
    exeName: "Rhino.exe",
    progId: "Rhino.Application",
    catalogId: "rhino",
  },
};

/** 列出全部 COM 系配置（含 serverName），供诊断遍历。 */
export function listComServerSpecs(): Array<{ serverName: string } & ComServerSpec> {
  return Object.entries(COM_SERVER_SPECS).map(([serverName, spec]) => ({ serverName, ...spec }));
}

/**
 * 已登记可连接的产品。新增产品在此登记工厂即可。
 *
 * 两类：MCP 系（bimbase）走 HTTP 握手；COM 系走进程发现 + 本地 API 目录。
 */
const FACTORIES: Record<string, LinkFactory> = {
  bimbase: () => bindPortResolver(new BimBaseLink(), "bimbase"),

  // PKPM 的 MCP 服务名。技能正文全程用 `connect_to_server("pkpmmcp")`，
  // 与 BIMBase 是同一实现（PKPM 建模内核即 BIMBase/PlantS）。
  // 不登记会让技能第一步直接报「不支持的服务」。
  pkpmmcp: () => bindPortResolver(new BimBaseLink({ serverName: "pkpmmcp" }), "pkpmmcp"),

  ...Object.fromEntries(
    Object.entries(COM_SERVER_SPECS).map(([serverName, spec]) => [
      serverName,
      () =>
        new ComSoftwareLink({
          serverName,
          productName: spec.productName,
          exeName: spec.exeName,
          featurePaths: [],
          windowsOnly: true,
          progId: spec.progId,
          catalog: { id: spec.catalogId },
        }),
    ]),
  ),
};

const activeLinks = new Map<string, BaseMCPLink>();

/** 已支持连接的 server name 列表。 */
export function listSupportedServers(): string[] {
  return Object.keys(FACTORIES);
}

/** 连接指定 server；已连接时幂等返回成功。 */
export async function connectToServer(
  serverName: string,
  options: DiscoveryOverrides = {},
): Promise<ConnectResult> {
  const factory = FACTORIES[serverName];
  if (!factory) {
    return `不支持的服务：${serverName}。可用：${listSupportedServers().join("、")}`;
  }

  const existing = activeLinks.get(serverName);
  if (existing?.isConnected()) return true;

  const link = existing ?? factory();
  activeLinks.set(serverName, link);

  const result = await link.connect(options);
  if (result !== true) {
    activeLinks.delete(serverName);
  }
  return result;
}

/** 断开指定 server。未连接时静默返回。 */
export function disconnectServer(serverName: string): boolean {
  const link = activeLinks.get(serverName);
  if (!link) return false;
  link.disconnect();
  activeLinks.delete(serverName);
  return true;
}

/** 判断指定 server 当前是否已连接。 */
export function isServerConnected(serverName: string): boolean {
  return activeLinks.get(serverName)?.isConnected() ?? false;
}

/** 取活动连接实例；未连接返回 undefined。 */
export function getActiveLink(serverName: string): BaseMCPLink | undefined {
  return activeLinks.get(serverName);
}

/** 取全部活动连接，供提示注入与状态展示。 */
export function getActiveLinks(): Record<string, BaseMCPLink> {
  return Object.fromEntries(activeLinks);
}

/** 取全部已连接的 server name。 */
export function getConnectedServers(): string[] {
  return [...activeLinks.entries()]
    .filter(([, link]) => link.isConnected())
    .map(([name]) => name);
}

/** 进程退出或切换工程时清空全部连接。 */
export function disconnectAll(): void {
  for (const [name] of activeLinks) disconnectServer(name);
}
