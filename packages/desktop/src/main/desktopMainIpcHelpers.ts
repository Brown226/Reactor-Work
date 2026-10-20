import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow } from "electron";
import { shell } from "electron";

type DesktopIpcLogger = {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export async function openPathInDefaultApp(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    const error = "empty path";
    logger.warn("[open-external] 本地文件打开失败", { path: rawPath, error });
    return { success: false, error };
  }

  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // 路径不存在或无法解析时仍尝试用规范化后的原路径，让系统返回更具体的错误。
  }

  try {
    const error = await shell.openPath(target);
    if (error) {
      logger.warn("[open-external] 本地文件打开失败", { path: target, error });
      return { success: false, error };
    }
    logger.info?.("[open-external] 本地文件打开成功", { path: target });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[open-external] 本地文件打开失败", { path: target, error: message });
    return { success: false, error: message };
  }
}

export async function openPathInFileManager(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return { success: false, error: "empty path" };
  }
  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // 路径不存在或无法解析时仍尝试用规范化后的原路径打开，便于定位权限等问题。
  }

  if (process.platform === "darwin") {
    return openDarwinPathInFileManager(target, logger);
  }

  const error = await shell.openPath(target);
  if (error) {
    logger.warn("[open-in-file-manager] shell.openPath 失败", {
      path: target,
      error,
    });
    return { success: false, error };
  }
  return { success: true };
}

export async function captureWindowScreenshot(senderWindow: BrowserWindow | null) {
  if (!senderWindow || senderWindow.isDestroyed()) {
    return null;
  }

  // 报错横幅里的反馈需要带上用户看到的现场。
  // 这里在 main 进程截当前窗口，避免 renderer 走屏幕录制权限或只能截到局部 DOM。
  const image = await senderWindow.webContents.capturePage();
  const buffer = image.toPNG();
  return {
    dataBase64: buffer.toString("base64"),
    filename: `zcode-error-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    contentType: "image/png",
    size: buffer.byteLength,
  };
}

async function openDarwinPathInFileManager(target: string, logger: DesktopIpcLogger) {
  const runOpen = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile("open", args, (error) => (error ? reject(error) : resolve()));
    });

  try {
    await runOpen([target]);
    return { success: true };
  } catch (firstError) {
    try {
      await runOpen(["-a", "Finder", target]);
      return { success: true };
    } catch (finderError) {
      const shellMessage = await shell.openPath(target);
      if (!shellMessage) {
        return { success: true };
      }
      logger.warn("[open-in-file-manager] macOS 打开目录均失败", {
        path: target,
        shellMessage,
        firstError: firstError instanceof Error ? firstError.message : String(firstError),
        finderError: finderError instanceof Error ? finderError.message : String(finderError),
      });
      return { success: false, error: shellMessage };
    }
  }
}

/**
 * 特权 IPC 通道的来源校验：判断事件是否来自应用自身的渲染层。
 *
 * 生产包 renderer 落在 main 同级的 `../renderer` 目录（`file://`），开发态走
 * `ELECTRON_RENDERER_URL` 指向的 dev server。内嵌浏览器的远程页面（http/https，
 * 如 coding-plan 官网、`<webview>` guest）以及任意本地 `file://` 页面都不属于应用
 * 渲染层——它们带 preload 时能触达平台通道，若特权通道不校验来源，就会被诱导打开
 * 任意本地路径。因此这里按「renderer 目录前缀 + dev server origin」双重白名单判定。
 */
export function isTrustedAppRendererUrl(frameUrl: string | null | undefined): boolean {
  if (typeof frameUrl !== "string" || frameUrl.length === 0) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(frameUrl);
  } catch {
    return false;
  }

  // 开发态：dev server origin 即应用渲染层。
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (typeof devServerUrl === "string" && devServerUrl.length > 0) {
    try {
      if (parsed.origin === new URL(devServerUrl).origin) {
        return true;
      }
    } catch {
      // dev server 地址不可解析时继续走生产态判定。
    }
  }

  // 生产态：仅接受应用 renderer 目录内的 file:// 页面，挡住其它任意本地 HTML。
  if (parsed.protocol === "file:") {
    try {
      const rendererDirUrl = pathToFileURL(join(import.meta.dirname, "../renderer")).href;
      return parsed.href.startsWith(rendererDirUrl);
    } catch {
      return false;
    }
  }

  return false;
}
