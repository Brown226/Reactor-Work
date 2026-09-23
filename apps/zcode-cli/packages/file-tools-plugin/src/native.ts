/**
 * native / ONNX / canvas 绑定的双路径惰性加载。
 *
 * esbuild bundle 已把原生依赖标记为 external（要么是 .node 二进制，要么是按平台
 * 分发的完整目录，无法内联）。运行时按两条路径解析：
 * 1. 裸 require：源码运行（tsx/test）时依赖在 workspace node_modules 里；
 * 2. 资产目录：桌面打包态，MCP 子进程跑在插件 seed 缓存副本里，没有 node_modules，
 *    从 resources/tools/file-tools 按 Node 目录布局加载。
 */
import { join } from "node:path";
import { createRequire } from "node:module";
import { anydocEntryDir, onnxruntimeEntryDir, resolveFileToolsAssets } from "./assets.js";

/** dist bundle 自带 createRequire banner；源码（tsx）下这里兜底创建。 */
const runtimeRequire =
  typeof require === "function" ? require : createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any -- 原生绑定无精确类型，调用面已收窄。 */
type AnyNative = any;

interface AnydocModule {
  toMarkdownBytes(bytes: Uint8Array, format?: string | null): Promise<string>;
  toMarkdown?(path: string): Promise<string>;
}

let anydocModule: AnydocModule | null | undefined;

export function loadAnydoc(): AnydocModule {
  if (anydocModule) return anydocModule;
  // 1) 源码/工作区态：依赖声明的版本。
  try {
    const mod = runtimeRequire("@firecrawl/anydoc") as AnydocModule;
    anydocModule = mod;
    return mod;
  } catch {
    // 继续走资产目录。
  }
  // 2) 打包态：资产目录按 Node 目录布局摆放，require 目录由其 package.json main 解析。
  const assets = resolveFileToolsAssets();
  if (assets.anydocDir) {
    const entry = anydocEntryDir(assets.anydocDir);
    try {
      const mod = runtimeRequire(entry) as AnydocModule;
      anydocModule = mod;
      return mod;
    } catch (error) {
      throw new Error(
        `anydoc 资产加载失败（${entry}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error("未找到 anydoc 原生资产（file-tools 资产不完整）");
}

function hasAnydoc(): boolean {
  try {
    return loadAnydoc() !== null;
  } catch {
    return false;
  }
}

let onnxruntimeModule: AnyNative | undefined;

export function loadOnnxruntime(): AnyNative {
  if (onnxruntimeModule !== undefined) return onnxruntimeModule;
  try {
    onnxruntimeModule = runtimeRequire("onnxruntime-node");
    return onnxruntimeModule;
  } catch {
    // 继续走资产目录。
  }
  const assets = resolveFileToolsAssets();
  if (assets.onnxruntimeDir) {
    const entry = onnxruntimeEntryDir(assets.onnxruntimeDir);
    try {
      onnxruntimeModule = runtimeRequire(entry);
      return onnxruntimeModule;
    } catch (error) {
      throw new Error(
        `onnxruntime-node 资产加载失败（${entry}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error("未找到 onnxruntime-node 原生资产（file-tools 资产不完整）");
}

function hasOnnxruntime(): boolean {
  try {
    return loadOnnxruntime() !== undefined;
  } catch {
    return false;
  }
}

/** @napi-rs/canvas：运行时 require 平台 skia .node，同样双路径。 */
export function loadCanvasModule(): AnyNative {
  try {
    return runtimeRequire("@napi-rs/canvas");
  } catch {
    // 继续走资产目录。
  }
  const assets = resolveFileToolsAssets();
  if (assets.canvasDir) {
    const entry = join(assets.canvasDir, "node_modules", "@napi-rs", "canvas");
    try {
      return runtimeRequire(entry);
    } catch (error) {
      throw new Error(
        `@napi-rs/canvas 资产加载失败（${entry}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error("未找到 @napi-rs/canvas 资产（file-tools 资产不完整）");
}
