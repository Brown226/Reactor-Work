/**
 * M4 管理面契约（T4.1 hermes-memory 记录管理 / T4.2 mcp-adapter 服务器管理）。
 *
 * 数据面：
 *  - 记忆 = agentDir/pi-hermes-memory/{MEMORY,USER,failures}.md + agentDir/projects-memory 下各项目的 MEMORY.md，
 *    条目以 `\n§\n` 分隔，末尾 `<!-- created=YYYY-MM-DD, last=YYYY-MM-DD -->` 元数据。
 *    hermes MemoryStore 对外部编辑有冲突自愈（重读+重试），管理面直改文件安全；
 *    写入走原子替换（tmp + rename 同目录）。
 *  - MCP = agentDir/mcp.json（pi-mcp-adapter getPiGlobalConfigPath），形状 McpConfig：
 *    { mcpServers: Record<name, ServerEntry>, settings?, imports? }。
 *    配置变更对新会话生效（服务器连接为会话级生命周期）。
 */

// ---------------------------------------------------------------------------
// T4.1 记忆
// ---------------------------------------------------------------------------

export type MemoryTargetKind = "memory" | "user" | "failure" | "project";

export interface MemoryEntryMeta {
  /** 条目在文件内的序号（0 起，删除/更新操作按此寻址） */
  index: number;
  /** 条目正文（已剥除末尾元数据注释） */
  text: string;
  created?: string;
  last?: string;
}

export interface MemoryFileState {
  /** 绝对路径（增删改按此寻址，sidecar 校验必须在 agentDir 内） */
  path: string;
  kind: MemoryTargetKind;
  /** 展示名：全局三份用固定名，项目记忆用项目目录名 */
  label: string;
  entries: MemoryEntryMeta[];
  /** 单文件读取失败时不阻断整体列出（如被锁），错误放这里 */
  error?: string;
}

export interface MemoryListResult {
  agentDir: string;
  files: MemoryFileState[];
}

// ---------------------------------------------------------------------------
// T4.2 MCP 服务器
// ---------------------------------------------------------------------------

/** pi-mcp-adapter ServerEntry 的管理面子集（透传未知字段） */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  cwd?: string;
  socket?: string;
  [key: string]: unknown;
}

export interface McpConfigState {
  path: string;
  exists: boolean;
  mcpServers: Record<string, McpServerEntry>;
}

// ── 知识库管理面（KB-④）────────────────────────────────────────────
// 渲染层只经这些 RPC 访问个人库：库列表 / 文档清单 / 入库 / 挂载集。
// 个人库**不出端**（红线）：这些方法只读写 `<agentHome>/kb/personal/`。
// 部门/全员库（公共库）在 KB-⑥ 经服务端接口接入，不在这里伪装成可用。

/** 一个可查库的摘要（界面列表用） */
export interface KbDatasetSummary {
  id: string;
  name: string;
  createdAt: number;
  /** 来源：现在只有 personal（部门/全员待服务端） */
  source: "personal" | "department" | "org";
  /** 是否在本次挂载集内（挂载 = 检索默认范围） */
  mounted: boolean;
  docs: number;
  segments: number;
  chars: number;
}

export interface KbDatasetListResult {
  agentDir: string;
  datasets: KbDatasetSummary[];
  /** 当前挂载的库 id（空 = 默认检索全部可读库） */
  mounted: string[];
}

/** 库内一篇文档的摘要 */
export interface KbDocumentSummary {
  docId: string;
  name: string;
  segments: number;
  chars: number;
  /** 入库时间（老文件取不到则为 0，不编造） */
  addedAt: number;
}

export interface KbDocumentListResult {
  datasetId: string;
  documents: KbDocumentSummary[];
}

export interface KbAddDocumentParams {
  /** 目标库 id（省略则用/建 datasetName 指定的库） */
  datasetId?: string;
  /** 库名（datasetId 省略时用；再省略则用默认库「我的知识库」） */
  datasetName?: string;
  docName: string;
  content: string;
}

export interface KbAddDocumentResult {
  ok: boolean;
  /** 失败原因（ok=false 时给出**可读**原因，不回退成静默成功） */
  reason?: string;
  datasetId?: string;
  datasetName?: string;
  docId?: string;
  segments?: number;
}

export interface KbSetMountsResult {
  /** 实际生效的挂载集（已与现存库求交，非法/不存在的 id 被剔除） */
  mounted: string[];
}

// ── 本地模型直连（开发者模式）────────────────────────────────────────
/**
 * 开发者模式专属：把**用户自己的上游**直连注册进 Pi，绕过 Reactor 网关。
 *
 * ## 为什么在「管理面」而不是「网关契约」里
 *
 * 它是**纯端侧本地**能力：配置落在 `<agentHome>/local-models.json`（`REACTOR_AGENT_ROOT`
 * 按登录 uid 分家），服务端与网关完全不参与，**也不上报** —— 这些密钥是用户个人的，
 * 不是平台下发的凭据，服务端没有理由知道。
 *
 * ## ⚠️ 治理红线（写在契约层，因为这是最容易忘记的一条）
 *
 * 直连**不经网关** ⇒ 同时失去三样东西：
 *   ① 模型白名单（管理台板块治理：哪些模型可用）
 *   ② 审计与用量上报（G0/M7 数据面：调了哪个模型、花了多少）
 *   ③ 出网白名单（M7-06）
 * 因此它被「连续点击版本号 7 下」开发者模式锁住，且开关状态按账号持久化。
 * **界面必须把这三条如实告诉用户**，不能只写一句「开发者模式」了事。
 */

/** 直连协议（与 Pi 的 KnownApi 子集对齐，取值同 `agent/gateway-provider.ts` 的 GatewayApi） */
export type LocalModelApi = "openai-completions" | "anthropic-messages";

/** 一个直连模型。四个字段就是「精简可用」的全部：够跑起来，够填出正确的窗口。 */
export interface LocalModelSpec {
  /** 上游真实的模型 id（如 `qwen3:32b` / `deepseek-chat`） */
  id: string;
  /** 显示名（缺省用 id） */
  name?: string;
  /** 上下文窗口（缺省按保守兜底 128k；填错会被上游 400，见 gateway-provider 的教训） */
  contextWindow?: number;
  /** 单次最大输出（缺省 16k） */
  maxTokens?: number;
}

/** 一个直连供应商 = Pi 里一个 provider（模型选择器按它分组） */
export interface LocalModelProvider {
  /**
   * Pi provider id（必填、在配置内唯一）。
   * ⚠ 与网关 provider 同名（管理台 `ai_providers.code`）时会**覆盖**网关那一组 ——
   * 这是用户的显式选择，但界面要用「已被占用」提示拦一下。
   */
  id: string;
  /** 展示名（缺省 = id） */
  name?: string;
  /** 上游根地址（openai 协议可带或不带 `/v1`，sidecar 归一） */
  baseUrl: string;
  /** 上游密钥（明文落盘：这是开发者模式，见文件头红线） */
  apiKey: string;
  api: LocalModelApi;
  /** 至少一个：没有模型的 provider 在 Pi 里等于不存在 */
  models: LocalModelSpec[];
}

/** 配置读取结果（`exists=false` 时 `providers` 为空数组，不是错误） */
export interface LocalModelsState {
  /** 配置文件绝对路径（界面要展示，用户可能直接手改） */
  path: string;
  exists: boolean;
  providers: LocalModelProvider[];
}

/**
 * 探测模式：
 *  - `discover`：打 `<baseUrl>/models` 拉模型目录（大部分上游的 `/v1/models`）。不发对话。
 *  - `chat`：真发一次最小对话（`max_tokens: 1`）**验密钥** —— 因为不少上游的
 *    `/v1/models` 不需要鉴权，只拉目录会「看起来通了、其实密钥是错的」。
 *    会消耗极少 token，所以它是独立按钮，不在保存时自动跑。
 */
export type LocalModelsProbeMode = "discover" | "chat";

export interface LocalModelsProbeResult {
  ok: boolean;
  /** discover 拿到的模型 id 列表（chat 模式为空数组） */
  models: string[];
  /** 人类可读结论（成功与失败都给，界面直接显示，不做二次翻译） */
  message: string;
}

/** `local_models_probe` 入参：只用表单当前值探（**不要求先保存**） */
export interface LocalModelsProbeParams {
  baseUrl: string;
  apiKey: string;
  api: LocalModelApi;
  mode: LocalModelsProbeMode;
  /** chat 模式要指定用哪个模型打（默认取表单里第一个） */
  modelId?: string;
}
