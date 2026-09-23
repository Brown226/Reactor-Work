import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const require2 = createRequire(import.meta.url);

/**
 * file-tools MCP server bundle。
 *
 * 与 node-repl-host 同款 ESM 产物 + createRequire banner（esbuild 的 esm 产物里
 * __require shim 在 ESM 作用域没有 require 可用；CJS 依赖会在模块求值阶段炸）。
 *
 * external 的原生/大型依赖：anydoc 的 JS wrapper 若被内联，其对平台 .node 的
 * 相对 require 会在 seed 缓存副本里解析失败；onnxruntime-node 同理；
 * libredwg 的 Node 可用实现在 lib/libredwg.js（相对 import wasm 胶水），只能
 * 从资产目录整目录加载。pdfjs/@napi-rs/canvas/paddleocr/jimp 可安全内联。
 */
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

const outfile = resolve(packageRoot, "dist", "mcp", "server.js");
await mkdir(dirname(outfile), { recursive: true });
await build({
  banner: { js: nodeRequireBanner },
  bundle: true,
  entryPoints: [resolve(packageRoot, "src", "server.ts")],
  external: [
    // 原生绑定：运行时从资产目录绝对路径加载（src/native.ts）。
    "@firecrawl/anydoc",
    "onnxruntime-node",
    "@mlightcad/libredwg-web",
    // @napi-rs/canvas 的平台 skia .node 同上；js-binding 运行时按平台 require。
    "@napi-rs/canvas",
    "@napi-rs/canvas-*",
  ],
  format: "esm",
  legalComments: "none",
  outfile,
  platform: "node",
  target: "node24",
  plugins: [
    {
      // pdfjs 的 fake worker 要一个真实的 worker 文件（运行时动态 import workerSrc）。
      // pdfjs 被内联进 bundle 后 node_modules 不再可达，构建时把 worker 拷到 bundle 同目录；
      // dist/ 在插件 seed 白名单里，随 bundle 一起进 seed 缓存与安装包。
      name: "copy-pdf-worker",
      setup(buildModule) {
        buildModule.onEnd(async () => {
          const workerSource = require2.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
          const workerTarget = join(dirname(outfile), "pdf.worker.mjs");
          await mkdir(dirname(workerTarget), { recursive: true });
          await copyFile(workerSource, workerTarget);
        });
      },
    },
  ],
});
console.log(`[file-tools] bundle written: ${outfile}`);
