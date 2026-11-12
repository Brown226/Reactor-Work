/**
 * ocr-tools 打包：esbuild 打成单文件 MCP server（无原生资产）。
 *
 * 依赖全部内联，**不能把 @modelcontextprotocol/server 留在 external**：插件 server 由
 * agent 的 plugin-host 以 import() 载入，bare import 从 seed 缓存副本
 * （~/.reactor/cli/plugins/cache/...）向上找不到该包，进程直接
 * "Cannot find package" 退出，面板只看到「MCP 进程启动失败」。file-tools 同样内联。
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
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

console.log("[ocr-tools] build → dist/mcp/server.js");
