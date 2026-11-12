/**
 * 拖拽/选择的文件 → 用户空间的桥（仅 Web 宿主注册）。
 *
 * 为什么不把 spaceClient 直接 import 进 composer：composer 是平台无关的共享层，
 * 「空间」是 Web 的领域概念。桌面端不注册桥，hook 自动回落到本地路径零复制 /
 * 内联字节上传的原有链路，两端行为由注册与否决定，不出现平台分支散落。
 *
 * 为什么走空间而不是会话附件暂存：暂存区随会话消亡，下一条对话引用不到，
 * 用户在「我的空间」里也看不见；落到工作区（web 登录后必在用户空间内）后，
 * 配额、回收站、版本、搜索全部复用，agent 以路径直接读。
 */

export interface WorkspaceFileUploadRequest {
  file: File;
  /** 附件 chip 所在 composer 的工作区绝对路径。 */
  workspacePath: string;
  /** 0–100，映射到附件 chip 的进度条。 */
  onProgress: (percent: number) => void;
  signal: AbortSignal;
}

export interface WorkspaceFileUploadBridge {
  /**
   * 上传到 `<workspacePath>/对话附件/`，解析为该文件的工作区绝对路径。
   * 同名冲突由服务端加 (n) 后缀防覆盖，返回前必须用服务端回传的最终名拼路径。
   */
  upload(request: WorkspaceFileUploadRequest): Promise<string>;
}

let bridge: WorkspaceFileUploadBridge | null = null;

export function setWorkspaceFileUploadBridge(next: WorkspaceFileUploadBridge | null): void {
  bridge = next;
}

export function getWorkspaceFileUploadBridge(): WorkspaceFileUploadBridge | null {
  return bridge;
}
