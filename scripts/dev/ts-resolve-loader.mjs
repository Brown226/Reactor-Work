/**
 * `ts-resolve-hook.mjs` 的 loader 端：实现 `.js` → `.ts` fallback。
 *
 * 独立成文件是因为 `register()` 要求 loader 模块与注册模块分离
 * （同文件会重复初始化）。
 */

export async function resolve(specifier, context, next) {
  // 只处理相对导入的 .js，且仅在默认解析失败时 fallback
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    try {
      return await next(specifier, context);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
        throw error;
      }
      // 试同名 .ts / .tsx
      for (const replacement of [".ts", ".tsx"]) {
        const candidate = specifier.replace(/\.js$/, replacement);
        try {
          return await next(candidate, context);
        } catch {
          /* try next candidate */
        }
      }
      throw error;
    }
  }
  return next(specifier, context);
}
