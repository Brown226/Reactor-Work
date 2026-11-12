/**
 * Reactor 工具 schema（BRD M4/M7；与工具注册/信任分类单一事实源对齐）
 */

import type { SessionType } from "./session.js";

/**
 * 工具分类与信任边界（单一事实源）—— W0-1。
 *
 * 为什么把分类放在 shared 而不是散在 `policy/approval.ts`：
 * 修前 `toolset.ts` 的工具注册表与 `approval.ts` 的 `READ_TOOLS/WRITE_TOOLS/SHELL_TOOLS`
 * 是**两张各自维护的表**，没有任何机制强制对齐 —— 新增工具只要漏登记，
 * `classifyTool()` 就返回 `other`，而 `gate()` 曾对 `other` **无条件放行**，
 * 于是 readonly 会话也能越权落盘（`md_to_docx` 已真实踩过一次）。
 * 现在分类**内联在工具声明里**，并在注册时做双向覆盖校验（fail-fast）。
 *
 * 设计原则（照抄 penguin）：「注解是**未受信 hint**，缺省取**限制方向**」。
 * 因此未知工具不是放行、也不是静默，而是**显式拒绝并点名**，由开发者补登记。
 */

/**
 * 工具信任类别（决定过哪一道闸门）：
 *  - `read`  ：只读；路径必须落工作区白名单内，越界硬拦；各档位均放行。
 *  - `write` ：写盘；readonly 硬拦，balanced/trust 放行，strict 弹审批。
 *  - `shell` ：命令执行；过黑名单→风险分级→审批。
 *  - `other` ：**未分类**；与「无需治理的工具」不是一回事，见 `classifyTool`。
 */
export type ToolClass = "read" | "write" | "shell" | "other";

/** 一个受治理工具的声明（与 ToolSpec 同源，供政策层消费） */
export interface ToolClassDecl {
  /** 信任类别 */
  class: Exclude<ToolClass, "other">;
  /**
   * 写类工具里承载**输出路径**的参数名（缺省 `path`）。
   * 不声明就会拿不到路径 → 白名单校验退化成「不校验」（`md_to_docx` 用 `filename`）。
   */
  writePathParam?: string;
  /**
   * 该工具的路径由**工具内部**对自有的根集合校验（如技能根），**不走工作区白名单**。
   *
   * 为什么需要：技能目录在 `<userData>/skills` 下，本就不是工作区根 —— 不声明的话
   * `gateFs` 会拿 `params.path` 去比工作区白名单并**必然拒绝**（技能类读取工具直接不可用）。
   *
   * ⚠️ 声明它等于把路径安全**完全托付给工具实现**，因此实现必须复用唯一安全实现
   * `isPathWithinRoots`（见 `packages/sidecar/src/fs/boundary.ts`），不得自己拼字符串判断。
   */
  selfValidatedPath?: boolean;
}

/**
 * 受治理工具分类表（**唯一事实源**）。
 *
 * 约束：这里登记的名字必须与 `SESSION_TOOL_PRESETS` / `CODING_TOOL_NAMES` 的工具名一致；
 * 一致性由 `packages/sidecar/scripts/tool-class-smoke.ts` 与 `toolset.ts` 的启动校验双向保证。
 */
export const TOOL_CLASSES: Readonly<Record<string, ToolClassDecl>> = {
  // —— Pi SDK 内置编码工具（create*ToolDefinition 工厂）——
  read: { class: "read" },
  grep: { class: "read" },
  find: { class: "read" },
  ls: { class: "read" },
  write: { class: "write" },
  edit: { class: "write" },
  bash: { class: "shell" },
  powershell: { class: "shell" },
  // —— 办公工具（M0-G1 / M3）——
  read_office: { class: "read" },
  // W5-④ L2：按需读取技能正文 + 参考件（只读；自己枚举技能目录，不接受调用方给路径）
  skill_read: { class: "read" },
  // D4：渲染 UI 面板（不写盘、不执行命令，只把结构化载荷交给前端渲染）
  emit_ui_tree: { class: "read" },
  // W6-④：内置浏览器的只读工具（导航/标签/页内查找/缩放）。
  // ⚠️ 只登记**只读**这一批；`act`/`eval`/`route`/`resource.download` 等会改变远端状态的动作
  // 属 write 类，必须过审批链后再登记（见 docs/实施计划/内置浏览器-移植方案.md §7）。
  browser_tabs: { class: "read" },
  browser_open: { class: "read" },
  browser_nav: { class: "read" },
  browser_find: { class: "read" },
  browser_zoom: { class: "read" },
  browser_read: { class: "read" },
  browser_screenshot: { class: "read" },
  browser_html: { class: "read" },
  browser_snapshot: { class: "read" },
  // ★ browser_act 是**写类**：会改变远端页面状态（点击/提交/输入）⇒ 必须过审批四链。
  // 这条分类就是「治理」的接入点：改成 read 等于绕过审批（有探针反证守住）。
  browser_act: { class: "write" },
  // ② 产物类：会写本地文件 ⇒ write 类（过审批）。filename 是**建议名**，
  // 主进程侧只取单段名（防路径穿越）—— writePathParam 让治理层知道哪个参数影响落盘路径。
  browser_print: { class: "write", writePathParam: "filename" },
  browser_download: { class: "write", writePathParam: "filename" },
  // D4 第三刀：面板导出为 docx（**写类**：产物落工作区，走 fs 门禁；输出路径参数是 filename）
  ui_to_docx: { class: "write", writePathParam: "filename" },
  md_to_docx: { class: "write", writePathParam: "filename" },
  // 技能类工具：路径由工具内部对**技能根**校验（技能在 userData 下，不是工作区根），
  // 故声明 selfValidatedPath；实现复用唯一安全实现 isPathWithinRoots，不自行拼字符串。
  // 为什么需要它：`references/` 可达 85 万字符，L2 打包预算最多装约 10%（见 skill_read 的预算常量），
  // 且通用 `read` 会被工作区白名单拒 —— 复杂技能必须有「按路径精读」这一层（即设计里的 L3）。
  read_skill_resource: { class: "read", selfValidatedPath: true },
  // —— 知识库工具（KB-③）——
  // 前两个是 **read 类**：只读检索，不落盘、不改变任何状态。
  // ★ dataset_add_document 是 **write 类**：会写本地知识库真源（`<agentHome>/kb/personal/`）
  //   ⇒ 必须过审批四链。这条分类就是治理接入点：改成 read 等于绕过审批（有探针反证守住）。
  dataset_list: { class: "read" },
  dataset_search: { class: "read" },
  dataset_add_document: { class: "write" },
};

/** 需要过文件系统闸门的写类工具 → 输出路径参数名 */
export function writePathParamOf(toolName: string): string {
  return TOOL_CLASSES[toolName]?.writePathParam ?? "path";
}

/**
 * 该工具的路径是否由**工具内部**校验（因而跳过工作区白名单比对）。
 *
 * 只对声明了 `selfValidatedPath: true` 的工具返回 true；未登记的工具返回 false
 * （未分类会另在 `classifyToolClass` 处 fail-closed，不依赖本函数兜底）。
 */
export function isSelfValidatedPathTool(toolName: string): boolean {
  return TOOL_CLASSES[toolName]?.selfValidatedPath === true;
}

/**
 * 工具分类（查声明表）。
 *
 * ⚠️ 返回 `other` **不代表放行** —— 调用方（PolicyEngine.gate）必须按**限制方向**处理，
 * 并给出「未分类，请在 TOOL_CLASSES 登记」的可诊断错误。
 */
export function classifyToolClass(toolName: string): ToolClass {
  return TOOL_CLASSES[toolName]?.class ?? "other";
}

/** 未分类工具的拒绝文案（fail-closed；点名工具名以便一眼定位） */
export function unclassifiedToolReason(toolName: string): string {
  return `工具「${toolName}」未登记信任类别（未分类工具按限制方向处理）。请在 @reactor/shared 的 TOOL_CLASSES 登记其 read/write/shell 类别后重试。`;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema 参数定义 */
  parameters?: Record<string, unknown>;
}

/**
 * 会话场景 → 默认工具集（M0-B1 分型，FR-M2-02）。
 *
 * **场景决定默认工具集**，用户不手选工具预设 —— 后者是 pi-web 的机制，已在本仓移除
 * （审计：它会用 7 个 pi-web 内置工具覆写整个激活集，把办公/浏览器/技能工具全部踢出去）。
 *  - 代码开发 code：只读检索 + 命令 + 改文件
 *  - 日常办公 work 与 审查 general：**同一套**（见下方 `OFFICE_TOOLS`）
 *
 * 权限维度由「访问模式」（仅可查看/工作区内修改/完全权限）单独控制，与工具集**正交**：
 * readonly 档对写与命令硬拦（`approval.ts` 的 `decideWrite` / `gateShell`），与工具集无关。
 */
/**
 * 技能类工具（D4：先作为 work 意图，但**预留升格**为独立会话类型）。
 *
 * 抽成子数组的原因：预设里以 `...SKILL_TOOL_NAMES` 引用，日后要把技能/PPT 能力
 * 整块抽成独立会话类型时，只需把这一处引用挪走，不必在预设里逐项挑拣。
 */
export const SKILL_TOOL_NAMES: readonly string[] = ["read_skill_resource"];

/**
 * 知识库工具（KB-③）：个人库检索/入库（公共库在 KB-⑥ 接入同一个 `dataset_search`）。
 *
 * 抽成子数组的理由同 `SKILL_TOOL_NAMES`：日后要把知识库升格为独立能力块时只挪一处引用。
 *
 * **为什么只进 work/general、暂不进 code**：预设变更是**能力拓宽**，要单独举证。
 * 检索类工具本身是 read 类、风险低，但入库是写类；办公场景才是 BRD M6 的主要场景。
 * 若日后确认编码会话也要查库，把 `...KB_TOOL_NAMES` 加进 `CODING_TOOL_NAMES` 即可（一处）。
 */
export const KB_TOOL_NAMES: readonly string[] = ["dataset_list", "dataset_search", "dataset_add_document"];

/**
 * 日常办公（work）与审查（general）**共用**的工具集。
 *
 * 2026-09-18 决策：general 与 work 对齐 —— 它既是「审查」场景，也是 `sessionType` 的
 * **兜底值**（`registry.ts` 的 `?? "general"`）。不同步的话，同一个意图会因为
 * 「调用方有没有显式传 sessionType」而拿到不同能力，属于很难排查的静默差异。
 *
 * 历史：work 原先刻意**不注册** bash/write/edit（“办公不需要执行”）。该判断被实测推翻 ——
 * 按部门拆表、整理目录、批量改名、处理大文本都需要；而修前 work 的隔离是**注册级**的，
 * 连 `set_tools` 也无提升路径，用户被迫切到「代码开发」才能干活。
 *
 * ⚠️ 由此让出的两种保护（**部署前知情**）：
 *   ① `balanced` 档下「常规文件写自动放行」（`approval.ts` 的 `decideWrite`）⇒
 *      办公文档（合同/报表/花名册，且**没有 git 兜底**）可被模型静默改写；
 *   ② 命令执行只剩「黑名单 + 风险分级」，不再有「未注册 = 不存在」那层结构性拦截。
 * **仍然生效**：readonly 对写/命令硬拦、审计 Trace 全留痕、写路径过工作区白名单（FR-M7-01）、
 * 黑名单先于一切审批模式。← 这四条已由 `session-tools-smoke` 的行为断言钉住。
 */
const OFFICE_TOOLS: readonly string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  // M3 办公读取（路径过白名单门禁）/ M0-G1 办公导出（写产物仅限工作区根，工具内收敛）
  "read_office",
  "md_to_docx",
  "ui_to_docx",
  // W5-④ L1/L2：技能广告常驻 + 正文按需取；技能 L3：按路径精读技能内文件
  "skill_read",
  "emit_ui_tree",
  // W6 内置浏览器（只读导航 + 会产生远端副作用的动作；后者过审批四链）
  "browser_tabs",
  "browser_open",
  "browser_nav",
  "browser_find",
  "browser_zoom",
  "browser_read",
  "browser_act",
  "browser_screenshot",
  "browser_html",
  "browser_print",
  "browser_download",
  "browser_snapshot",
  // KB-③ 知识库（个人库本地检索/入库；写类那条过审批）
  ...KB_TOOL_NAMES,
  ...SKILL_TOOL_NAMES,
];

/**
 * 编码会话（code）的工具集 —— 「编码能力」的**唯一定义处**，各预设不得再散写这些名字。
 *
 * 含 `powershell`：非 Windows 平台在 `toolset.ts` 里过滤掉（与修前一致）。
 */
export const CODING_TOOL_NAMES: readonly string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "powershell",
  // W5-④：编码会话也需要读技能（与 work/general 一致）
  "skill_read",
  // D4：渲染 UI 面板（编码会话同样需要展示结构化结果）
  "emit_ui_tree",
];

/**
 * 会话类型 → 工具集。**本表是工具基线的唯一真源**：
 *  - `buildSessionToolSet` 的注册集直接取它（无 code 特判）；
 *  - registry 的默认激活集也直接取它（`defaultActiveTools`）。
 *
 * 修前这里对 code 写了一个只含 4 项的假值（`["read","bash","edit","write"]`），
 * 而实际 code 拿到的是 `CODING_TOOL_NAMES` 的 10 项 —— 因为注册与激活两处都**各自特判**了 code。
 * 那张假表从未被读取，却会误导任何读代码的人。现已收敛：同一件事只有一处定义。
 */
export const SESSION_TOOL_PRESETS: Record<SessionType, readonly string[]> = {
  code: CODING_TOOL_NAMES,
  work: OFFICE_TOOLS,
  general: OFFICE_TOOLS,
};

/**
 * 会话类型的**默认激活集**（与注册集同源；注册与激活分设两道是为了将来能独立演进）。
 *
 * 为什么 registry 必须**显式**把它传给 Pi：Pi 在只传 `customTools` 时的默认激活集是
 * **全部注册项**。不显式锁的话，「注册什么」会直接等于「模型能看见什么」，
 * 任何将来的注册拓宽都会静默变成能力升降。
 */
export function defaultActiveTools(type: SessionType): readonly string[] {
  return SESSION_TOOL_PRESETS[type];
}
