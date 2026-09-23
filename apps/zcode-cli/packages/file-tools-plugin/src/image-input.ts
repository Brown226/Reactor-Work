/**
 * 图片解码：jimp（纯 JS，零原生依赖）把常见位图解成 RGBA 像素，
 * 供 PP-OCR 的 ImageInput 消费。PDF 走 raster.ts，不进这里。
 */
import { readFile } from "node:fs/promises";
import { Jimp } from "jimp";
import type { RgbaImage } from "./raster.js";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"]);

export function isImagePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [...SUPPORTED_IMAGE_EXTENSIONS].some((ext) => lower.endsWith(ext));
}

export function isPdfPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

export async function decodeImageFile(filePath: string): Promise<RgbaImage> {
  const bytes = await readFile(filePath);
  const image = await Jimp.read(bytes);
  return {
    width: image.width,
    height: image.height,
    data: new Uint8Array(image.bitmap.data.buffer.slice(0)),
  };
}
