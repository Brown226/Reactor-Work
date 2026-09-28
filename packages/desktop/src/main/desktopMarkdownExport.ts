import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  MarkdownExportRequest,
  MarkdownExportResult,
} from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { BrowserWindow, ipcMain } from "electron";

/** 同一 webContents 的导出请求串行化，防止重复触发 Chromium 渲染管线 */
const inFlightSenderIds = new Set<number>();

const PNG_DEFAULT_WIDTH = 760;
const PNG_DEFAULT_SCALE = 2;
/** 离屏窗口高度上限：超出后转为分段提示（Windows 窗口高度上限附近留余量） */
const MAX_CONTENT_HEIGHT = 16000;

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  // 用拷贝而不是 `buffer.buffer.slice(...)`：Node 的 `Buffer#buffer` 类型是 ArrayBufferLike
  // （可能被标成 SharedArrayBuffer），直接切片拿不到确定的 ArrayBuffer；这里落到一个独立副本上，
  // 交给 IPC 的结构化克隆也没有共享内存的顾虑。
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

/**
 * 把自包含 HTML 落成临时文件并用离屏 BrowserWindow 加载。
 * 窗口先设成期望的内容尺寸，保证后续截图/打印能覆盖整页。
 */
async function loadExportHtml(
  html: string,
  width: number,
  height: number,
): Promise<{ window: BrowserWindow; tempFile: string }> {
  const tempFile = path.join(tmpdir(), `reactor-markdown-export-${randomUUID()}.html`);
  await writeFile(tempFile, html, "utf8");
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      // 导出窗口不加载任何预注入脚本，避免与快照 HTML 互相干扰
      preload: undefined,
      sandbox: true,
      webSecurity: true,
    },
  });
  try {
    await win.loadFile(tempFile);
  } catch (error) {
    win.destroy();
    throw error;
  }
  return { window: win, tempFile };
}

async function captureFullPagePng(
  win: BrowserWindow,
  width: number,
  height: number,
  scale: number,
): Promise<Buffer> {
  const webContents = win.webContents;
  // 优先 CDP：与 browserCommandPageHandlers 同路线，captureBeyondViewport 才能完整拿到
  // 超过初始 viewport 的长页；renderer 侧 capturePage 有 V8 FATAL 问题，main 侧可用但
  // 不保证覆盖超长页，因此只作回退。
  try {
    await webContents.debugger.attach("1.3");
    try {
      const result = (await webContents.debugger.sendCommand(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale },
        },
      )) as { data: string };
      return Buffer.from(result.data, "base64");
    } finally {
      webContents.debugger.detach();
    }
  } catch {
    const image = await webContents.capturePage({ x: 0, y: 0, width, height });
    return image.toPNG();
  }
}

async function renderMarkdownExport(
  request: MarkdownExportRequest,
  logger: { warn: (...args: unknown[]) => void },
): Promise<MarkdownExportResult> {
  const width =
    request.format === "png" ? Math.max(320, request.width ?? PNG_DEFAULT_WIDTH) : 1000;
  const contentHeight =
    request.format === "png" ? Math.max(200, request.contentHeight ?? 2000) : 2000;
  const height = Math.min(contentHeight + 64, MAX_CONTENT_HEIGHT);

  let window: BrowserWindow | null = null;
  let tempFile: string | null = null;
  // 失败阶段决定错误码：临时文件写入/加载失败与窗口截图/打印失败的定位不同
  let stage: "load" | "render" = "load";
  try {
    const loaded = await loadExportHtml(request.html, width, height);
    window = loaded.window;
    tempFile = loaded.tempFile;
    stage = "render";

    if (request.format === "png") {
      const scale = Math.min(4, Math.max(1, request.scale ?? PNG_DEFAULT_SCALE));
      const png = await captureFullPagePng(window, width, height - 64, scale);
      return { success: true, data: toArrayBuffer(png) };
    }

    const pdf = await window.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    return { success: true, data: toArrayBuffer(pdf) };
  } catch (error) {
    logger.warn(
      `[markdown-export] 导出失败 format=${request.format} stage=${stage} error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { success: false, error: stage === "load" ? "load_failed" : "render_failed" };
  } finally {
    window?.destroy();
    if (tempFile) {
      await unlink(tempFile).catch(() => undefined);
    }
  }
}

export function registerDesktopMarkdownExportIpcHandler(logger: {
  warn: (...args: unknown[]) => void;
}) {
  ipcMain.handle(
    PlatformChannels.MarkdownExport,
    async (event, request: MarkdownExportRequest): Promise<MarkdownExportResult> => {
      const senderId = event.sender.id;
      if (inFlightSenderIds.has(senderId)) {
        return { success: false, error: "busy" };
      }
      inFlightSenderIds.add(senderId);
      try {
        return await renderMarkdownExport(request, logger);
      } finally {
        inFlightSenderIds.delete(senderId);
      }
    },
  );
}
