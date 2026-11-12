import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);

/**
 * DWG 查看器（mlightcad）的静态运行时资产：LibreDWG 解析 worker、它的 wasm、
 * MTEXT 排版 worker。参照 pdfJsCMapsPlugin 的模式——构建期 emitFile 进产物、
 * 开发态由中间件直读 node_modules，两端 URL 一致（/dwg-assets/<file>）。
 *
 * 字体不在此列：SHX/TTF 体量与许可都不适合随包分发，由 scripts/fetch-dwg-fonts.mjs
 * 下载到 packages/web/public/dwg-fonts/（gitignored），vite 的 public 目录机制负责
 * dev 与 build 两态；字体缺失时查看器降级为只渲染几何并提示。
 */
const DWG_ASSETS_OUTPUT_DIRECTORY = "dwg-assets";

interface DwgStaticAsset {
  fileName: string;
  source: () => Promise<Buffer>;
}

/** 包内 dist 资产 → 站点 URL。resolve 包主入口再取 dirname，避免依赖 package.json exports 放行。 */
function resolveDwgStaticAssets(): DwgStaticAsset[] {
  const files: Array<{ fileName: string; packageId: string }> = [
    { fileName: "libredwg-parser-worker.js", packageId: "@mlightcad/libredwg-converter" },
    { fileName: "libredwg-web.wasm", packageId: "@mlightcad/libredwg-converter" },
    { fileName: "mtext-renderer-worker.js", packageId: "@mlightcad/mtext-renderer" },
  ];
  return files.map(({ fileName, packageId }) => ({
    fileName,
    source: () => readFile(join(dirname(require.resolve(packageId)), fileName)),
  }));
}

export interface DwgViewerAssetsPluginOptions {
  /** 桌面端（file://）没有 public 目录托管字体：由插件从 web public 目录代发。 */
  includeFonts?: boolean;
}

const FONT_SOURCE_DIRECTORY = "packages/web/public/dwg/fonts";
const FONT_URL_PREFIX = "dwg/fonts";

export function dwgViewerAssetsPlugin(options: DwgViewerAssetsPluginOptions = {}): Plugin {
  const assets = resolveDwgStaticAssets();
  const assetMap = new Map(assets.map((asset) => [asset.fileName, asset]));
  // 字体：构建/中间件启动时枚举一次（文件由 fetch-dwg-fonts 脚本落盘）
  const fontSourceDir = resolve(import.meta.dirname, "..", "..", "..", FONT_SOURCE_DIRECTORY);
  const fontFiles =
    options.includeFonts && existsSync(fontSourceDir)
      ? readdirSync(fontSourceDir).filter((name) => !name.startsWith("."))
      : [];
  return {
    name: "zcode:dwg-viewer-assets",
    // 开发态不支持 emitFile，产物只在 generateBundle 输出；dev 走中间件。
    async generateBundle() {
      for (const asset of assets) {
        this.emitFile({
          type: "asset",
          fileName: `${DWG_ASSETS_OUTPUT_DIRECTORY}/${asset.fileName}`,
          source: await asset.source(),
        });
      }
      for (const fontFile of fontFiles) {
        this.emitFile({
          type: "asset",
          fileName: `${FONT_URL_PREFIX}/${fontFile}`,
          source: await readFile(join(fontSourceDir, fontFile)),
        });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        // 桌面 dev（file:// 不适用，dev 走 http）与需要统一路径的宿主：字体由插件代发
        const requestPath = (request.url ?? "").split("?", 1)[0] ?? "";
        const fontMarker = `/${FONT_URL_PREFIX}/`;
        const fontIndex = requestPath.indexOf(fontMarker);
        if (fontIndex >= 0) {
          const fontName = requestPath.slice(fontIndex + fontMarker.length);
          if (!fontFiles.includes(fontName)) {
            next();
            return;
          }
          void readFile(join(fontSourceDir, fontName))
            .then((source) => response.end(source))
            .catch(() => {
              response.statusCode = 404;
              response.end();
            });
          return;
        }
        next();
      });
      server.middlewares.use((request, response, next) => {
        const requestPath = request.url?.split("?", 1)[0] ?? "";
        const marker = `/${DWG_ASSETS_OUTPUT_DIRECTORY}/`;
        const markerIndex = requestPath.indexOf(marker);
        if (markerIndex < 0) {
          next();
          return;
        }
        const fileName = requestPath.slice(markerIndex + marker.length);
        const asset = assetMap.get(fileName);
        // 白名单外一律放行给后续中间件（含 vite 的 404），不在此猜测其它路径
        if (!asset) {
          next();
          return;
        }
        void asset
          .source()
          .then((source) => {
            response.setHeader(
              "Content-Type",
              fileName.endsWith(".wasm") ? "application/wasm" : "text/javascript",
            );
            response.end(source);
          })
          .catch((error: unknown) => {
            response.statusCode = 500;
            response.end(
              `dwg asset ${fileName} read failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      });
    },
  };
}
