/**
 * 知识库文件树面板所需的最小服务替身。
 *
 * ## 为什么是替身
 *
 * EvoFlow 的 `v4-workspace-file-tree-pane.tsx` 依赖两个 EvoFlow 特有工厂：
 * - `createEvoflowLocalRevealPlatform`（`pages/settings/evoflow-bridge-services.ts`，
 *   283 行的平台桩，含本机资源管理器定位）
 * - `createEvoflowPartialServices`（`react/v4/V4ZCodeTimeline.js`，按 thread + workspace
 *   构造 fileService / gitService / fileWatcherService）
 *
 * 前者整个文件是 EvoFlow 的桌面桥实现，后者绑它的 V4 时间线。两者都与我们的
 * `useServices()` / `usePlatform()` 体系不兼容，逐字搬会带进整个 EvoFlow 前端。
 *
 * 所以这里按 file-tree-pane **实际用到的面**提供最小实现：
 * - `IPlatformService`：只实现 `getInstalledEditors` / `openInEditor` /
 *   `openInFileManager`；其余走我们自己的 `usePlatform()`。
 * - `createEvoflowPartialServices`：从 `useServices()` 取 fileService，
 *   包一层「按 workspace root 解析相对路径」的访问器。
 *
 * 好处：file-tree-pane 原样工作，且用的是我们自己的服务与权限模型。
 */
import type { IPlatformService } from "@zcode/shared";

/** 本机文件管理器定位：Web 宿主没有这个能力，返回 false 让 UI 禁用按钮。 */
async function revealLocalPath(path: string, workspaceRoot?: string): Promise<boolean> {
  const full = workspaceRoot && path && !path.startsWith("/") ? `${workspaceRoot}/${path}` : path;
  // Web 宿主无法唤起本机资源管理器；静默 false 好过抛错（这是个增强按钮）。
  console.info("[knowledge] 本机定位在 Web 宿主不可用：", full);
  return false;
}

export interface EvoflowLocalRevealPlatformOpts {
  /** 把 PreviewPane 的相对路径拼到这个 workspace 根上再定位。 */
  workspaceRoot?: string | null;
}

/**
 * 提供「打开」按钮所需的平台面。
 *
 * EvoFlow 原实现的注释说明：stub 返回空 editors 会把按钮永久 disabled，
 * 表格/PDF/代码预览都依赖这里。所以至少要给一个 editor 条目。
 */
export function createEvoflowLocalRevealPlatform(
  opts?: EvoflowLocalRevealPlatformOpts,
): IPlatformService {
  const workspaceRoot = String(opts?.workspaceRoot || "").trim() || undefined;
  return {
    getInstalledEditors: async () => [
      {
        id: "file-manager",
        name: "文件管理器",
        // Web 宿主统一不可用；桌面端由 desktopPlatform 覆盖。
        available: false,
      },
    ],
    openInEditor: async (_editorId: string, path: string) =>
      revealLocalPath(path, workspaceRoot),
    openInFileManager: async (path: string) => revealLocalPath(path, workspaceRoot),
  } as unknown as IPlatformService;
}

/** 与 EvoFlow 同名的单例（绝对路径场景）。 */
export const evoflowLocalRevealPlatform: IPlatformService = createEvoflowLocalRevealPlatform();

export interface PartialServices {
  fileService: {
    readdir: (params: { path: string; includeHidden?: boolean }) => Promise<DirEntry[]>;
  };
}

/**
 * 目录条目形状。
 *
 * 与 `v4-workspace-file-tree-pane.tsx` 内部的 `DirEntry` 一致（`type` 字段而非
 * `isDirectory`/`isFile` 布尔）—— 它的 readdir 消费方直接读 `entry.type`。
 */
export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

/**
 * 按 thread + workspace root 构造文件访问器。
 *
 * file-tree-pane 的用法：`base.fileService.readdir({ path, includeHidden })`，
 * path 可能是相对 workspace root 的路径。我们从调用方注入的 fileService 取，
 * 不自己造 —— 避免第二份文件访问路径（AGENTS.md：避免重复状态和多条写入路径）。
 */
export function createEvoflowPartialServices(
  _threadId: string,
  workspacePath: string,
  fileService?: PartialServices["fileService"],
): PartialServices {
  const root = String(workspacePath || "").trim();
  const resolve = (path: string): string => {
    if (!root) return path;
    if (!path) return root;
    return path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`;
  };
  const readdir = async (params: { path: string; includeHidden?: boolean }) => {
    if (!fileService) {
      // 未注入 fileService：返回空而不是抛错，让树渲染成空态而非白屏。
      return [] as DirEntry[];
    }
    return fileService.readdir({ ...params, path: resolve(params.path) });
  };
  return { fileService: { readdir } };
}

/**
 * 平台桩：无桌面宿主时的降级实现。
 *
 * 来源：EvoFlow `pages/settings/evoflow-bridge-services.ts` 的 `evoflowStubPlatform`。
 * 作用：让「文件链接 / 打开编辑器 / 连接远端」等桌面能力在 Web 宿主下**返回失败
 * 而不是抛错**（V4 MessageFileLink / useFileContextActions 都依赖这一点）。
 * 我们去掉了它的 `executeDesktopCommand`（那要唤起 EvoFlow 自己的资源管理器）。
 */
export const evoflowStubPlatform: IPlatformService = {
  selectDirectory: async () => null,
  selectFile: async () => null,
  selectFiles: async () => [],
  activateOrSetWorkspace: async () => ({ activated: false }),
  onRemoteConnectionLog: () => () => {},
  onRemoteSessionClosed: () => () => {},
  onBotRemoteWorkspaceReconnected: () => () => {},
  connectRemote: async () => ({ success: false, error: "stub" }),
  getInstalledEditors: async () => [],
  openInEditor: async () => ({ success: false, error: "stub" }),
  openInFileManager: async () => ({ success: false, error: "stub" }),
  openExternal: async () => {},
} as unknown as IPlatformService;
