/**
 * dwg-tools MCP server bundle（ESM + createRequire banner）。
 * 无 npm 原生绑定；DWG 引擎在 dwg-sidecar 资产树（.NET 自包含）。
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");

const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

const outfile = resolve(packageRoot, "dist", "mcp", "server.js");
await mkdir(dirname(outfile), { recursive: true });
await build({
  banner: { js: nodeRequireBanner },
  bundle: true,
  entryPoints: [resolve(packageRoot, "src", "server.ts")],
  external: ["@modelcontextprotocol/server", "@modelcontextprotocol/server/*"],
  format: "esm",
  legalComments: "none",
  outfile,
  platform: "node",
  target: "node24",
});

console.log("[dwg-tools] build → dist/mcp/server.js");
