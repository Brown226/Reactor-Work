/**
 * PDF 栅格化：pdfjs-dist + @napi-rs/canvas，全部为 npm 预编译产物（全平台一致，
 * N-API 稳定可跑在 Electron 的 Node 模式下），随安装包分发、离线可用。
 *
 * 两个必须记住的点：
 * 1. pdfjs 在 Node 下不会自己 require @napi-rs/canvas（ESM 里没有 require），
 *    Path2D/DOMMatrix/ImageData 必须由本模块在加载 pdfjs **之前**注入全局，
 *    否则渲染期 pdfjs 用自带的 Path2D 垫片调用 ctx.fill(path, "evenodd") 会 InvalidArg。
 * 2. pdfjs 5.4 在 @napi-rs/canvas 上曾段错误；固定 6.2.x，升级前必须跑
 *    test/raster.test.ts 的真实 PDF 页回归。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCanvasModule } from "./native.js";

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA，每像素 4 字节。 */
  data: Uint8Array;
}

let pdfjsPromise: Promise<any> | null = null;

/**
 * pdfjs 在 Node 下用 fake worker：动态 import GlobalWorkerOptions.workerSrc。
 * 打包态 pdfjs 被 esbuild 内联进 bundle，worker 文件由 scripts/build.mjs 拷到
 * bundle 同目录；源码态直接从包内解析。不设置会在渲染期报
 * "Setting up fake worker failed"。
 */
function resolvePdfWorkerUrl(): string {
  const require2 = createRequire(import.meta.url);
  try {
    return pathToFileURL(require2.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  } catch {
    const beside = join(dirname(fileURLToPath(import.meta.url)), "pdf.worker.mjs");
    return pathToFileURL(beside).href;
  }
}

async function loadPdfjs(): Promise<any> {
  const canvasMod = loadCanvasModule();
  const globals = globalThis as Record<string, unknown>;
  globals.Path2D ??= canvasMod.Path2D;
  globals.DOMMatrix ??= canvasMod.DOMMatrix;
  globals.ImageData ??= canvasMod.ImageData;
  if (!globals.navigator) {
    globals.navigator = { language: "en-US", platform: "", userAgent: "" };
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = resolvePdfWorkerUrl();
  return pdfjs;
}

function loadPdfjsOnce(): Promise<any> {
  pdfjsPromise ??= loadPdfjs();
  return pdfjsPromise;
}

function loadCanvasFactory(): (w: number, h: number) => any {
  const canvasMod = loadCanvasModule();
  return (width: number, height: number) => canvasMod.createCanvas(width, height);
}

interface RasterizePagesOptions {
  /** 渲染 DPI；OCR 用 200 拿到清晰文字，默认 200。 */
  dpi?: number;
  /** 最多渲染页数（扫描件大册子保护）。 */
  maxPages?: number;
}

/**
 * 把 PDF 指定页渲染成 RGBA。页范围损坏 / 超范围按 Clamp 处理；
 * 返回的数组长度 = 实际渲染页数（可能小于请求数）。
 */
export async function rasterizePdfPages(
  filePath: string,
  pages?: number[],
  options: RasterizePagesOptions = {},
): Promise<{ images: RgbaImage[]; totalPages: number }> {
  const dpi = options.dpi ?? 200;
  const pdfjs = await loadPdfjsOnce();
  const createCanvas = loadCanvasFactory();
  const bytes = new Uint8Array(await readFile(filePath));
  const doc = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  try {
    const totalPages: number = doc.numPages;
    const requested =
      pages && pages.length > 0
        ? pages.filter((page) => page >= 1 && page <= totalPages)
        : Array.from({ length: totalPages }, (_, index) => index + 1);
    const limited =
      options.maxPages !== undefined ? requested.slice(0, options.maxPages) : requested;
    const images: RgbaImage[] = [];
    for (const pageNumber of limited) {
      const page = await doc.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: dpi / 72 });
        const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        images.push({
          width: canvas.width,
          height: canvas.height,
          data: new Uint8Array(imageData.data.buffer.slice(0)),
        });
      } finally {
        page.cleanup();
      }
    }
    return { images, totalPages };
  } finally {
    // pdfjs 6.x 的 DocumentProxy 没有 destroy()；cleanup() 才是释放入口。
    doc.cleanup();
  }
}
