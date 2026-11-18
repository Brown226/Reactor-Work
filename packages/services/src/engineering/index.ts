/**
 * 工程软件连接层入口。
 *
 * 只在需要驱动工程软件（BIMBase/PKPM、SAP2000、AutoCAD、Rhino、Office）时使用。
 * 连接后通过 Python 执行器注入工具函数，Agent 写脚本批量调用。
 */

export * from "./contract.js";

export {
  connectToServer,
  disconnectAll,
  disconnectServer,
  getActiveLink,
  getActiveLinks,
  getConnectedServers,
  isServerConnected,
  listSupportedServers,
} from "./mcp-link/registry.js";

export { BimBaseLink } from "./mcp-link/links/bimbase.js";

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
