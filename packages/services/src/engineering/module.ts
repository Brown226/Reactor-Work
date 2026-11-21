/**
 * engineering-mcp-link 模块清单：工程软件 MCP 连接层。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts。
 */
export const engineeringMcpLinkModule = {
  id: "engineering-mcp-link",
  requires: ["shared"],
  provides: ["engineering-mcp-link"],
  publicEntrypoints: ["contract.ts"],
} as const;
