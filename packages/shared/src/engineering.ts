/**
 * 工程软件环境诊断与能力总览的跨进程契约。
 *
 * 为什么单独放在 shared：services 侧的 `diagnose()` 依赖 node:fs / child_process /
 * Windows 注册表，只能从 Node 入口（`@zcode/services/node`）导出，renderer 无法加载。
 * 桌面端由 main 进程执行诊断、经 IPC 把结果交给 renderer 渲染，因此两边都需要一份
 * 不依赖 Node 内置模块的结构定义。
 */

/**
 * 检查结果的分级。
 *
 * 为什么需要分级：登记的软件有十多个，普通用户最多装一两个，其余全部「未安装」。
 * 若只有布尔 `ok`，未安装会和真正的探测失败一样渲染成红色故障，第一屏看起来像
 * 环境坏了。missing = 本机没装（正常态，灰色信息），error = 装了但探测失败或
 * 环境不满足（需要处理）。
 */
export type EngineeringCheckLevel = "ok" | "missing" | "error";

/** 单项检查结果；与 services 侧 DiagnosticCheck 字段一一对应。 */
export interface EngineeringDiagnosticCheck {
  name: string;
  ok: boolean;
  /** 分级；缺省时按 `ok` 推导，保留字段可选以兼容旧宿主。 */
  level?: EngineeringCheckLevel;
  /** 观察到的事实；失败时是「试了什么、看到什么」。 */
  detail: string;
  /** 建议动作；ok 时为空。 */
  suggestion?: string;
}

/**
 * 一个软件的能力条目。
 *
 * 回答的不是「环境有没有问题」，而是「这台机器上我能用它做什么」：
 * 能调用多少函数、走什么接口、技能包在哪、可以怎么开口。
 */
export interface EngineeringCapability {
  /** 连接层的 server name，如 `tekla`。 */
  server: string;
  /** 展示名，如 `Tekla Structures`。 */
  productName: string;
  /** 接口类型的中文标签：MCP / COM / .NET / 本地 HTTP API / Ruby 插件 / 自带 Python。 */
  bridge: string;
  /** 是否已在本机定位到安装位置。 */
  installed: boolean;
  /** 已定位到的可执行文件路径。 */
  exePath?: string;
  /** 本地 API 目录里的可调用函数数；0 表示没有目录或走 MCP 工具。 */
  functionCount: number;
  /** 对应技能包目录名，如 `Tekla-Link`。 */
  skillDir?: string;
  /** 一句示例用法，帮助用户知道怎么开口。 */
  hint?: string;
}

/** 环境自检报告；与 services 侧 DiagnosticReport 字段一一对应。 */
export interface EngineeringDiagnosticReport {
  healthy: boolean;
  checks: EngineeringDiagnosticCheck[];
  /** 当前已连接的软件。 */
  connected: string[];
  /** 已登记支持的软件。 */
  supported: string[];
  /** 能力总览：每个登记软件能做什么。 */
  capabilities: EngineeringCapability[];
}
