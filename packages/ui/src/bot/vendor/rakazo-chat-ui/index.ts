/**
 * [本地定制] Rakazo chat-ui —— 消息渲染层（Apache-2.0）。
 *
 * 来源：[elie222/rakazo](https://github.com/elie222/rakazo) 的 `packages/chat-ui/src/`。
 * 只搬渲染相关文件，不搬 native 版（那需要 react-native 运行时）。
 *
 * 与上游的差异（全部集中在 rakazoShims.ts / rakazoUiWeb.jsx）：
 * - `@rakazo/contracts` 的 droppedTableHtmlText → 内联实现（40 行纯函数）
 * - `@rakazo/ui-tokens` 的 cssVariableName / pageIconBars → 内联
 * - `@rakazo/core/egress` 的 urlSite → 复用 Reactor 的 tldts
 * - `@rakazo/ui-web` 的 AlertDialog / useCopyText → 用 Reactor 的 Dialog 原语重实现
 *
 * 对外只暴露一个组件：RakazoMarkdown。
 */
export { ChatMarkdown as RakazoMarkdown } from "./markdown.web.js";
export { defaultMarkdownCopy, useMarkdownCopy } from "./markdown-copy.js";
export { isMermaidFence } from "./mermaid.js";
