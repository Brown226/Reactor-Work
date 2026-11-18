/**
 * [本地定制] DS-Bot 视图的 Markdown 渲染 —— 接到 Rakazo chat-ui。
 *
 * 演进轨迹（为什么是现在这个实现）：
 *   1. 最初 shim 到 Reactor 的 Streamdown —— 能用，但和主会话抢同一套内核；
 *   2. 现在换成 Rakazo chat-ui —— 它在 Markdown 渲染这一层质量明显更高：
 *      严格 TS、36% 测试覆盖、Mermaid 图、表格横向滚动与列宽、链接 favicon、
 *      复制失败兜底对话框。这些 Streamdown 都没有或更弱。
 *
 * 为什么可以两套内核并存：Bot 集群是**独立的子应用**（自带 DS-Bot 的样式与布局），
 * 它的消息渲染用哪套 Markdown 不影响 Reactor 主会话；上游 Rakazo 自己也是这么分层的
 * （chat-ui 是独立包，web 与 native 各一份）。
 *
 * 为什么用 h() 而不是 JSX：本文件是 .js（与其它适配层一致），
 * Reactor 的构建对 .js 不开 JSX 转换。
 */
import { createElement as h } from "react";
import { RakazoMarkdown } from "@/bot/vendor/rakazo-chat-ui/index.js";

export function MarkdownText({ text, variant }) {
  if (typeof text !== "string" || text.length === 0) return null;
  // 上游的契约是 { children: string; streaming?: boolean }，没有 className/text。
  // 外层留白交给 DS-Bot 自己的 .bt-md 样式（见 vendor 的 markdown.web.css），
  // 这里用一层 span 承载 variant 语义，避免把 className 塞进不认识的 prop。
  return h(
    "span",
    { className: variant === "quote" ? "bt-md bt-md-quote" : "bt-md" },
    h(
      RakazoMarkdown,
      {
        // DS-Bot 的历史消息是整段拉取后重画的，没有增量片段：
        // 关掉「流式中」的未闭合语法补全，避免把代码里的星号当粗体补全。
        streaming: false,
      },
      text,
    ),
  );
}
