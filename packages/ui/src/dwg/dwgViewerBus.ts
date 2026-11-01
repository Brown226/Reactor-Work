/**
 * DWG 查看器与外部世界（agent 工具结果、会话引用）之间的解耦事件总线。
 *
 * 为什么不用 zustand store：这是一次性瞬时事件（改图完成 → 定位高亮），
 * 不是持续状态；订阅方是当前挂载的查看器，错过就错过（文件都没开）。
 * 发布方在工具结果落地的位置（见 chat 侧的 dwg_modify 处理），查看器挂载时订阅。
 */

/** 定位事件的来源：agent 改图回显，或会话里点引用跳转。 */
export type DwgViewerLocateOrigin = "agent-modify" | "chat-quote";

export interface DwgViewerLocateEvent {
  /** 图纸路径：agent 侧是工作区绝对路径，空间侧是空间相对路径；匹配时做后缀对齐。 */
  path: string;
  /** 要定位/高亮的 CAD 实体 handle（十六进制，来自 dwg-sidecar 的输出）。 */
  handles: string[];
  origin: DwgViewerLocateOrigin;
}

type Listener = (event: DwgViewerLocateEvent) => void;

const listeners = new Set<Listener>();

export function emitDwgViewerLocate(event: DwgViewerLocateEvent): void {
  for (const listener of listeners) listener(event);
}

export function onDwgViewerLocate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 两侧路径是否指向同一张图纸：大小写不敏感（Windows），按路径段做后缀/前缀对齐——
 * agent 给绝对路径 E:\a\b\c.dwg，空间侧给相对路径 c.dwg 或 b/c.dwg，都算同一张。
 */
export function dwgPathMatches(eventPath: string, viewerPath: string): boolean {
  if (!eventPath || !viewerPath) return false;
  const normalize = (value: string): string[] =>
    value
      .replace(/\\/g, "/")
      .toLowerCase()
      .split("/")
      .filter((segment) => segment.length > 0);
  const eventSegments = normalize(eventPath);
  const viewerSegments = normalize(viewerPath);
  if (eventSegments.length === 0 || viewerSegments.length === 0) return false;
  const shorter = eventSegments.length <= viewerSegments.length ? eventSegments : viewerSegments;
  const longer = shorter === eventSegments ? viewerSegments : eventSegments;
  // 短的那份必须是长的那份的尾部连续段（至少要带上文件名本身）
  return shorter.every(
    (segment, index) => segment === longer[longer.length - shorter.length + index],
  );
}
