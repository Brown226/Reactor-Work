import { useEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * PDF 文本层选区浮动菜单（P0b）：复制 / 引用进会话 / 解释 / 翻译 / 提问。
 * 挂在 PaperModePanel 根节点上监听 selection；PDF.js 文本层是真实 DOM 文本。
 */
export interface PdfSelectionMenuProps {
  containerRef: React.RefObject<HTMLElement | null>;
  onCopy: (text: string) => void;
  onQuote: (text: string) => void;
  onExplain: (text: string) => void;
  onTranslate: (text: string) => void;
  /** 提问：把选中原文与提问前缀放进输入框，等用户补完问题后由用户自己发送。 */
  onAsk: (text: string) => void;
  labels?: {
    copy?: string;
    quote?: string;
    explain?: string;
    translate?: string;
    ask?: string;
  };
}

interface MenuState {
  x: number;
  y: number;
  text: string;
}

export function PdfSelectionMenu({
  containerRef,
  onCopy,
  onQuote,
  onExplain,
  onTranslate,
  onAsk,
  labels,
}: PdfSelectionMenuProps) {
  const { intl } = useZCodeIntl();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const readSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        return;
      }
      const text = selection.toString().trim();
      if (text.length < 2) return;
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return;
      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setMenu({
        x: rect.left - containerRect.left + rect.width / 2,
        y: rect.top - containerRect.top,
        text,
      });
    };

    const onMouseUp = () => {
      // 等 selection 稳定
      window.setTimeout(readSelection, 0);
    };
    const onScrollOrResize = () => setMenu(null);

    container.addEventListener("mouseup", onMouseUp);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      container.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("scroll", onScrollOrResize, true);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [containerRef]);

  if (!menu) return null;

  const act = (fn: (text: string) => void) => {
    fn(menu.text);
    setMenu(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div
      className="absolute z-20 flex -translate-x-1/2 -translate-y-full gap-1 rounded-lg border border-border bg-surface p-1 shadow-md"
      style={{ left: menu.x, top: menu.y - 8 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="rounded-md px-2 py-1 text-ui-base hover:bg-surface-sunken"
        onClick={() => act(onCopy)}
      >
        {labels?.copy ?? intl.formatMessage({ id: "paperMode.action.copy" })}
      </button>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-ui-base font-medium text-primary hover:bg-surface-sunken"
        onClick={() => act(onQuote)}
      >
        {labels?.quote ?? intl.formatMessage({ id: "paperMode.quoteIntoComposer" })}
      </button>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-ui-base hover:bg-surface-sunken"
        onClick={() => act(onExplain)}
      >
        {labels?.explain ?? intl.formatMessage({ id: "paperMode.action.explain" })}
      </button>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-ui-base hover:bg-surface-sunken"
        onClick={() => act(onTranslate)}
      >
        {labels?.translate ?? intl.formatMessage({ id: "paperMode.action.translate" })}
      </button>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-ui-base hover:bg-surface-sunken"
        onClick={() => act(onAsk)}
      >
        {labels?.ask ?? intl.formatMessage({ id: "paperMode.action.ask" })}
      </button>
    </div>
  );
}
