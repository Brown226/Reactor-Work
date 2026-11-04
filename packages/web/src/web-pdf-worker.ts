/**
 * 在 UI 模块加载前把 pdf.js 指向「带 Chromium 109 垫片的自定义 worker」。
 *
 * 必须排在 `@zcode/ui` 的 import 之前（main.tsx 第二个 import）。共享的
 * `pdf-viewer.tsx` 只在 workerSrc 为空时才写入默认 worker，因此不会被覆盖。
 */
import "./polyfills.js";
import { GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "./pdf-worker-entry.ts?worker&url";

GlobalWorkerOptions.workerSrc = workerUrl;
