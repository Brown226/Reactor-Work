/**
 * 客户端更新 manifest 契约（与桌面端 `packages/desktop/src/main/manifestUpdateProvider.ts` 对齐）。
 *
 * 契约不能改的三件事（改了客户端就装不上更新）：
 *  1. 路径固定为 `/api/v1/releases/electron/manifest` —— 打包后 `manifestUrl` 覆盖会被忽略
 *     （autoUpdater 里 `app.isPackaged` 分支），端点基址 + 这条路径是唯一入口。
 *  2. `files[].sha512` 必须是 **base64**（electron-updater 的 hashFile 默认 base64），
 *     写成 hex 会让客户端判定"校验和不匹配"并反复重下。
 *  3. `files[].url` 相对 manifest 的 origin 解析，因此这里回相对路径即可。
 *
 * 平台串是 `windows-x64` 这种 electron 口径（不是 node 的 win32），通道在查询串里是数字：
 * 1=stable、3=preview；两者都在下面的解析函数里做了宽容处理（也接受字符串写法）。
 */
import { createHash } from "node:crypto";

import type { AppReleaseRow } from "./repo.js";

export const ELECTRON_MANIFEST_PATH = "/api/v1/releases/electron/manifest";
export const ELECTRON_FILE_PATH_PREFIX = "/api/v1/releases/electron/files/";

export type ReleaseChannel = "stable" | "preview";

/** 通道查询参数 → 内部口径。客户端发数字（1/3），管理台与库内用字符串。 */
export function parseReleaseChannel(raw: string | null | undefined): ReleaseChannel | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "1" || value === "stable") return "stable";
  if (value === "3" || value === "preview") return "preview";
  return null;
}

/** 平台查询参数校验：只接受 electron 的 `<os>-<arch>` 形态，避免客户端拼错时静默返回空 manifest。 */
export function normalizeReleasePlatform(raw: string | null | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  return /^(windows|darwin|linux)-(x64|arm64|ia32|armv7l)$/.test(value) ? value : null;
}

/**
 * 灰度分桶：同一设备 + 同一发布必须稳定（否则用户每次检查更新都在"有/无"之间跳），
 * 因此用 sha256(deviceMid:releaseId) 取模，而不是随机数或时间。
 */
export function isDeviceInRollout(deviceMid: string | null | undefined, release: Pick<AppReleaseRow, "id" | "rolloutPercent">): boolean {
  const percent = Math.max(0, Math.min(100, release.rolloutPercent));
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const mid = deviceMid?.trim();
  // 没有 device_mid 的客户端（旧版/命令行）不参与灰度：宁可给它全量，也不要让它永远收不到更新。
  if (!mid) return true;
  const digest = createHash("sha256").update(`${mid}:${release.id}`).digest();
  return (digest.readUInt32BE(0) % 100) < percent;
}

export interface ElectronManifest {
  version: string;
  releaseName: string;
  releaseDate: string;
  releaseNotes: string;
  releaseNotesByLocale: Record<string, { version: string; markdown: string }>;
  files: Array<{ url: string; sha512: string; size: number }>;
}

/**
 * 组装客户端要的 UpdateInfo。字段名与 electron-updater 一致（它是 js-yaml 解析后的普通对象）。
 * 未填的本地化文案不占位——客户端会按 menuLocale → zh-CN → en-US 回退。
 */
export function buildElectronManifest(release: AppReleaseRow): ElectronManifest {
  if (!release.storedName || !release.sha512Base64) {
    throw new Error(`发布 ${release.id} 缺少产物，不能生成 manifest`);
  }
  const releaseNotesByLocale: Record<string, { version: string; markdown: string }> = {};
  if (release.releaseNotesZh?.trim()) {
    releaseNotesByLocale["zh-CN"] = { version: release.version, markdown: release.releaseNotesZh.trim() };
  }
  if (release.releaseNotesEn?.trim()) {
    releaseNotesByLocale["en-US"] = { version: release.version, markdown: release.releaseNotesEn.trim() };
  }
  const fallbackNotes =
    release.releaseNotesZh?.trim() || release.releaseNotesEn?.trim() || `${release.version}`;

  return {
    version: release.version,
    releaseName: release.releaseName?.trim() || `Reactor ${release.version}`,
    releaseDate: (release.publishedAt ?? release.createdAt).toISOString(),
    releaseNotes: fallbackNotes,
    releaseNotesByLocale,
    files: [
      {
        url: `${ELECTRON_FILE_PATH_PREFIX}${encodeURIComponent(release.storedName)}`,
        sha512: release.sha512Base64,
        size: release.sizeBytes ?? 0,
      },
    ],
  };
}
