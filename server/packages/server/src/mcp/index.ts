/**
 * 托管 MCP 域公开入口（治理平面 P0）：跨模块只从这里导入（server/AGENTS.md 分层纪律）。
 * 目前消费方：identity/server.ts（装配）、audit/routes.ts（/desktop/policy 组装）。
 */

export { ensureMcpSchema } from "./schema.js";
export { createMcpRoutes, createMcpRelayRoutes, type McpRoutesOptions } from "./routes.js";
export {
  listManagedServers,
  listMcpServers,
  toManagedServer,
  MCP_SERVER_NAME_PATTERN,
  type McpServerPublic,
} from "./repo.js";
export {
  buildSnapshot,
  normalizeToolPolicy,
  annotatedDefaultPolicy,
  MAX_SNAPSHOT_TOOLS,
  MCP_TOOL_POLICY_VALUES,
  type McpToolPolicy,
  type McpToolSnapshotEntry,
} from "./catalog.js";
export { MCP_RELAY_TOKEN_TTL_SECONDS, MCP_RELAY_AUDIENCE } from "./relay-token.js";
