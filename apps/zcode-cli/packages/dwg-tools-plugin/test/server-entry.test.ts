import assert from "node:assert/strict";
import test from "node:test";
import { DWG_TOOLS_MCP_PROCESS_TITLE, createDwgToolsMcpServer, main } from "../src/server.js";

// 插件宿主契约：agent 子进程用 `__zcode-plugin-host <server.js>` import 本模块后调 main()。
// 缺这个导出时宿主直接退出（"Plugin server does not export main()."），
// MCP 设置页显示「MCP 进程启动失败」。见 docs/已完成/已完成-dwg-ocr-tools插件宿主启动失败修复.md。
test("dwg-tools server 导出 main（插件宿主契约）", () => {
  assert.equal(typeof main, "function");
});

test("dwg-tools server 仍导出 createDwgToolsMcpServer 与进程标题", () => {
  assert.equal(typeof createDwgToolsMcpServer, "function");
  assert.equal(DWG_TOOLS_MCP_PROCESS_TITLE, "zcode-dwg-tools-mcp");
});

// import 本模块不得有启动副作用：宿主先 import 再决定调 main()，
// 顶层无条件 serveStdio 会在宿主 import 阶段就抢走 stdio。
test("import dwg-tools server 模块不启动 stdio 服务", () => {
  assert.equal(typeof process.stdin._read, "function");
});
