import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveApiCatalogPath } from "../src/engineering/mcp-link/api-catalog.js";
import { listCapabilities } from "../src/engineering/mcp-link/capabilities.js";
import {
  MODELING_CORE_SPECS,
  listDesktopServerSpecs,
  listSupportedServers,
} from "../src/engineering/mcp-link/registry.js";

describe("能力总览", () => {
  it("覆盖全部已登记服务，不多不少", async () => {
    const capabilities = await listCapabilities();
    const servers = capabilities.map((item) => item.server).sort();
    expect(servers).toEqual([...listSupportedServers()].sort());
  });

  it("每条都有展示名、接口标签与示例用法", async () => {
    const capabilities = await listCapabilities();
    for (const item of capabilities) {
      expect(item.productName.length).toBeGreaterThan(0);
      expect(item.bridge.length).toBeGreaterThan(0);
      expect(item.hint && item.hint.length > 0).toBe(true);
      expect(typeof item.installed).toBe("boolean");
    }
  });

  it("functionCount 等于对应目录文件里的条目数", async () => {
    const capabilities = await listCapabilities();
    const byServer = new Map(capabilities.map((item) => [item.server, item]));

    for (const spec of listDesktopServerSpecs()) {
      const capability = byServer.get(spec.serverName);
      expect(capability).toBeDefined();
      const path = resolveApiCatalogPath(spec.catalogId);
      const expected = path ? (JSON.parse(readFileSync(path, "utf8")) as unknown[]).length : 0;
      expect(capability?.functionCount).toBe(expected);
    }
  });

  it("本地 API 目录能解析的软件，函数数应大于 0（AutoCAD 除外）", async () => {
    const capabilities = await listCapabilities();
    const withoutCatalog = capabilities
      .filter((item) => item.functionCount === 0)
      .map((item) => item.server)
      .sort();
    // AutoCAD 走脚本/命令，没有可编译的 API 库；建模内核走 MCP tools/list。
    expect(withoutCatalog).toEqual(["autocad", "bimbase", "pkpmmcp"]);
  });

  it("建模内核以 MCP 展示，且指向对应技能包", async () => {
    const capabilities = await listCapabilities();
    const byServer = new Map(capabilities.map((item) => [item.server, item]));

    for (const core of MODELING_CORE_SPECS) {
      const capability = byServer.get(core.serverName);
      expect(capability?.bridge).toBe("MCP");
      expect(capability?.skillDir).toBe(core.skillDir);
    }
  });

  it("桌面软件的接口标签与登记的真实桥接方式一致", async () => {
    const capabilities = await listCapabilities();
    const byServer = new Map(capabilities.map((item) => [item.server, item]));

    expect(byServer.get("tekla")?.bridge).toBe(".NET");
    expect(byServer.get("midas")?.bridge).toBe("本地 HTTP API");
    expect(byServer.get("sketchup")?.bridge).toBe("Ruby 插件");
    expect(byServer.get("staadpro")?.bridge).toBe("COM");
    expect(byServer.get("abaqus")?.bridge).toBe("自带 Python");
  });

  it("本机未安装任何软件时仍然返回全部条目，不抛异常", async () => {
    const capabilities = await listCapabilities();
    expect(capabilities.length).toBe(listSupportedServers().length);
  });
});
