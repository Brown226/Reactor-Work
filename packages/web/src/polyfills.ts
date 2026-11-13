/**
 * Chromium 109 运行时垫片，只由 Web 入口（packages/web/src/main.tsx）首个 import 引入。
 *
 * 原因：公司内 Win7 客户端最高只能升到 Chromium 109，而共享 UI 层直接调用
 * `Array.prototype.toSorted`（Chrome 110 起提供），pdf.js（PDF 预览）还用了
 * `Promise.withResolvers`（Chrome 119 起提供）。在 109 上分别抛
 * `TypeError: toSorted is not a function` / `Promise.withResolvers is not a function`，
 * 错误边界接管对应区域，界面显示“这块界面出了点问题”——PDF/PPT 预览因此打不开。
 *
 * 为什么不改共享代码：桌面端运行在 Electron 41（Chromium 142），原生支持这些方法。
 * 把共享实现改成旧写法等于为旧浏览器拖累主线，因此兼容只留在 Web 入口。
 *
 * 为什么用特性检测：支持原生实现的浏览器直接跳过，语义与性能都不变；桌面端入口
 * 不引用本文件，产物中不含这段代码。
 */

// 在补垫片之前记录浏览器原生能力：pdf.js 5.x 依赖 Chrome 119+ 的 API，
// Chromium 109 即使补齐垫片，canvas 渲染仍不出内容（实测全白）。
// 旧浏览器改用浏览器内置 PDF 查看器（iframe），共享组件按该标记切换。
(globalThis as unknown as Record<string, unknown>).__REACTOR_LEGACY_PDF_VIEWER__ =
  typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== "function";

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

// pdf.js（react-pdf）用 Promise.withResolvers 建加载任务；Chrome 109 没有。
if (typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== "function") {
  Object.defineProperty(Promise, "withResolvers", {
    value: function withResolvers<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

// pdf.js 解析文档内链接时用 URL.parse（Chrome 126）；109 上抛 “URL.parse is not a function”。
if (typeof (URL as unknown as { parse?: unknown }).parse !== "function") {
  Object.defineProperty(URL, "parse", {
    value: function parse(url: string, base?: string): URL | null {
      try {
        return base === undefined ? new URL(url) : new URL(url, base);
      } catch {
        return null;
      }
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
if (typeof (URL as unknown as { canParse?: unknown }).canParse !== "function") {
  Object.defineProperty(URL, "canParse", {
    value: function canParse(url: string, base?: string): boolean {
      try {
        base === undefined ? new URL(url) : new URL(url, base);
        return true;
      } catch {
        return false;
      }
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

// Chrome 110 的不可变数组方法（共享 UI 与 pdf.js 都可能用到）。
if (typeof (Array.prototype as unknown as { toReversed?: unknown }).toReversed !== "function") {
  Object.defineProperty(Array.prototype, "toReversed", {
    value: function (this: unknown[]) {
      return Array.prototype.slice.call(this).reverse() as unknown[];
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
if (typeof (Array.prototype as unknown as { toSpliced?: unknown }).toSpliced !== "function") {
  Object.defineProperty(Array.prototype, "toSpliced", {
    value: function (this: unknown[], start: number, deleteCount?: number, ...items: unknown[]) {
      const copy = Array.prototype.slice.call(this) as unknown[];
      if (deleteCount === undefined) copy.splice(start);
      else copy.splice(start, deleteCount, ...items);
      return copy;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
if (typeof (Array.prototype as unknown as { with?: unknown }).with !== "function") {
  Object.defineProperty(Array.prototype, "with", {
    value: function (this: unknown[], index: number, value: unknown) {
      const copy = Array.prototype.slice.call(this) as unknown[];
      const normalized = index < 0 ? copy.length + index : index;
      if (normalized < 0 || normalized >= copy.length) throw new RangeError("Invalid index");
      copy[normalized] = value;
      return copy;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

// pdf.js 5.x 还用了 Promise.try（Chrome 128）与 Uint8Array 的 base64/hex 扩展
// （fromBase64 / toBase64 / toHex，Chrome 140）。Chromium 109 全都没有，
// 缺失时渲染管线静默失败：canvas 已创建、页码正常，但内容全白。
const promiseWith = Promise as unknown as { try?: unknown };
if (typeof promiseWith.try !== "function") {
  Object.defineProperty(Promise, "try", {
    value: function tryFn<T>(fn: (...args: unknown[]) => T | PromiseLike<T>, ...args: unknown[]) {
      return new Promise<T>((resolve) => resolve(fn(...args)));
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

const uint8With = Uint8Array as unknown as Record<string, unknown>;
if (typeof uint8With.fromBase64 !== "function") {
  Object.defineProperty(Uint8Array, "fromBase64", {
    value: function fromBase64(value: string, options?: { alphabet?: "base64" | "base64url" }) {
      const normalized =
        options?.alphabet === "base64url"
          ? value.replace(/-/g, "+").replace(/_/g, "/")
          : value;
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
if (typeof (Uint8Array.prototype as unknown as { toBase64?: unknown }).toBase64 !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    value: function toBase64(this: Uint8Array) {
      let binary = "";
      const chunk = 0x8000;
      for (let index = 0; index < this.length; index += chunk) {
        binary += String.fromCharCode(...this.subarray(index, index + chunk));
      }
      return btoa(binary);
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
if (typeof (Uint8Array.prototype as unknown as { toHex?: unknown }).toHex !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    value: function toHex(this: Uint8Array) {
      let hex = "";
      for (let index = 0; index < this.length; index += 1) {
        hex += (this[index] ?? 0).toString(16).padStart(2, "0");
      }
      return hex;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export {};
