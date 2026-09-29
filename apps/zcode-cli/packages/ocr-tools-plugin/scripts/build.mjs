/**
 * ocr-tools 打包：esbuild 打成单文件 MCP server（无原生资产）。
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "..", "dist", "mcp");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "..", "src", "server.ts")],
  outfile: join(outDir, "server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@modelcontextprotocol/server"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

console.log("[ocr-tools] build → dist/mcp/server.js");
