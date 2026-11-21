/**
 * 工程软件环境诊断的跨进程契约。
 *
 * 为什么单独放在 shared：services 侧的 `diagnose()` 依赖 node:fs / child_process /
 * Windows 注册表，只能从 Node 入口（`@zcode/services/node`）导出，renderer 无法加载。
 * 桌面端由 main 进程执行诊断、经 IPC 把结果交给 renderer 渲染，因此两边都需要一份
 * 不依赖 Node 内置模块的结构定义。
 */

/** 单项检查结果；与 services 侧 DiagnosticCheck 字段一一对应。 */
export interface EngineeringDiagnosticCheck {
  name: string;
  ok: boolean;
  /** 观察到的事实；失败时是「试了什么、看到什么」。 */
  detail: string;
  /** 建议动作；ok 时为空。 */
  suggestion?: string;
}

/** 环境自检报告；与 services 侧 DiagnosticReport 字段一一对应。 */
export interface EngineeringDiagnosticReport {
  healthy: boolean;
  checks: EngineeringDiagnosticCheck[];
  /** 当前已连接的软件。 */
  connected: string[];
  /** 已登记支持的软件。 */
  supported: string[];
}
