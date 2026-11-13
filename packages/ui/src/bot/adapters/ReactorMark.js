/**
 * [本地定制] DS-Bot 视图用的产品标记 —— Reactor 版。
 *
 * 上游 FishLogo 是 dsh 的 Agent 标记，DS-Bot 只在「这条消息来自 DSH Agent」时画它。
 * Reactor 里没有 DSH Agent，但那个位置是侧栏顶部的品牌位，换成 Reactor 标记更合理：
 * 上游自己的桌面壳在同一个位置就是返回 null（app/ui/src/primitives.js）。
 *
 * 用 h() 而非 JSX：本文件是 .js，构建不对 .js 开 JSX 转换。
 */
import { createElement as h } from "react";

export function ReactorMark({ size = 22, className }) {
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      "aria-hidden": "true",
      className,
    },
    h("rect", { x: 2, y: 2, width: 20, height: 20, rx: 6, fill: "currentColor", opacity: 0.14 }),
    h("path", {
      d: "M8 17V7h5.2a3.4 3.4 0 0 1 .6 6.74L17 17h-2.9l-2.9-3.1H10V17H8Zm2-5h3.1a1.5 1.5 0 0 0 0-3H10v3Z",
      fill: "currentColor",
    }),
  );
}
