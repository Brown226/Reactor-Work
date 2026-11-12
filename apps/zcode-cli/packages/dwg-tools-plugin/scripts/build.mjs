/**
 * dwg-tools MCP server bundle（ESM + createRequire banner）。
 * 无 npm 原生绑定；DWG 引擎在 dwg-sidecar 资产树（.NET 自包含）。
 *
 * 依赖全部内联，**不能把 @modelcontextprotocol/server 留在 external**：插件 server 由
 * agent 的 plugin-host 以 import() 载入，bare import 从 seed 缓存副本
 * （~/.reactor/cli/plugins/cache/...）向上找不到该包，进程直接
 * "Cannot find package" 退出，面板只看到「MCP 进程启动失败」。file-tools 同样内联。
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
  format: "esm",
  legalComments: "none",
  outfile,
  platform: "node",
  target: "node24",
});

console.log("[dwg-tools] build → dist/mcp/server.js");
