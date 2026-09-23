/**
 * PP-OCR 推理引擎封装：paddleocr（纯 TS 推理链）+ onnxruntime-node（原生绑定）。
 *
 * 模型以只读资产分发：<assetsRoot>/ocr-models/{det,rec,cls onnx + dict}。
 * 开发态 assets 根解析见 assets.ts（包内 assets/<platformKey> 同样参与候选）。
 *
 * 模型来源：https://huggingface.co/x3zvawq/paddleocr-js-onnx（PP-OCRv5 mobile，
 * Apache-2.0；版本与 sha256 固定见 scripts/prepare-file-tools-assets.mjs）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PaddleOcrService } from "paddleocr";
import { loadOnnxruntime } from "./native.js";
import { resolveFileToolsAssets } from "./assets.js";
import type { RgbaImage } from "./raster.js";

interface OcrLine {
  text: string;
  confidence: number;
  box?: unknown;
}

interface OcrPageResult {
  text: string;
  confidence: number;
  lines: OcrLine[];
}

const MODEL_FILES = {
  det: "PP-OCRv5_mobile_det_infer.onnx",
  rec: "PP-OCRv5_mobile_rec_infer.onnx",
  dict: "ppocrv5_dict.txt",
} as const;

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

let ocrServicePromise: Promise<OcrServiceLike> | null = null;

interface OcrServiceLike {
  recognize(
    input: { width: number; height: number; data: Uint8Array },
    options?: { onProgress?: (event: unknown) => void },
  ): Promise<unknown[]>;
  processRecognition(results: unknown[]): { text: string; confidence: number };
}

function resolveOcrModelsDir(): string {
  const assets = resolveFileToolsAssets();
  if (!assets.ocrModelsDir) {
    throw new Error(
      "未找到 OCR 模型资产（ocr-models）。file-tools 资产不完整，无法执行 OCR。",
    );
  }
  return assets.ocrModelsDir;
}

async function createService(): Promise<OcrServiceLike> {
  const modelsDir = resolveOcrModelsDir();
  const ort = loadOnnxruntime();
  const [det, rec, dict] = await Promise.all([
    readFile(join(modelsDir, MODEL_FILES.det)),
    readFile(join(modelsDir, MODEL_FILES.rec)),
    readFile(join(modelsDir, MODEL_FILES.dict), "utf-8"),
  ]);
  const service = await PaddleOcrService.createInstance({
    modelPreset: "PP-OCRv5_mobile",
    ort,
    detection: { modelBuffer: toArrayBuffer(det) },
    recognition: {
      modelBuffer: toArrayBuffer(rec),
      // PP-OCR 字典第 0 行即 CTC blank；trimEnd 会丢掉尾部空行导致长度对不上类别数。
      charactersDictionary: dict.split(/\r?\n/),
    },
  });
  return service as unknown as OcrServiceLike;
}

/** 单例：onnxruntime 会话与模型缓冲只加载一次，多页/多文件复用。 */
function getOcrService(): Promise<OcrServiceLike> {
  ocrServicePromise ??= createService();
  return ocrServicePromise;
}

export async function recognizeImage(image: RgbaImage): Promise<OcrPageResult> {
  const service = await getOcrService();
  const raw = await service.recognize({ width: image.width, height: image.height, data: image.data });
  const processed = service.processRecognition(raw as never[]);
  const lines: OcrLine[] = (raw as Array<{ text?: string; confidence?: number }>).map((item) => ({
    text: item.text ?? "",
    confidence: item.confidence ?? 0,
  }));
  return {
    text: processed.text,
    confidence: processed.confidence,
    lines: lines.filter((line) => line.text.length > 0),
  };
}

function resetOcrServiceForTests(): void {
  ocrServicePromise = null;
}
