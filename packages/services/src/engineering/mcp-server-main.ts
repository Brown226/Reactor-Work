#!/usr/bin/env node
/**
 * 工程 MCP 服务的可执行入口。
 *
 * Agent 按 MCP 配置以 `command + args` 启动本文件（编译后为 mcp-server-main.js）。
 * 只做进程接线：启动服务、处理退出信号。协议逻辑在 mcp-server.ts。
 *
 * 可用环境变量：
 *   ZCODE_ENGINEERING_PERMISSION_MODE  ask | auto | full，缺省 auto
 *   ZCODE_ENGINEERING_PYTHON           指定 Python 解释器，缺省自动探测
 */

import { startEngineeringMcpServer } from "./mcp-server.js";

const stop = startEngineeringMcpServer();

function shutdown(): void {
  try {
    stop();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
