/**
 * 开发/测试用的 ESM resolve hook：把 `./x.js` fallback 到 `./x.ts`。
 *
 * ## 为什么需要
 *
 * 仓库约定「包内导入统一带 `.js` 后缀」（NodeNext ESM 规则，见各包 tsconfig
 * 注释），而 `@zcode/shared` 等包的 `exports` 指向 `./src/*.ts`（源码直引，
 * 服务于 tsc 工程引用）。两者叠加的后果：
 *
 *   import ... from "@zcode/shared"  →  读到 src/index.ts
 *   src/index.ts 里 import "./cloudContent.js"  →  Node 24 的 type stripping
 *                                                        不做 .js→.ts fallback
 *   → ERR_MODULE_NOT_FOUND
 *
 * Node 24 能跑 .ts（type stripping 已默认启用），但**不会**把 `.js` 解析到
 * 同名 `.ts`。生产不受影响（打包走 dist，dist 内是自洽的 .js 链），
 * 但任何直接加载 src 直引链的脚本都会中招 —— 包括本仓的 dist 产物
 * （dist 里 `import "@zcode/shared"` 仍会跳到 src）。
 *
 * ## 用法
 *
 *   node --import ./scripts/dev/ts-resolve-hook.mjs your-script.mjs
 *
 * 只做「.js 找不到时试同名 .ts」这一件事，不改其它解析行为。
 */

import { register } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

register(
  "./ts-resolve-loader.mjs",
  import.meta.url,
);

// 同时导出手动版，供不支持 --import 的场景用
export function resolveTsFallback(specifier, parentURL) {
  if (!specifier.startsWith(".") || !specifier.endsWith(".js")) return null;
  try {
    const resolved = new URL(specifier, parentURL);
    const tsPath = fileURLToPath(resolved).replace(/\.js$/, ".ts");
    if (existsSync(tsPath)) return pathToFileURL(tsPath).href;
    const tsxPath = tsPath.replace(/\.ts$/, ".tsx");
    if (existsSync(tsxPath)) return pathToFileURL(tsxPath).href;
  } catch {
    /* ignore */
  }
  return null;
}

void resolveTsFallback;
