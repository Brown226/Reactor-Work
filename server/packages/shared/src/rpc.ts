/**
 * Reactor RPC 契约（对齐 pi-web `lib/rpc-manager.ts` 命令面）
 *
 * 数据面：sidecar 的 stdio 上跑 JSON-RPC 2.0 风格帧；**stdout 只出协议帧**，
 * 任何应用日志一律走 stderr（保证帧流可被对端无歧义解析，M0-A1 验收）。
 * 帧类型：请求（带 id）/ 响应（成功或错误）/ 事件（无 id，服务端主动推送）。
 */

import type { SessionType } from "./session.js";
import type { LocalModelProvider, LocalModelsProbeParams, McpServerEntry } from "./management.js";

// ---------------------------------------------------------------------------
// 帧协议
// ---------------------------------------------------------------------------

export interface RpcRequestFrame {
  jsonrpc: "2.0";
  id: number | string;
  method: RpcMethod;
  params?: RpcParams;
}

export interface RpcSuccessFrame {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface RpcErrorFrame {
  jsonrpc: "2.0";
  id: number | string;
  error: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** 服务端（sidecar）主动推送的事件帧，无 id */
export interface RpcEventFrame {
  jsonrpc: "2.0";
  method: "session_event" | "server_status";
  params: SessionEvent | ServerStatus;
}

export type RpcFrame = RpcRequestFrame | RpcSuccessFrame | RpcErrorFrame | RpcEventFrame;

/** JSON-RPC 错误码约定（沿用 2.0 保留段 + Reactor 扩展段） */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** 扩展：preflight 校验未通过，命令不执行（M0-A3） */
  PreflightFailed: -32001,
  /** 扩展：审批被拒绝 / 策略 forbidden，命令终止 */
  ApprovalDenied: -32002,
  /** 扩展：服务尚未就绪（引擎启动中） */
  NotReady: -32003,
  /**
   * 扩展：并发冲突（W2-⑤）—— 典型是「文件保存的版本校验未通过」。
   * 与 InvalidParams 区分开：参数合法、环境也正常，只是**世界变了**（磁盘已被他人修改）。
   */
  Conflict: -32004,
} as const;
export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

// ---------------------------------------------------------------------------
// 命令全集（对齐 pi-web rpc-manager `send()` switch；M0-A3 逐个落地处理）
// ---------------------------------------------------------------------------

export const RPC_METHODS = [
  "ping",
  // Reactor 控制面扩展（pi-web 用 REST 创建会话，Reactor 纯 RPC 需显式创建/列表）：
  "new_session",
  /**
   * 预热会话引擎（2026-09-21）：只为把「装配成本」提前到用户还在读界面的时间。
   * 为什么需要它：首次在某个工作空间建会话要 **≈9–12s**（Pi 的资源加载器每次重新编译
   * 8 个受信任扩展包的 .ts 源码，且其扩展缓存在 cwd 变化时被清空 —— 实测见
   * t207 诊断与我方实施记录）。**不产生会话文件、不注册会话**：只跑一次服务装配，
   * 把扩展模块缓存对该 cwd 填好，之后用户真的发消息时几乎瞬间建好。
   * best-effort：失败只回 { ok:false }，绝不影响任何正常流程。
   */
  "warm_engine",
  "list_sessions",
  "open_session",
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "abort_bash",
  "bash",
  "get_state",
  "get_tools",
  "get_commands",
  // T-A1：dsh ui-goal 移植的数据面（goal 只读快照 / 扩展命令非模型执行）
  "goal_snapshot",
  "goal_command",
  // W5-③：长任务沉淀候选（只读；投递方式待拍板）
  "get_sediment_candidate",
  // W6-④/AD-2：浏览器宿主调用回执（**只允许主进程**调用，故登记进 NON_IPC_METHODS）
  "host_reply",
  "get_session_stats",
  "get_last_assistant_text",
  "set_model",
  "list_models",
  "set_thinking_level",
  "set_auto_compaction",
  "compact",
  "clear_queue",
  // Reactor 控制面扩展（M0-C3 审批回路）：
  "approval_response", // 审批裁决回传（H2 审批卡 → sidecar）
  "set_policy_mode", // 切换审批档位（M7-03；天花板约束为 M1）
  "fork",
  "navigate_tree",
  "get_branch_tree",
  "clone_session",
  "reload",
  // 会话管理（清单 #7/#8）：早期「删除/重命名会话」完全没有 —— 既无 RPC 也无 UI
  "rename_session",
  "auto_name_session",
  "delete_session",
  // 会话全文搜索（清单 #14）
  "search_sessions",
  // 历史思考按需加载（清单 #40）：回放仅带预览，展开时取全文
  "get_thinking",
  "extension_ui_response",
  "extension_ui_input",
  "get_entries",
  // Wave6 文件访问（FileExplorer/FileViewer 后端）：
  "list_dir",
  "read_file",
  // 文件树搜索（清单 #67）：服务端递归，不受已展开节点限制
  "search_files",
  // 文件上传（清单 #76）：冲突策略 error/overwrite/skip
  "upload_files",
  // 文件树 CRUD（3.1b）：新建/改名/删除，全部过 PolicyEngine 闸门
  "fs_write_file",
  "fs_mkdir",
  "fs_rename",
  "fs_delete",
  // Git 状态角标（清单 #70）：文件树圆点数据源
  "git_status_files",
  // Git 结构化只读（路线图 3.2）：状态 / 单文件 diff / 历史
  "git_status",
  "git_diff",
  "git_log",
  // 端侧审计上报（G0 断链的客户端半边）：采集/裁剪在 sidecar，HTTP 与令牌在主进程
  // （见 client/electron/rpc-allowlist.ts 的 NON_IPC_METHODS：两者都只允许主进程调用）
  "audit_peek_batch",
  "audit_ack_batch",
  // 技能使用量（与审计同款边界：采集在 sidecar、HTTP 与令牌在主进程）
  "usage_peek_batch",
  "usage_ack_batch",
  // 真终端 PTY（清单 #80）：长期存活 shell + 双向实时字节流
  "terminal_create",
  "terminal_write",
  "terminal_resize",
  "terminal_close",
  "terminal_list",
  // M4 管理面（T4.1 记忆 CRUD / T4.2 MCP 服务器配置）：
  "memory_list",
  "memory_entry_add",
  "memory_entry_update",
  "memory_entry_delete",
  "mcp_config_get",
  "mcp_config_set",
  // 开发者模式：本地模型直连（用户自己的上游，绕过网关；见 management.ts 的治理红线）
  "local_models_get",
  "local_models_set",
  "local_models_probe",
  // KB-④ 知识库管理面（个人库；渲染层只经这几个方法访问，个人库不出端）：
  "kb_datasets",
  "kb_documents",
  "kb_add_document",
  "kb_set_mounts",
  // Reactor 控制面扩展（pi-web 无此命令：浏览器端由页面驱动，桌面端需受控关停）：
  "shutdown",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

/** 各命令的入参（类型契约随 M0-A3 细化，此处先建骨架） */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

/** 图片附件（pi-ai image content block 的线上形态；data 为不带前缀 base64） */
export interface RpcImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** 可选模型（sidecar list_models 返回，来自 pi ModelRuntime.getAvailable） */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  /**
   * 该模型支持的输入模态（pi `Model.input`）。清单 #49：
   * 不含 "image" 的模型在附加图片时需告警（早期静默发送，用户以为生效）。
   */
  input?: Array<"text" | "image">;
}

/**
 * 渲染层收到的扩展 UI 请求载荷（迁移清单 M2/T2.1；sidecar ExtensionUiBridge 经
 * session_event(type=extension_ui_request) 推送，data 即本类型）。
 * method 为阻塞四类之外的即单向通知（notify/setStatus/setWidget/setTitle/set_editor_text）。
 */
export interface ExtensionUiRequestData {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | (string & {});
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
}

export interface RpcParams {
  ping?: { nonce?: string };
  new_session?: {
    cwd: string;
    type?: SessionType;
    name?: string;
    /** Agent 数字人（A-4）：技能白名单（空/缺省 = 不限制） */
    agentSkills?: string[];
    /** Agent 数字人（A-4）：追加到系统提示的人设 */
    agentPersona?: string;
    /** 专家徽标（D3）：建会话时绑定的专家名，落 JSONL 自定义条目供列表读回 */
    agentName?: string;
  };
  /** 预热：cwd 必填（引擎的扩展缓存按 cwd 分桶）；type 只影响内联工厂，可省 */
  warm_engine?: { cwd: string; type?: SessionType };
  list_sessions?: { since?: number };
  list_dir?: { sessionId: string; path?: string };
  read_file?: { sessionId: string; path: string };
  search_files?: { sessionId: string; query: string };
  upload_files?: {
    sessionId: string;
    dir: string;
    /** base64 编码的文件内容 */
    files: Array<{ name: string; data: string }>;
    strategy?: "error" | "overwrite" | "skip";
  };
  /**
   * 文件树 CRUD（3.1b，决策：写盘/删盘**都过 PolicyEngine 闸门**；删除不可逆、无回收站）。
   * 白名单用**非 exists 版**判定（新建目标本就不存在）；新建要求父目录已存在且不做 recursive mkdir。
   * 冲突类失败返回结构化 `{ ok:false, code }`（exists/parent_missing/…），越界则直接拒绝。
   */
  /**
   * 写文件。
   *
   * `ifVersion`（W2-⑤，可选）：带版本校验的条件写（乐观并发）。
   * 调用方从读接口拿到 `version`（`size-mtimeMs`）原样回传；磁盘已变则拒绝（`file_changed`）且**零字节写入**。
   * 不传 = 无条件写（上传/首次写新文件）。
   */
  fs_write_file?: { sessionId: string; path: string; content: string; overwrite?: boolean; ifVersion?: string };
  fs_mkdir?: { sessionId: string; path: string };
  fs_rename?: { sessionId: string; from: string; to: string };
  fs_delete?: { sessionId: string; path: string };
  git_status_files?: { sessionId: string };
  /**
   * Git 结构化只读（路线图 3.2）。语义对齐 pi-web `lib/git-status.ts` / `lib/git-changes.ts`：
   *  - `git_status`：porcelain v1 `-z --untracked-files=all`（目录内新文件逐个列出），
   *    含 index/worktree 分栏、rename 原路径与分类后的状态码；
   *  - `git_diff`：单文件 unified patch（未跟踪文件由 sidecar 合成 added patch；
   *    二进制/超大文件返回 `supported:false` 而不是 报错）；
   *  - `git_log`：最近提交（hash/短 hash/作者/ISO 时间/标题）。
   */
  git_status?: { sessionId: string };
  git_diff?: { sessionId: string; path: string };
  git_log?: { sessionId: string; limit?: number };
  /**
   * 端侧审计上报（G0，混合架构）：身份令牌**只落主进程**，故 sidecar 只提供
   * 「取一批待发事件 + 确认已发」两个原语，HTTP 由主进程发起。
   *  - `audit_peek_batch`：读取（**不移除**）最多 limit 条待发事件 —— 崩溃后重发由服务端按 eventId 判重；
   *  - `audit_ack_batch`：把已处理（accepted/duplicates/rejected）的 eventId 移出 outbox。
   */
  audit_peek_batch?: { limit?: number };
  audit_ack_batch?: { eventIds: string[] };
  /** 技能使用量 outbox（同审计：peek 读而不删，ack 确认后移除，服务端按 (skill,session) 幂等） */
  usage_peek_batch?: { limit?: number };
  usage_ack_batch?: { eventIds: string[] };
  /**
   * 真终端 PTY（清单 #80）。
   *
   * `terminal_create` 的 `id` 由客户端提供并在重连时复用（对齐 pi-web
   * `createTerminal(cwd, cols, rows, id)`）——这样刷新/切面板后能接回**同一个**
   * 存活 shell，而不是新开一个（真终端的核心价值）。
   *
   * `after`（0.7）：客户端已收到的累计字节 offset —— 提供时按**增量**回放 backlog
   * （响应里的 `backlog.reset=false`），缺省/越界则整块重放（`reset=true`）。
   */
  terminal_create?: { sessionId: string; id: string; cwd?: string; cols?: number; rows?: number; after?: number };
  terminal_write?: { sessionId: string; id: string; data: string };
  terminal_resize?: { sessionId: string; id: string; cols: number; rows: number };
  terminal_close?: { sessionId: string; id: string };
  terminal_list?: { sessionId: string };
  open_session?: { sessionId: string };
  prompt?: { sessionId: string; prompt: string; parentEntryId?: string; images?: RpcImage[]; /**
   * 内核并发语义：流式中按此入队（steer/followUp），空闲则开新回合。
   * 客户端应**总是**传它并调 prompt，而不是自行判断后改调 steer/follow_up ——
   * 后者存在竞态，会把消息永久搁浅在空闲队列里（清单 #52）。
   */ streamingBehavior?: "steer" | "followUp" };
  steer?: { sessionId: string; prompt: string; images?: RpcImage[] };
  follow_up?: { sessionId: string; prompt: string; images?: RpcImage[] };
  abort?: { sessionId: string };
  abort_bash?: { sessionId: string };
  bash?: { sessionId: string; command: string; cwd?: string; /** `!!` 前缀（同步清单 #94）：true 时不进模型上下文 */ excludeFromContext?: boolean };
  get_state?: { sessionId: string };
  get_tools?: { sessionId: string };
  get_commands?: { sessionId: string };
  /**
   * T-A1：读取 pi-goal-x 当前 goal 结构化快照。
   * sidecar 调用扩展注册的 `get_goal` 工具定义（不经过模型），返回其 `details`
   * （GoalStateEntry v3），客户端按既有 `harvestExtWidgets` 口径归并。
   */
  goal_snapshot?: { sessionId: string };
  /**
   * T-A1：执行一条扩展斜杠命令并回读 goal 快照。
   * `command` 为完整命令行（如 `/goal-pause`）；命令经 pi 的扩展命令派发，
   * **不产生 user 消息、不启动模型回合**。返回命令结束后的 goal details。
   */
  goal_command?: { sessionId: string; command: string };
  /**
   * W5-③：取该会话的长任务沉淀候选（判断 + 浓缩 + 现成 prompt）；无则 `candidate: null`。
   * **只读**：投递方式（注入对话 / 派发子会话 / UI 提示）尚未拍板。
   */
  get_sediment_candidate?: { sessionId: string };
  /** AD-2：主进程对 sidecar `host_call` 的回执（id 必须与请求一致） */
  host_reply?: { id: string; ok: boolean; result?: unknown; error?: string };
  get_session_stats?: { sessionId: string };
  get_last_assistant_text?: { sessionId: string };
  set_model?: { sessionId: string; provider: string; modelId: string };
  list_models?: { sessionId: string };
  set_thinking_level?: { sessionId: string; level: string };
  set_auto_compaction?: { sessionId: string; enabled: boolean };
  compact?: { sessionId: string; customInstructions?: string };
  clear_queue?: { sessionId: string };
  // M0-C3 审批回路：
  approval_response?: {
    sessionId: string;
    requestId: string;
    decision: ApprovalDecision;
    /** 本次会话后续是否记住（true=allow_session；false/缺省=仅本次） */
    remember?: boolean;
    /**
     * 审批同意令牌（T2.3 防伪造）：受信任方（Electron 主进程）用 runtimeToken 签发的
     * HMAC 令牌，绑定 requestId + 生效裁决 + 有效期 + nonce（单次使用）。
     * 主进程注入 REACTOR_RUNTIME_TOKEN 时必填；未注入（开发/脚本）时不校验。
     */
    consentToken?: string;
  };
  set_policy_mode?: { sessionId: string; mode: ApprovalMode };
  rename_session?: { sessionId: string; name: string };
  auto_name_session?: { sessionId: string };
  delete_session?: { sessionId: string };
  search_sessions?: { query: string };
  get_thinking?: { sessionId: string; entryId: string; blockIndex: number };
  fork?: { sessionId: string; entryId: string };
  navigate_tree?: { sessionId: string; targetId: string };
  get_branch_tree?: { sessionId: string };
  clone_session?: { sessionId: string; leafId?: string };
  reload?: { sessionId: string };
  extension_ui_response?: { sessionId: string; id: string; value?: string; confirmed?: boolean; cancelled?: boolean };
  extension_ui_input?: { sessionId: string; id: string; data: string };
  /**
   * 分页（清单 #42）：`before` = 排除式条目索引上界（即「取该索引之前」的更早条目），
   * `limit` = 最多返回条数。两者皆缺省时行为不变（返回最新 limit=500 条）。
   * 早期硬截 `slice(-500)` 且客户端从不请求更多 → >500 条会话的中段永远不可达。
   */
  get_entries?: { sessionId: string; since?: number; before?: number; limit?: number };
  shutdown?: { reason?: string };

  // ---- M4 管理面（T4.1 hermes-memory / T4.2 mcp-adapter） ----
  memory_list?: Record<string, never>;
  memory_entry_add?: { path: string; text: string };
  memory_entry_update?: { path: string; index: number; text: string };
  memory_entry_delete?: { path: string; index: number };
  mcp_config_get?: Record<string, never>;
  mcp_config_set?: { mcpServers: Record<string, McpServerEntry> };

  // ---- 开发者模式：本地模型直连 ----
  local_models_get?: Record<string, never>;
  local_models_set?: { providers: LocalModelProvider[] };
  local_models_probe?: LocalModelsProbeParams;
}

// ---------------------------------------------------------------------------
// 事件与状态（数据面推送）
// ---------------------------------------------------------------------------

/**
 * 实际线上事件（sidecar 事件桥透传 pi AgentSessionEvent 原名 + Reactor 自有事件）。
 * 注意：与早期 S2 草案名（message_partial/tool_call...）不同，以 pi 原名为准。
 */
export type SessionEventType =
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "tool_approval_request" // M0-H2 审批卡推送
  | "queue_update" // 清单 #50：steering/followUp 全量快照（入队与**消费**都发）
  | "state_changed"
  | "session_created"
  | "session_removed"
  | (string & {}); // pi 扩展事件透传（bash_execution_update 等）

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  /** 事件序号，供 `get_entries since=` 断线补状态（M0-A3） */
  seq: number;
  ts: number;
  data?: unknown;
}

export type ServerStatusPhase =
  | "booting"
  | "ready"
  | "busy"
  | "degraded"
  | "shutting_down"
  | "crashed";

/** 壳（Tauri）监听的生命周期状态；崩溃后壳自动重启并透传（M0-A1） */
export interface ServerStatus {
  phase: ServerStatusPhase;
  pid?: number;
  startedAt?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// M0-C3 审批（数据面会话事件 tool_approval_request 的载荷 + 裁决类型）
// ---------------------------------------------------------------------------

/** 审批裁决（H2 审批卡回传 / registry 决议） */
export type ApprovalDecision = "allow" | "deny" | "allow_session";

/**
 * 访问模式（对齐 deepseek-harness `permission-presets`，替代 BRD 原「审批三档」口径）。
 *
 * 每档 = 沙箱范围 × 审批策略 的组合：
 *  - readonly  仅可查看     ：读放行；写文件与执行命令**硬拦**（不走审批）
 *  - balanced  工作区内修改 ：工作区内文件写放行；危险命令弹审批
 *  - trust     完全权限     ：全放行；黑名单与越界路径仍硬拦（策略先于模式）
 *  - strict    严格（组织侧，UI 不暴露为首选三档）：写文件与一切命令都弹审批，永不记住
 */
export type ApprovalMode = "readonly" | "balanced" | "trust" | "strict";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["readonly", "balanced", "trust", "strict"];

/** 面向用户的三档访问模式（dsh 口径；strict 为组织侧更严档，不在首选三档内） */
export const ACCESS_MODES: readonly ApprovalMode[] = ["readonly", "balanced", "trust"];

/** 审批请求触发原因（挂起推送时给 UI 展示） */
export type ApprovalAskReason = "high_risk_command" | "write_strict" | "shell_strict";

/** tool_approval_request 事件载荷（H2 审批卡数据源） */
export interface ToolApprovalRequestData {
  /** 会话级唯一 requestId，approval_response 原样回传 */
  requestId: string;
  sessionId: string;
  toolName: string;
  /** bash/powershell 命令文本 */
  command?: string;
  /** 文件工具目标路径 */
  path?: string;
  reason: ApprovalAskReason;
  /** 面向用户的展示文案 */
  detail: string;
  ts: number;
}
