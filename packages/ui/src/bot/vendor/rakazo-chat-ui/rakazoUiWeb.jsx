/**
 * [本地定制] Rakazo ui-web 的最小垫片 —— 供 chat-ui 的 Markdown 渲染使用。
 *
 * 上游 `@rakazo/ui-web` 是一个完整的 shadcn 风格组件库（71 文件）。chat-ui 只用到
 * 两部分：
 *   1. AlertDialog 一组（链接复制失败时的兜底对话框）
 *   2. useCopyText / CopyTextFallback（复制反馈）
 *
 * 所以这里不搬整包，只实现这两个，其余用 Reactor 已有的 dialog 原语。
 * 好处：Reactor 的对话框已经带主题、键盘、移动端适配，比再搬一套更贴合。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createElement as h } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";

/* ------------------------------------------------------------------ *
 * 剪贴板
 * ------------------------------------------------------------------ */

/**
 * 通过隐藏 textarea + execCommand 复制：在请求的点击事件内可用，
 * 而 Clipboard API 在纯 http 的自托管场景下不存在。
 */
function copyBySelection(text) {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
  // 放在聚焦控件旁边，让对话框的焦点陷阱允许这次选中发生。
  (active?.parentElement ?? document.body).append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  active?.focus({ preventScroll: true });
  return copied;
}

/** 先走浏览器复制，失败再退回选区方案。 */
export async function writeClipboard(text, isCurrent = () => true) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 桌面文档在点击 Copy 时可能失去焦点，继续走兜底。
  }
  if (!isCurrent()) return false;
  return copyBySelection(text);
}

/**
 * 复制 + 短暂的「已复制」反馈。
 * 返回 [copied, copy, failed, reset, failedText]——与上游同签名，
 * 因为 chat-ui 的消费点按位置解构它。
 */
export function useCopyText() {
  const [state, setState] = useState({ status: "idle", text: "" });
  const attemptRef = useRef(0);
  const timerRef = useRef(null);

  useEffect(
    () => () => {
      // 卸载后才落定的复制不能开启新的反馈计时器。
      attemptRef.current++;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback((text) => {
    const attempt = ++attemptRef.current;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    // 上一次的确认到此结束；永不落定的写入不能让它一直亮着。
    setState((current) => (current.status === "copied" ? { status: "idle", text: "" } : current));
    return writeClipboard(text, () => attempt === attemptRef.current).then((ok) => {
      // 更新的尝试已经取代了这一次，由它决定结果。
      if (attempt !== attemptRef.current) return false;
      setState({ status: ok ? "copied" : "failed", text: ok ? "" : text });
      if (ok) {
        timerRef.current = window.setTimeout(() => {
          if (attempt === attemptRef.current) setState({ status: "idle", text: "" });
        }, 1400);
      }
      return ok;
    });
  }, []);

  const reset = useCallback(() => {
    attemptRef.current++;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setState({ status: "idle", text: "" });
  }, []);

  return [state.status === "copied", copy, state.status === "failed", reset, state.text];
}

/* ------------------------------------------------------------------ *
 * AlertDialog —— 用 Reactor 的 Dialog 原语实现同语义
 * ------------------------------------------------------------------ */

const AlertDialogContext = [null];
void AlertDialogContext;

/**
 * 上游的 AlertDialog 是受控的、带标题/描述/页脚的确认框。
 * chat-ui 只用来做「复制失败，请手动选择」这一种场景，所以这里保持同一套
 * 组件命名与 props，内部换成 Reactor 的 Dialog。
 */
export function AlertDialog({ open, onOpenChange, children }) {
  return h(
    Dialog,
    { open: Boolean(open), onOpenChange: (next) => onOpenChange?.(next) },
    h(DialogContent, { className: "max-w-md gap-4" }, children),
  );
}

export function AlertDialogContent({ children }) {
  return children ?? null;
}

export function AlertDialogHeader({ children }) {
  return h("div", { className: "flex flex-col gap-1.5" }, children);
}

export function AlertDialogTitle({ children }) {
  return h(DialogTitle, null, children);
}

export function AlertDialogDescription({ children }) {
  return h(DialogDescription, { className: "text-ui-sm text-foreground-subtle" }, children);
}

export function AlertDialogFooter({ children }) {
  return h(FooterRow, null, children);
}

function FooterRow({ children }) {
  return h("div", { className: "flex justify-end gap-2 pt-1" }, children);
}

export function AlertDialogAction({ children, onClick, ...rest }) {
  return h(Button, { type: "button", onClick, ...rest }, children);
}

export function AlertDialogCancel({ children, onClick, ...rest }) {
  return h(Button, { type: "button", variant: "outline", onClick, ...rest }, children);
}

/** 复制失败时把文本原样显示出来，让用户能手动选中。 */
export function CopyTextFallback({ text }) {
  if (!text) return null;
  return h("textarea", {
    readOnly: true,
    value: text,
    "aria-label": "复制失败的文本",
    className:
      "max-h-40 w-full resize-none rounded-md border border-border bg-surface p-2 font-mono text-ui-sm",
    onFocus: (event) => event.currentTarget.select(),
  });
}

/* markdown-table.tsx 还用到 Dialog 的一组底层组件做「表格放大」对话框，
 * 这里按 Reactor 的 dialog 原语补上同名导出。 */

export { Dialog, DialogContent, DialogTitle };

export function DialogClose({ children }) {
  return children ?? null;
}
