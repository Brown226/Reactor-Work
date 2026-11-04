/**
 * pdf.js worker 的自定义入口（Web 专用）。
 *
 * pdf.js 的 worker 跑在独立线程，主线程的 polyfills 不会带进去；5.x 的 worker
 * 内部用了 `Promise.withResolvers`（Chrome 119）与 `URL.parse`（Chrome 126），
 * Chromium 109 上直接抛错，表现为「PDF 加载失败」。这里先装同一份垫片再执行
 * worker 主逻辑（ESM 依赖按 import 顺序求值，垫片先于 pdf.worker）。
 */
import "./polyfills.js";
import "pdfjs-dist/build/pdf.worker.min.mjs";
