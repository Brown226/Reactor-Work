/**
 * [本地定制] DS-Bot 视图的 Markdown 渲染 —— 接到 Reactor 的 Streamdown。
 *
 * 上游用的是 dsh 的 MarkdownText（含代码块复制、mention 链接拦截）。Reactor 的
 * Streamdown 已经有等价能力（代码高亮、复制、表格、KaTeX），这里只做接口适配。
 *
 * 为什么用 h() 而不是 JSX：本文件是 .js（与 vendor 的其它适配层一致），
 * Reactor 的构建对 .js 不开 JSX 转换。
 */
import { createElement as h } from "react";
import { Streamdown } from "streamdown";

export function MarkdownText({ text, variant }) {
  if (typeof text !== "string" || text.length === 0) return null;
  return h(
    Streamdown,
    {
      // 上游的 variant 区分正文 / 引用等场景；这里只影响间距，不覆盖 DS-Bot 的字号。
      className: variant === "quote" ? "bt-md bt-md-quote" : "bt-md",
      // 历史消息全部按完成态渲染：DS-Bot 的视图是一次拉取后整体重画的，
      // 没有增量流式片段，用 streaming 模式反而会触发 remend 补全破坏正文。
      mode: "static",
    },
    text,
  );
}
