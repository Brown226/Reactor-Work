/**
 * 工程软件 MCP 连接层 —— 对外契约。
 *
 * 设计来源：PKPM Agent 的 software_link_kit / mcp_link 逆向还原。
 * 核心约定：Agent 下发指令，软件在自己的图形内核里执行；
 * 不采集屏幕、不嵌入软件窗口、不读界面像素。
 *
 * 本文件只做类型与纯函数的再导出，不导入实现模块，避免与 base/discovery
 * 形成循环依赖。
 */

export type {
  ConnectResult,
  DiscoveryOverrides,
  InjectionResult,
  McpCapabilitySnapshot,
} from "./mcp-link/types.js";

export type { BaseMCPLink } from "./mcp-link/base.js";
export { isPortOpen, waitForPort, sleep } from "./mcp-link/common.js";
export { resolveExecutable, candidateRoots, isValidRoot } from "./mcp-link/discovery.js";
export type { DiscoverySource, CandidateRoot, ResolvedExecutable } from "./mcp-link/discovery.js";
export { buildBriefing } from "./mcp-link/briefing.js";

export {
  convertTools,
  toCapabilitySnapshot,
  toInjectionResult,
  findFunctionsByCategory,
  searchFunctions,
  UNGROUPED,
} from "./mcp-link/injection.js";
export type {
  McpToolDescriptor,
  GeneratedFunction,
  ConversionResult,
} from "./mcp-link/injection.js";

export { functionSearch } from "./mcp-link/function-search.js";
export type {
  FunctionSearchAction,
  FunctionSearchRequest,
  FunctionSearchResult,
} from "./mcp-link/function-search.js";

export { PythonWorkerPool } from "./executor/python-pool.js";
export type {
  PythonWorkerOptions,
  PythonRunRequest,
  PythonRunResult,
} from "./executor/types.js";
export {
  renderInjectionStubs,
  renderInjectionPreamble,
  safeParamName,
  HOST_CALL_ENTRY,
} from "./executor/inject-stubs.js";

export {
  REQUIRED_SPEC_FIELDS,
  preflightSpec,
  describePreflight,
  evaluateEvidence,
  describeVerdict,
} from "./determinism/index.js";
export type {
  RequiredSpecField,
  AnalysisSpec,
  PreflightStatus,
  PreflightIssue,
  PreflightResult,
  AcceptanceOperator,
  AcceptanceCriterion,
  EvidenceVerdict,
  EvidenceIssue,
} from "./determinism/index.js";

export {
  builtinEngineeringSkillsRoot,
  listBuiltinEngineeringSkills,
  getBuiltinEngineeringSkill,
} from "./skills/builtin-skills.js";
export type { BuiltinSkillSummary } from "./skills/builtin-skills.js";

export { openMcpSession } from "./mcp-link/session.js";
export type { McpSession, McpSessionOptions } from "./mcp-link/session.js";

export { EngineeringExecutor } from "./executor/engineering-executor.js";
export type {
  EngineeringRunRequest,
  EngineeringRunResult,
} from "./executor/engineering-executor.js";

export {
  compactMessages,
  findSafeCutoff,
  atomicGroupStarts,
  DEFAULT_TAIL_KEEP,
} from "./context/compaction.js";
export type {
  CompactableMessage,
  CompactionOptions,
  CompactionResult,
} from "./context/compaction.js";

export {
  classifyTool,
  decidePermission,
  describeDecision,
} from "./permission/permission.js";
export type {
  PermissionMode,
  DangerLevel,
  PermissionDecision,
  ToolCallSummary,
} from "./permission/permission.js";

export { ComSoftwareLink } from "./mcp-link/links/com-software.js";
export type { ComLinkOptions } from "./mcp-link/links/com-software.js";
export { loadApiCatalogTools, clearApiCatalogCache } from "./mcp-link/api-catalog.js";
export type { ApiCatalogSpec } from "./mcp-link/api-catalog.js";

export {
  renderHostBridge,
  startHostBridge,
  bridgeDirName,
} from "./executor/host-bridge.js";

export { findProcessesByExecutable, normalizePath, samePath, isProcessAlive } from "./mcp-link/process-discovery.js";
export type { MatchedProcess } from "./mcp-link/process-discovery.js";

export {
  ENGINEERING_TOOLS,
  invokeEngineeringTool,
} from "./agent-tools.js";
export type {
  EngineeringTool,
  EngineeringToolCall,
  EngineeringToolResult,
} from "./agent-tools.js";

export { diagnose, probePort } from "./mcp-link/diagnostics.js";
export type { DiagnosticCheck, DiagnosticReport, DiagnoseOptions } from "./mcp-link/diagnostics.js";

export { verifiedRun, extractCriteria } from "./determinism/verified-run.js";
export type { VerifiedRunRequest, VerifiedRunResult } from "./determinism/verified-run.js";

export { listMcpTools, callMcpTool } from "./mcp-adapter.js";
export type {
  McpToolDefinition,
  McpToolResult,
  EngineeringMcpOptions,
} from "./mcp-adapter.js";
