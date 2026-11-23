import { describe, expect, it } from "vitest";

import { resolveApiCatalogPath } from "../src/engineering/mcp-link/api-catalog.js";
import {
  COM_SERVER_SPECS,
  LOCAL_API_SERVER_SPECS,
  connectToServer,
  disconnectAll,
  getConnectedServers,
  isServerConnected,
  listDesktopServerSpecs,
  listSupportedServers,
} from "../src/engineering/mcp-link/registry.js";
import { diagnose } from "../src/engineering/mcp-link/diagnostics.js";

/**
 * 登记一致性：新增软件最容易犯的错是「工厂登记了、目录没接上」或
 * 「目录名与 catalogId 对不上」，这会让 function_search 静默查不到函数。
 * 所以这里用真实仓库目录做端到端断言，而不是 mock 路径。
 */
describe("桌面软件登记表", () => {
  // AutoCAD 是个例外：AutoCAD-Link 的 references 里没有可编译的 API 数据库，
  // 它的连接与脚本执行不依赖注入目录（走 sendCommand/脚本），所以允许没有 catalog。
  // 其余登记项一旦缺目录，function_search 就会静默查不到函数，必须拦住。
  it("除 AutoCAD 外，每个已登记的桌面软件都能解析到本地 API 目录", () => {
    const withoutCatalog = listDesktopServerSpecs()
      .filter((spec) => !resolveApiCatalogPath(spec.catalogId))
      .map((spec) => spec.serverName)
      .sort();
    expect(withoutCatalog).toEqual(["autocad"]);
  });

  it("每个桌面软件都有产品名、exe 名与合法桥接方式", () => {
    const allowed = new Set(["com", "dotnet", "http", "ruby", "python"]);
    for (const spec of listDesktopServerSpecs()) {
      expect(spec.productName.trim().length).toBeGreaterThan(0);
      expect(spec.exeName.toLowerCase().endsWith(".exe")).toBe(true);
      expect(allowed.has(spec.bridge)).toBe(true);
    }
  });

  it("COM 系有 ProgID，非 COM 系没有 ProgID 但有环境变量名", () => {
    for (const spec of Object.values(COM_SERVER_SPECS)) {
      expect(spec.progId?.length ?? 0).toBeGreaterThan(0);
    }
    for (const spec of Object.values(LOCAL_API_SERVER_SPECS)) {
      expect(spec.progId).toBeUndefined();
      expect(spec.exeEnvVars?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("listSupportedServers 覆盖全部桌面软件且无重复", () => {
    const servers = listSupportedServers();
    expect(new Set(servers).size).toBe(servers.length);
    for (const spec of listDesktopServerSpecs()) {
      expect(servers).toContain(spec.serverName);
    }
    expect(servers).toContain("bimbase");
    expect(servers).toContain("pkpmmcp");
  });

  it("未知服务返回可读错误并列出新登记项", async () => {
    const result = await connectToServer("not-a-product");
    expect(typeof result).toBe("string");
    expect(String(result)).toContain("不支持的服务");
    expect(String(result)).toContain("tekla");
  });

  it("显式 exePath 不存在时给出「可执行文件不存在」而不是抛异常", async () => {
    const missingExe = "D:/__no_such_dir__/TeklaStructures.exe";
    const result = await connectToServer("tekla", { exePath: missingExe });
    expect(typeof result).toBe("string");
    expect(String(result)).toContain("可执行文件不存在");
    expect(isServerConnected("tekla")).toBe(false);
    expect(getConnectedServers()).not.toContain("tekla");
  });

  it("用存在的可执行文件连接 SketchUp 会注入 API 目录并断开", async () => {
    if (process.platform !== "win32") return; // 桌面软件连接仅在 Windows 上有意义
    const result = await connectToServer("sketchup", { exePath: process.execPath });
    expect(result).toBe(true);
    expect(isServerConnected("sketchup")).toBe(true);
    disconnectAll();
    expect(isServerConnected("sketchup")).toBe(false);
  });

  it("diagnose 对非 COM 软件给出安装位置检查而不是 COM 注册检查", async () => {
    const report = await diagnose({ server: "abaqus" });
    const names = report.checks.map((check) => check.name);
    expect(names.some((name) => name.startsWith("安装位置 · Abaqus"))).toBe(true);
    expect(names.some((name) => name.startsWith("COM 注册"))).toBe(false);
    expect(report.supported).toContain("abaqus");
  });

  it("diagnose 不指定目标时覆盖全部桌面软件", async () => {
    const report = await diagnose();
    const names = report.checks.map((check) => check.name).join("\n");
    for (const spec of listDesktopServerSpecs()) {
      expect(names).toContain(spec.productName);
    }
  });
});
