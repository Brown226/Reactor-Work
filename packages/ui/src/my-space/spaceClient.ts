/**
 * 我的空间 API 客户端。
 *
 * 服务端契约见 docs/未完成-我的空间-方案-v1.md §4。所有请求走同源 `/api/space/*`
 * （Web 客户端由 @zcode/server 提供），因此不需要额外配置地址。
 */

export interface SpaceUsage {
  usedBytes: number;
  quotaBytes: number;
  trashBytes: number;
  byCategory: Record<string, number>;
}

export interface SpaceEntry {
  name: string;
  /**
   * 服务端返回 file / directory / other（other 是符号链接等特殊项，空间页不可进入）。
   * 早期前端类型写的是 "dir"，与服务端不一致会导致目录点不开，这里以服务端为准。
   */
  kind: "file" | "directory" | "other";
  size: number;
  mtime: string;
}

export interface SpaceEntriesResult {
  path: string;
  entries: SpaceEntry[];
  usage: SpaceUsage;
}

export interface SpaceTrashItem {
  id: string;
  name: string;
  size: number;
  deletedAt: string;
  fromPath: string;
}

export interface SpaceShareItem {
  token: string;
  path: string;
  createdAt: string;
  expiresAt: string;
  hasPassword: boolean;
  url: string;
}

/** 配额不足（HTTP 413）：UI 要据此高亮容量卡并给出清理建议。 */
export class SpaceQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaceQuotaError";
  }
}

export class SpaceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SpaceRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (response.status === 413) {
    throw new SpaceQuotaError("空间不足，请清理回收站或删除文件");
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // 非 JSON 响应（如文件流）保持通用文案
    }
    throw new SpaceRequestError(message, response.status);
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const spaceClient = {
  entries: (path = "") =>
    request<SpaceEntriesResult>(`/api/space/entries?path=${encodeURIComponent(path)}`),
  usage: () => request<SpaceUsage>("/api/space/usage"),
  mkdir: (path: string) => post<{ ok: true }>("/api/space/mkdir", { path }),
  rename: (path: string, name: string) => post<{ ok: true }>("/api/space/rename", { path, name }),
  move: (paths: string[], toDir: string) => post<{ ok: true }>("/api/space/move", { paths, toDir }),
  remove: (paths: string[]) => post<{ ok: true }>("/api/space/delete", { paths }),

  trash: () => request<{ items: SpaceTrashItem[] }>("/api/space/trash"),
  restore: (ids: string[]) => post<{ ok: true }>("/api/space/trash/restore", { ids }),
  purge: (ids: string[]) => post<{ ok: true }>("/api/space/trash/purge", { ids }),

  shares: () => request<{ items: SpaceShareItem[] }>("/api/space/shares"),
  createShare: (path: string, ttlHours: number, password?: string) =>
    post<SpaceShareItem>("/api/space/share", { path, ttlHours, ...(password ? { password } : {}) }),
  revokeShare: (token: string) => post<{ ok: true }>("/api/space/share/revoke", { token }),

  downloadUrl: (path: string) => `/api/space/download?path=${encodeURIComponent(path)}`,
  previewUrl: (path: string) => `/api/space/preview?path=${encodeURIComponent(path)}`,

  /** 递归搜索文件名（服务端已跳过 .trash/.uploads/.versions）。 */
  search: (q: string) =>
    request<{ query: string; results: Array<{ path: string; entry: SpaceEntry }>; truncated: boolean }>(
      `/api/space/search?q=${encodeURIComponent(q)}`,
    ),

  /** 历史版本列表。 */
  versions: (path: string) =>
    request<{ path: string; items: Array<{ id: string; size: number; savedAt: string }> }>(
      `/api/space/versions?path=${encodeURIComponent(path)}`,
    ),
  restoreVersion: (path: string, versionId: string) =>
    post<{ ok: true }>("/api/space/versions/restore", { path, versionId }),

  /** 批量打包下载：POST 后直接下载 zip（用表单提交避免 fetch 落内存）。 */
  downloadArchive: async (paths: string[]): Promise<void> => {
    const response = await fetch("/api/space/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    if (!response.ok) {
      let message = `打包失败（${response.status}）`;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // 保持通用文案
      }
      throw new SpaceRequestError(message, response.status);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `space-${new Date().toISOString().slice(0, 10)}.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
  },

  /**
   * 上传并保留旧版本（覆盖同名文件，把旧内容归档到版本库）。
   * 与普通 upload 区分：普通上传同名会加 (1) 后缀，从不覆盖。
   */
  uploadVersioned: async (dirPath: string, file: File, onProgress?: (p: number) => void) => {
    return new Promise<{ name: string; size: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/space/upload/versioned?path=${encodeURIComponent(dirPath)}`);
      xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status === 413) return reject(new SpaceQuotaError("空间不足，请清理回收站或删除文件"));
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            return resolve(JSON.parse(xhr.responseText) as { name: string; size: number });
          } catch {
            return reject(new SpaceRequestError("上传响应解析失败", xhr.status));
          }
        }
        let message = `上传失败（${xhr.status}）`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: unknown };
          if (typeof parsed.error === "string") message = parsed.error;
        } catch {
          // 保持通用文案
        }
        reject(new SpaceRequestError(message, xhr.status));
      };
      xhr.onerror = () => reject(new SpaceRequestError("上传中断，请重试", 0));
      xhr.send(file);
    });
  },

  /**
   * 大文件分片上传（带断点续传）。
   *
   * 为什么需要：整包上传要把整个文件读进内存，图纸级文件会顶到内存峰值，
   * 且中途失败只能从头再来。分片把单次请求控制在 CHUNK_SIZE，
   * 并用 status 查询已收到的分片，重传时跳过已有分片。
   */
  uploadChunked: async (
    dirPath: string,
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<{ name: string; size: number }> => {
    const CHUNK_SIZE = 4 * 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const begin = await request<{ uploadId: string; received: number[] }>("/api/space/upload/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dirPath, name: file.name, size: file.size, totalChunks }),
    });
    const done = new Set(begin.received);
    for (let index = 0; index < totalChunks; index += 1) {
      if (done.has(index)) continue;
      const chunk = file.slice(index * CHUNK_SIZE, Math.min(file.size, (index + 1) * CHUNK_SIZE));
      const response = await fetch(
        `/api/space/upload/chunk?uploadId=${begin.uploadId}&index=${index}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: chunk,
        },
      );
      if (!response.ok) {
        throw new SpaceRequestError(`第 ${index + 1}/${totalChunks} 片上传失败`, response.status);
      }
      onProgress?.(Math.round(((index + 1) / totalChunks) * 100));
    }
    const commit = await request<{ entry: { name: string; size: number } }>("/api/space/upload/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId: begin.uploadId }),
    });
    return { name: commit.entry.name, size: commit.entry.size };
  },

  /**
   * 上传：用 XHR 而不是 fetch，只为拿到 progress 事件（大图纸几十 MB，没有进度
   * 用户会以为卡死）。文件名走 header，避免 query 里出现中文与分隔符问题。
   */
  upload: (
    dirPath: string,
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<{ name: string; size: number }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/space/upload?path=${encodeURIComponent(dirPath)}`);
      xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status === 413) {
          reject(new SpaceQuotaError("空间不足，请清理回收站或删除文件"));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as { name: string; size: number });
          } catch {
            reject(new SpaceRequestError("上传响应解析失败", xhr.status));
          }
          return;
        }
        let message = `上传失败（${xhr.status}）`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: unknown };
          if (typeof parsed.error === "string") message = parsed.error;
        } catch {
          // 保持通用文案
        }
        reject(new SpaceRequestError(message, xhr.status));
      };
      xhr.onerror = () => reject(new SpaceRequestError("上传中断，请重试", 0));
      xhr.send(file);
    }),
};

/** 容量百分比（0–100），用于进度条与预警配色。 */
export function usagePercent(usage: SpaceUsage | null): number {
  if (!usage || usage.quotaBytes <= 0) return 0;
  return Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}
