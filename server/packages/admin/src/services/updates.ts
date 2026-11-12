// Reactor 管理台 · 软件更新服务（UPD）
// 契约对齐 packages/server/src/updates/routes.ts（/admin/updates/*，platform_admin 专用）。
//
// 上传走 http.uploadRaw（XHR 原始字节 + 进度），对应服务端的「先建草稿 → PUT 字节流」两步式：
// 安装包几百 MB，套 JSON/base64 会让请求体膨胀 33% 且吃内存。
//
// 平台串与客户端一致（electron 口径 `windows-x64`），不是 node 的 win32；
// 通道在这里是字符串，服务端会把客户端的数字口径（1/3）也接住。

import { http, localStorageTokenStore, type UploadProgress } from "../http/client";
import { refreshAccess } from "./identity";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

export type ReleaseChannel = "stable" | "preview";

export interface AdminRelease {
  id: number;
  platform: string;
  channel: ReleaseChannel;
  version: string;
  releaseName: string | null;
  releaseNotesZh: string | null;
  releaseNotesEn: string | null;
  rolloutPercent: number;
  published: boolean;
  publishedAt: string | null;
  publishedBy: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  hasArtifact: boolean;
  downloadPath: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseDraftInput {
  platform: string;
  channel: ReleaseChannel;
  version: string;
  releaseName?: string;
  releaseNotesZh?: string;
  releaseNotesEn?: string;
  rolloutPercent?: number;
}

export interface ReleasePatchInput {
  releaseName?: string | null;
  releaseNotesZh?: string | null;
  releaseNotesEn?: string | null;
  rolloutPercent?: number;
  published?: boolean;
}

/** 平台下拉候选：与客户端 getElectronReleasePlatform 的输出口径一致。 */
export const RELEASE_PLATFORMS = [
  "windows-x64",
  "windows-arm64",
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
] as const;

/** 产物后缀白名单：与服务端 ARTIFACT_SUFFIXES 同步（传错类型客户端会认不出安装格式）。 */
export const RELEASE_ARTIFACT_SUFFIXES = [
  ".exe",
  ".msi",
  ".zip",
  ".dmg",
  ".pkg",
  ".appimage",
  ".deb",
  ".rpm",
  ".pacman",
  ".pkg.tar.zst",
] as const;

export const RELEASE_CHANNELS: ReleaseChannel[] = ["stable", "preview"];

export function releaseChannelLabel(channel: ReleaseChannel): string {
  return channel === "preview" ? "预览" : "正式";
}

export function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const updatesApi = {
  list: (params: { platform?: string; channel?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.platform) query.set("platform", params.platform);
    if (params.channel) query.set("channel", params.channel);
    if (params.limit) query.set("limit", String(params.limit));
    if (params.offset) query.set("offset", String(params.offset));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return http.get<{ releases: AdminRelease[]; total: number; limit: number; offset: number }>(
      `/admin/updates/releases${suffix}`,
      AUTH,
    );
  },
  create: (body: ReleaseDraftInput) =>
    http.post<{ release: AdminRelease }>("/admin/updates/releases", body, AUTH),
  uploadArtifact: (
    id: number,
    file: File,
    opts: { onProgress?: (progress: UploadProgress) => void } = {},
  ) =>
    http.uploadRaw<{ release: AdminRelease }>(
      `/admin/updates/releases/${id}/file`,
      file,
      { ...AUTH, headers: { "x-file-name": file.name }, ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) },
    ),
  patch: (id: number, body: ReleasePatchInput) =>
    http.patch<{ release: AdminRelease }>(`/admin/updates/releases/${id}`, body, AUTH),
  remove: (id: number) => http.delete<{ ok: boolean }>(`/admin/updates/releases/${id}`, AUTH),
};
