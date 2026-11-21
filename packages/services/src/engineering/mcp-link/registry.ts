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
 * 已登记可连接的产品。新增产品在此登记工厂即可。
 *
 * 两类：MCP 系（bimbase）走 HTTP 握手；COM 系走进程发现 + 本地 API 目录。
 */
const FACTORIES: Record<string, LinkFactory> = {
  bimbase: () => new BimBaseLink(),

  // PKPM 的 MCP 服务名。技能正文全程用 `connect_to_server("pkpmmcp")`，
  // 与 BIMBase 是同一实现（PKPM 建模内核即 BIMBase/PlantS）。
  // 不登记会让技能第一步直接报「不支持的服务」。
  pkpmmcp: () => new BimBaseLink({ serverName: "pkpmmcp" }),

  sap2000: () =>
    new ComSoftwareLink({
      serverName: "sap2000",
      productName: "SAP2000",
      exeName: "SAP2000.exe",
      featurePaths: [],
      windowsOnly: true,
      // 厂商公开的 OAPI ProgID；本机未装 SAP2000，未验证。
      progId: "CSI.SAP2000.API.SapObject",
      catalog: { id: "sap2000" },
    }),

  etabs: () =>
    new ComSoftwareLink({
      serverName: "etabs",
      productName: "ETABS",
      exeName: "ETABS.exe",
      featurePaths: [],
      windowsOnly: true,
      // 厂商公开的 OAPI ProgID；本机未装 ETABS，未验证。
      progId: "CSI.ETABS.API.ETABSObject",
      catalog: { id: "etabs" },
    }),

  autocad: () =>
    new ComSoftwareLink({
      serverName: "autocad",
      productName: "AutoCAD",
      exeName: "acad.exe",
      featurePaths: [],
      windowsOnly: true,
      // 本机 AutoCAD 2021 实测：ProgID 已注册，LocalServer32 可取到 acad.exe。
      progId: "AutoCAD.Application",
      catalog: { id: "autocad" },
    }),

  rhino: () =>
    new ComSoftwareLink({
      serverName: "rhino",
      productName: "Rhino",
      exeName: "Rhino.exe",
      featurePaths: [],
      windowsOnly: true,
      // 官方公开 ProgID；本机未装 Rhino，未验证。
      progId: "Rhino.Application",
      catalog: { id: "rhino" },
    }),
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
