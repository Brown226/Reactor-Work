/**
 * [本地定制] DS-Bot 视图用到的宿主界面原语 —— Reactor 版。
 *
 * 上游 DS-Bot 把这些原语放在 `@deepseek-ai/dsh-client-ui-primitives`（dsh 私有包）。
 * 它的桌面壳用同样手法解耦：`app/ui/src/primitives.js`（45 行），由 vite 的
 * resolveId 插件把 `ds-bot/src/client/*` 里所有 `./dsh-primitives.js` 的 import
 * 重定向过去。这里就是 Reactor 的等价实现。
 *
 * 只有三个符号是「必然被调用」的（FishLogo / MarkdownText / writeClipboard）；
 * settings-shell.js、settings.js、user-message.js 里另外 import 的符号，
 * 上游自己就以可选方式使用（`ui.fileExtension?.()`、`typeof ui.projectUserText`），
 * 缺省即优雅降级——这里按需导出，不实现的留空。
 */
import { createElement as h } from "react";
import { MarkdownText as ReactorMarkdownText } from "./markdownText.js";
import { ReactorMark } from "./ReactorMark.js";
import { writeClipboard } from "./clipboard.js";

// DSH 的 Agent 标记。Reactor 没有 DSH Agent，且调用方都在有真 Agent 时才渲染它。
export const FishLogo = ReactorMark;

export function MarkdownText({ text, labels, variant }) {
  return h(ReactorMarkdownText, { text, labels, variant });
}

export { writeClipboard };

/* ------------------------------------------------------------------ *
 * 下面这些对应 settings-shell.js / settings.js / user-message.js 的 import。
 * 不实现具体的 dsh 视觉，只提供等价的可运行替身：
 * - Tooltip / Modal / Button：Reactor 已有同名原语，这里用最薄的包装，
 *   避免把 24k 行视图代码绑到 Reactor 的设计 token 上。
 * - ConnectionIndicator：DS Bot 在 Reactor 里没有「连接 dsh」这件事，恒为已连接。
 * - Icon* 五个：lucide 对应项。
 * ------------------------------------------------------------------ */

/** 极薄的 Tooltip：桌面壳里 dsh 的 Tooltip 只负责显示 label，这里退化为 title。 */
export function Tooltip({ label, children, disabled }) {
  if (!children) return null;
  if (disabled || !label) return children;
  // 子节点是单个元素时补 title；否则包一层 span。
  if (typeof children === "object" && children !== null && "props" in children) {
    return h(children.type, { ...children.props, title: label }, children.props.children);
  }
  return h("span", { title: label }, children);
}

export function Modal({ children, onClose, open = true }) {
  if (open === false) return null;
  return h(
    "div",
    {
      role: "dialog",
      "aria-modal": "true",
      className: "bt-modal-shim",
      // 关闭只能通过显式按钮：上游 Modal 自己也接管 Escape，这里不抢键盘。
      onClick: (event) => {
        if (event.target === event.currentTarget) onClose?.();
      },
    },
    children,
  );
}

export function Button({ children, variant, onClick, ...rest }) {
  return h(
    "button",
    {
      type: "button",
      "data-variant": variant ?? "secondary",
      className: "bt-button-shim",
      onClick,
      ...rest,
    },
    children,
  );
}

/** DS Bot 在浏览器里没有「连到 dsh」的状态机；恒为已连接，避免外壳画红点。 */
export function ConnectionIndicator() {
  return null;
}

// 图标：settings.js 用五个 dsh 专用图标做设置导航，用 lucide 的语义对应项。
export {
  ReactorIcon as IconAgentPresetOutlineMedium,
  ArchiveIcon as IconArchiveOutlineMedium,
  PaletteIcon as IconPersonalizationOutlineMedium,
  SettingsIcon as IconSettingsOutlineMedium,
  UserIcon as IconUserOutlineMedium,
  DownloadIcon as IconDownloadOutlineRegular,
  LoaderCircleIcon as IconLoadingOutlineRegular,
} from "./icons.js";

/* user-message.js：这几个都有可选调用保护，缺省即不渲染对应附属信息。
 * projectUserText 决定 canDrawUserMessages() 的真假——它是用户消息气泡的绘制者。
 * 上游只有调用了它才画用户消息；Reactor 的会话里用户消息要在 Bot 视图里看到，
 * 所以这里给一个可用的实现（纯文本 + 引用标签），而不是留空。 */

export function projectUserText(text, referenceLabels, skillNames, skillKey, references) {
  // 上游的形状是 { body, references } 之类；调用方只用它的返回值直接渲染。
  // 这里返回与上游同形状的普通文本结果：保持 text 原样，附带引用标签。
  return {
    text: typeof text === "string" ? text : "",
    references: Array.isArray(references) ? references : [],
    referenceLabels,
    skillNames,
    skillKey,
  };
}

// 以下三个是可选增强：不实现时上游自动跳过（见 user-message.js 的 `?.`）。
export const FileTypeIcon = undefined;
export const JsonBlock = undefined;
export const fileExtension = undefined;
export const fileSizeText = undefined;
