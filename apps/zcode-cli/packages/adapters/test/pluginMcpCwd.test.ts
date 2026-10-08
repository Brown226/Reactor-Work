import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { McpServerConfig } from "@zcode/contracts";
import { resolvePluginMcpServers } from "../src/plugins/mcp.js";
import type { LoadedPlugin } from "../src/plugins/types.js";

/**
 * 插件声明的 stdio MCP server 的 cwd 归属（ocr/dwg 面板「进程启动失败」回归）：
 *
 * 插件 manifest 的 `args: ["dist/mcp/server.js"]` 是**插件相对**路径。cwd 缺省时若落到宿主
 * 工作区，node 找不到该文件，进程从未起来——面板只报 "Connection closed"，看不出是 spawn
 * 失败。因此未声明 cwd 必须解析成插件根；显式声明的 cwd 仍然是插件作者的意图，优先。
 */

const pluginRoot = join("E:", "plugins", "dwg-tools-plugin");

function loadedPlugin(rootPath = pluginRoot): LoadedPlugin {
  return {
    id: "dwg-tools",
    manifest: { name: "dwg-tools" } as unknown as LoadedPlugin["manifest"],
    manifestPath: join(rootPath, ".zcode-plugin", "plugin.json"),
    marketplace: "zcode-official",
    rootPath,
    source: "builtin" as unknown as LoadedPlugin["source"],
  };
}

function resolve(definitions: Record<string, unknown>): Record<string, McpServerConfig> {
  return resolvePluginMcpServers({
    dataPath: pluginRoot,
    definitions,
    diagnostics: [],
    env: {},
    loaded: loadedPlugin(),
    options: {},
    workingDirectory: join("E:", "workspace", "some-project"),
  });
}

test("未声明 cwd：stdio MCP 落到插件根（否则相对 args 找不到 server 入口）", () => {
  const servers = resolve({
    "dwg-tools": { type: "stdio", command: "node", args: ["dist/mcp/server.js"] },
  });
  const server = servers["plugin:dwg-tools:dwg-tools"];
  assert.ok(server && server.type === "stdio");
  assert.equal(server.cwd, pluginRoot, "cwd 必须是插件根，不能是宿主工作区");
  assert.deepEqual(server.args, ["dist/mcp/server.js"]);
  // 项目目录仍然经 env 暴露给 server，不因 cwd 改变而丢失。
  assert.equal(server.env?.ZCODE_PROJECT_DIR, join("E:", "workspace", "some-project"));
  assert.equal(server.env?.ZCODE_PLUGIN_ROOT, pluginRoot);
});

test("显式 cwd：模板解析后优先于插件根", () => {
  const servers = resolve({
    "dwg-tools": { type: "stdio", command: "node", args: ["dist/mcp/server.js"], cwd: "./bin" },
  });
  const server = servers["plugin:dwg-tools:dwg-tools"];
  assert.ok(server && server.type === "stdio");
  assert.equal(server.cwd, "./bin");
});
