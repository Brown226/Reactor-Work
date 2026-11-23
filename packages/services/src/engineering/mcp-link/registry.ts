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
import { resolveApiCatalogPath } from "./api-catalog.js";
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

/**
 * 桌面软件的连接配置；工厂与诊断共用，避免两处漂移。
 *
 * 「桌面软件」而不是「COM 软件」，是因为这些产品虽然都被技能正文当作本地
 * 建模能力调用，但 Python 侧的桥接方式并不相同：COM、.NET 程序集、本地 HTTP、
 * Ruby 插件、自带 Python 解释器都有。共同点是：
 *   1. Node 侧不建立 MCP 会话，连接 = 进程/安装发现 + 本地 API 目录注入；
 *   2. 真正的调用由 Python 执行器里的技能脚本完成。
 */
export interface DesktopServerSpec {
  productName: string;
  exeName: string;
  catalogId: string;
  /** COM ProgID：只有 COM 系软件有。注册表已注册时可跳过 exe 定位。 */
  progId?: string;
  /** 校验安装根的特征相对路径；为空表示只按 exe 名与目录存在性判断。 */
  featurePaths?: string[];
  /** 环境变量名：可直接指向 exe 或安装根。 */
  exeEnvVars?: string[];
  rootEnvVars?: string[];
  /** Python 侧真实桥接方式，用于生成准确的连接提示与诊断文案。 */
  bridge: "com" | "dotnet" | "http" | "ruby" | "python";
  /** 已知限制或使用前提，展示给用户看。 */
  note?: string;
}

/**
 * 已登记的 COM 系软件。
 *
 * ProgID 用于注册表判断「是否已安装」：autocad 经本机 2021 实测；
 * sap2000 / etabs / rhino 取自厂商公开文档，本机未安装，未验证。
 */
export const COM_SERVER_SPECS: Record<string, DesktopServerSpec> = {
  sap2000: {
    productName: "SAP2000",
    exeName: "SAP2000.exe",
    progId: "CSI.SAP2000.API.SapObject",
    catalogId: "sap2000",
    bridge: "com",
  },
  etabs: {
    productName: "ETABS",
    exeName: "ETABS.exe",
    progId: "CSI.ETABS.API.ETABSObject",
    catalogId: "etabs",
    bridge: "com",
  },
  autocad: {
    productName: "AutoCAD",
    exeName: "acad.exe",
    progId: "AutoCAD.Application",
    catalogId: "autocad",
    bridge: "com",
  },
  rhino: {
    productName: "Rhino",
    exeName: "Rhino.exe",
    progId: "Rhino.Application",
    catalogId: "rhino",
    bridge: "com",
  },
};

/**
 * 已登记的非 COM 桌面软件。
 *
 * 这五个产品没有可用的本机 ProgID 证据（要么根本不是 COM 服务器），因此
 * 安装发现只能靠 exe 名 + 环境变量；连接时若自动发现失败，请显式传 exePath。
 * exe 名取自厂商安装器与技能正文，本机未安装、未实机验证；版本升级可能改名，
 * 环境变量优先于猜测的文件名。
 */
export const LOCAL_API_SERVER_SPECS: Record<string, DesktopServerSpec> = {
  tekla: {
    productName: "Tekla Structures",
    exeName: "TeklaStructures.exe",
    catalogId: "tekla",
    exeEnvVars: ["TEKLA_EXE_PATH"],
    rootEnvVars: ["TEKLA_HOME", "TEKLA_ROOT"],
    bridge: "dotnet",
    note: "只复用已运行且已打开模型的实例，不自动启动；API 为 .NET 程序集（Tekla.Structures），经 Python CLR 调用。",
  },
  midas: {
    productName: "MIDAS Civil/Gen NX",
    exeName: "MidasCivil.exe",
    catalogId: "midas",
    exeEnvVars: ["MIDAS_EXE_PATH"],
    rootEnvVars: ["MIDAS_HOME", "MIDAS_ROOT"],
    bridge: "http",
    note: "MIDAS 走本地 HTTP API：在软件内「工具 → API → API Settings」配置 Base URL 与 MAPI-Key，连接由 Python 侧完成，不需要端口反查。",
  },
  sketchup: {
    productName: "SketchUp",
    exeName: "SketchUp.exe",
    catalogId: "sketchup",
    exeEnvVars: ["SKETCHUP_EXE_PATH"],
    rootEnvVars: ["SKETCHUP_HOME", "SKETCHUP_ROOT"],
    bridge: "ruby",
    note: "经 SketchUp 内插件桥调用 Ruby API；首次连接会自动安装插件，已开着的 SketchUp 需重启一次才连得上。",
  },
  staadpro: {
    productName: "STAAD.Pro",
    exeName: "STAADPro.exe",
    catalogId: "staadpro",
    exeEnvVars: ["STAADPRO_EXE_PATH"],
    rootEnvVars: ["STAADPRO_HOME", "STAADPRO_ROOT"],
    bridge: "com",
    note: "经 OpenSTAAD COM（openstaadpy）调用；只挂接已运行并打开模型的实例，不自动启动、不代开文件。",
  },
  abaqus: {
    productName: "Abaqus",
    exeName: "abaqus.exe",
    catalogId: "abaqus",
    exeEnvVars: ["ABAQUS_EXE_PATH"],
    rootEnvVars: ["ABAQUS_HOME", "ABAQUS_ROOT"],
    bridge: "python",
    note: "通过 Abaqus 自带 Python 连接；启动器随版本改名（如 abq2024.exe），建议用 exePath 或 ABAQUS_EXE_PATH 指定。",
  },
};

/** 兼容旧名：COM 系配置只是桌面软件配置的一种，字段完全一致。 */
export type ComServerSpec = DesktopServerSpec;

/** 列出全部 COM 系配置（含 serverName），供诊断遍历。 */
export function listComServerSpecs(): Array<{ serverName: string } & DesktopServerSpec> {
  return Object.entries(COM_SERVER_SPECS).map(([serverName, spec]) => ({ serverName, ...spec }));
}

/** 列出全部桌面软件配置（COM + 本地 API 两类），供诊断与工厂共用。 */
export function listDesktopServerSpecs(): Array<{ serverName: string } & DesktopServerSpec> {
  return [
    ...listComServerSpecs(),
    ...Object.entries(LOCAL_API_SERVER_SPECS).map(([serverName, spec]) => ({
      serverName,
      ...spec,
    })),
  ];
}

/** 桥接方式的中文名，用于连接提示与错误文案。 */
const BRIDGE_LABELS: Record<DesktopServerSpec["bridge"], string> = {
  com: "COM",
  dotnet: ".NET",
  http: "本地 HTTP API",
  ruby: "Ruby 插件",
  python: "自带 Python",
};

/**
 * 已登记可连接的产品。新增产品在此登记工厂即可。
 *
 * 两类：MCP 系（bimbase / pkpmmcp）走 HTTP 握手；桌面软件走进程发现 + 本地 API 目录。
 */
const FACTORIES: Record<string, LinkFactory> = {
  bimbase: () => bindPortResolver(new BimBaseLink(), "bimbase"),

  // PKPM 的 MCP 服务名。技能正文全程用 `connect_to_server("pkpmmcp")`，
  // 与 BIMBase 是同一实现（PKPM 建模内核即 BIMBase/PlantS）。
  // 不登记会让技能第一步直接报「不支持的服务」。
  pkpmmcp: () => bindPortResolver(new BimBaseLink({ serverName: "pkpmmcp" }), "pkpmmcp"),

  ...Object.fromEntries(
    listDesktopServerSpecs().map((spec) => [
      spec.serverName,
      () =>
        new ComSoftwareLink({
          serverName: spec.serverName,
          productName: spec.productName,
          exeName: spec.exeName,
          featurePaths: spec.featurePaths ?? [],
          exeEnvVars: spec.exeEnvVars,
          rootEnvVars: spec.rootEnvVars,
          windowsOnly: true,
          progId: spec.progId,
          bridgeLabel: BRIDGE_LABELS[spec.bridge],
          note: spec.note,
          // 目录路径必须在这里解析出来：只传 id 会让 loadApiCatalogTools 因 path 缺失
          // 直接返回空数组，桌面软件的 function_search 永远查不到函数。
          catalog: { id: spec.catalogId, path: resolveApiCatalogPath(spec.catalogId) },
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
  return [...activeLinks.entries()].filter(([, link]) => link.isConnected()).map(([name]) => name);
}

/** 进程退出或切换工程时清空全部连接。 */
export function disconnectAll(): void {
  for (const [name] of activeLinks) disconnectServer(name);
}
