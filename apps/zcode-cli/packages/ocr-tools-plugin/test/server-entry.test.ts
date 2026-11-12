import assert from "node:assert/strict";
import test from "node:test";
import { OCR_TOOLS_MCP_PROCESS_TITLE, createOcrToolsMcpServer, main } from "../src/server.js";

// 插件宿主契约：agent 子进程用 `__zcode-plugin-host <server.js>` import 本模块后调 main()。
// 缺这个导出时宿主直接退出（"Plugin server does not export main()."），
// MCP 设置页显示「MCP 进程启动失败」。见 docs/已完成/已完成-dwg-ocr-tools插件宿主启动失败修复.md。
test("ocr-tools server 导出 main（插件宿主契约）", () => {
  assert.equal(typeof main, "function");
});

test("ocr-tools server 仍导出 createOcrToolsMcpServer 与进程标题", () => {
  assert.equal(typeof createOcrToolsMcpServer, "function");
  assert.equal(OCR_TOOLS_MCP_PROCESS_TITLE, "zcode-ocr-tools-mcp");
});

// import 本模块不得有启动副作用：修复前顶层无条件 serveStdio，
// 宿主 import 阶段就会抢走 stdio，随后宿主又因缺 main() 退出。
test("import ocr-tools server 模块不启动 stdio 服务", () => {
  assert.equal(typeof process.stdin._read, "function");
});
