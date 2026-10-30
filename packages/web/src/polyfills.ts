/**
 * Chromium 109 运行时垫片，只由 Web 入口（packages/web/src/main.tsx）首个 import 引入。
 *
 * 原因：公司内 Win7 客户端最高只能升到 Chromium 109，而共享 UI 层直接调用
 * `Array.prototype.toSorted`（Chrome 110 起提供）。在 109 上渲染主界面会抛
 * `TypeError: toSorted is not a function`，错误边界接管整个工作区，界面显示
 * “这块界面出了点问题”。实测该 API 是产物里唯一超出 Chrome 109 的 JS 能力。
 *
 * 为什么不改共享代码：桌面端运行在 Electron 41（Chromium 142），原生支持该方法。
 * 把共享实现改成 `[...].sort()` 等于为旧浏览器拖累主线，因此兼容只留在 Web 入口。
 *
 * 为什么用特性检测：支持原生实现的浏览器直接跳过，语义与性能都不变；桌面端入口
 * 不引用本文件，产物中不含这段代码。
 */
if (typeof Array.prototype.toSorted !== "function") {
  Object.defineProperty(Array.prototype, "toSorted", {
    // 与规范一致：不修改原数组；用 slice 复制以保留稀疏数组中的空洞语义。
    value: function toSorted<T>(this: T[], compareFn?: (a: T, b: T) => number): T[] {
      const copy = Array.prototype.slice.call(this) as T[];
      return compareFn ? copy.sort(compareFn) : copy.sort();
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export {};
