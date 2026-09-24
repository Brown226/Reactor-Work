import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderAsync, type Options } from "docx-preview";
import {
  calculateDocxPreviewFit,
  installDocumentLinkSafety,
  type DocxPreviewFit,
} from "@/lib/officeFilePreview.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { scheduleReviewQuoteHighlight } from "@/lib/quoteHighlightDom.js";
import { ReviewQuoteCallout } from "@/review/ReviewQuoteCallout.js";
import { useReviewMarksStore } from "@/store/reviewMarksStore.js";
import type { QuoteHighlightTarget } from "@/lib/quoteSearch.js";
import { logger } from "@/logger.js";

const DOCX_RENDER_OPTIONS = {
  breakPages: true,
  debug: false,
  experimental: true,
  ignoreFonts: false,
  ignoreHeight: false,
  // docx-preview@0.4.0 在该选项为 false 时会合并纸张尺寸相同、
  // 但页边距不同的相邻 section，导致封面后的正文丢失分页并沿用封面的零边距。
  // 保持官方预览的默认行为，优先保留 OOXML section 边界和各页 pgMar。
  ignoreLastRenderedPageBreak: true,
  ignoreWidth: false,
  inWrapper: true,
  renderAltChunks: false,
  renderChanges: false,
  renderComments: false,
  renderEndnotes: true,
  renderFooters: true,
  renderFootnotes: true,
  renderHeaders: true,
  useBase64URL: true,
} satisfies Partial<Options>;

const DOCX_PAGE_BOX_SHADOW = "0 2px 10px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.05)";

let nextDocxPreviewClassId = 0;

function createDocxPreviewClassName(): string {
  nextDocxPreviewClassId += 1;
  return `zcode-docx-preview-${nextDocxPreviewClassId}`;
}

function isSameDocxPreviewFit(current: DocxPreviewFit | null, next: DocxPreviewFit): boolean {
  return (
    current !== null &&
    Math.abs(current.scale - next.scale) < 0.001 &&
    Math.abs(current.width - next.width) < 0.5 &&
    Math.abs(current.height - next.height) < 0.5
  );
}

export function PreviewPaneOfficeDocxContent({
  buffer,
  errorMessage,
  onOpenBrowserUrl,
  quoteHighlight,
  sourcePath,
}: {
  buffer: ArrayBuffer;
  errorMessage: string;
  onOpenBrowserUrl?: (url: string) => void;
  /** 审查定位：渲染完成后在原件 DOM 里标出这句原文（docx 无字符偏移，只能按片段找） */
  quoteHighlight?: QuoteHighlightTarget;
  sourcePath: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const renderContainerRef = useRef<HTMLDivElement | null>(null);
  const [previewClassName] = useState(createDocxPreviewClassName);
  const [fit, setFit] = useState<DocxPreviewFit | null>(null);
  const [renderState, setRenderState] = useState<"loading" | "ready" | "error">("loading");
  const [quoteMissing, setQuoteMissing] = useState(false);
  const [quoteRange, setQuoteRange] = useState<Range | null>(null);
  const calloutHostRef = useRef<HTMLDivElement | null>(null);
  const { intl } = useZCodeIntl();
  const quoteMark = quoteHighlight?.mark;
  const quoteMarked = useReviewMarksStore((state) =>
    quoteMark ? Boolean(state.marks[quoteMark.key]) : false,
  );
  const toggleQuoteMark = useReviewMarksStore((state) => state.toggle);
  const onToggleQuoteMark = useCallback(() => {
    if (!quoteMark) return;
    toggleQuoteMark(quoteMark);
  }, [quoteMark, toggleQuoteMark]);


  const updateFit = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || renderState !== "ready") {
      return;
    }

    const next = calculateDocxPreviewFit({
      availableWidth: viewport.clientWidth,
      naturalHeight: content.offsetHeight,
      naturalWidth: content.offsetWidth,
    });
    if (!next) {
      return;
    }

    setFit((current) => {
      if (isSameDocxPreviewFit(current, next)) {
        return current;
      }
      // 调试说明：拖动 Preview Pane 时会按帧触发 ResizeObserver；高频尺寸轨迹只走 debug，
      // 生产构建不落盘，避免响应式布局把日志量放大到和 resize 事件同数量级。
      logger.debug("[PreviewPane] DOCX 预览宽度已同步", {
        path: sourcePath,
        availableWidth: viewport.clientWidth,
        naturalWidth: content.offsetWidth,
        scale: next.scale,
      });
      return next;
    });
  }, [renderState, sourcePath]);

  useEffect(() => {
    const visibleContainer = renderContainerRef.current;
    if (!visibleContainer) {
      return;
    }

    let active = true;
    let disposeLinkSafety: (() => void) | undefined;
    const className = previewClassName;
    const renderRoot = document.createElement("div");
    const styleContainer = document.createElement("div");
    const bodyContainer = document.createElement("div");
    renderRoot.dataset.docxRenderRoot = "";
    styleContainer.dataset.docxRenderStyles = "";
    bodyContainer.dataset.docxRenderBody = "";
    renderRoot.append(styleContainer, bodyContainer);

    setRenderState("loading");
    setFit(null);
    visibleContainer.replaceChildren();

    void renderAsync(buffer, bodyContainer, styleContainer, {
      ...DOCX_RENDER_OPTIONS,
      className,
    })
      .then(() => {
        if (!active) {
          return;
        }

        const wrapper = bodyContainer.querySelector<HTMLElement>(`.${className}-wrapper`);
        if (wrapper) {
          // docx-preview 默认给页面包装层写入灰色背景和固定 30px padding，
          // 会与 Preview Pane 主题冲突，也会让窄屏缩放把装饰间距算进纸张宽度。
          wrapper.style.background = "transparent";
          wrapper.style.padding = "0";
          wrapper.style.width = "max-content";
        }

        // docx-preview 默认使用 50% 黑色页面阴影，在 Preview Pane 中会形成过深黑边；
        // 追加作用域样式复用原 react-docx 的浅色纸张阴影，并一次覆盖当前文档的所有页面。
        const pageSurfaceStyle = document.createElement("style");
        pageSurfaceStyle.dataset.docxPageSurfaceStyle = "";
        pageSurfaceStyle.textContent = `.${className}-wrapper>section.${className} { box-shadow: ${DOCX_PAGE_BOX_SHADOW}; }`;
        styleContainer.append(pageSurfaceStyle);

        disposeLinkSafety = installDocumentLinkSafety(renderRoot, onOpenBrowserUrl);

        visibleContainer.replaceChildren(renderRoot);
        setRenderState("ready");
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        logger.error("[PreviewPane] DOCX 文件解析失败", {
          path: sourcePath,
          error: message,
        });
        visibleContainer.replaceChildren();
        setRenderState("error");
      });

    return () => {
      // renderAsync 不提供取消能力；切换文件后只允许最新 source 提交可见 DOM，
      // 旧任务即使稍后完成也只能停留在脱离文档树的临时容器中。
      active = false;
      disposeLinkSafety?.();
      renderRoot.remove();
      visibleContainer.replaceChildren();
    };
  }, [buffer, onOpenBrowserUrl, previewClassName, sourcePath]);

  // 原件里的审查定位：docx 渲染完才有 DOM 文本，按「片段 + 第几处」重新找一次并滚过去。
  // 找不到就**不画**（标错地方比不标更误导复核者），只给一行提示让用户自己搜。
  useEffect(() => {
    const quote = quoteHighlight?.quote;
    if (renderState !== "ready" || !quote) {
      setQuoteMissing(false);
      setQuoteRange(null);
      return undefined;
    }
    return scheduleReviewQuoteHighlight({
      getRoot: () => renderContainerRef.current,
      quote,
      occurrence: quoteHighlight?.occurrence ?? null,
      onSettled: (range) => {
        setQuoteRange(range);
        setQuoteMissing(range === null);
      },
    });
    // fit.scale 必须进依赖：docx 先按原始纸张尺寸渲染、再按可用宽度缩放，缩放提交前量到的是
    // 旧几何，滚完内容一收缩命中就跑到视口外（用户得自己往上翻）。缩放定稿后重跑一次即可对齐。
  }, [
    fit?.scale,
    quoteHighlight?.focusRequestId,
    quoteHighlight?.occurrence,
    quoteHighlight?.quote,
    renderState,
  ]);

  useLayoutEffect(() => {
    if (renderState !== "ready") {
      return;
    }

    updateFit();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(updateFit);
    if (viewportRef.current) {
      resizeObserver.observe(viewportRef.current);
    }
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current);
    }
    return () => {
      resizeObserver.disconnect();
    };
  }, [renderState, updateFit]);

  return (
    <div
      ref={calloutHostRef}
      aria-busy={renderState === "loading" ? "true" : undefined}
      className="relative h-full min-h-0 w-full min-w-0 bg-background"
      data-office-preview-kind="docx"
      data-office-preview-pending={renderState === "loading" ? "" : undefined}
    >
      {renderState === "error" ? (
        <div className="p-3 text-ui-base text-destructive" role="alert">
          {errorMessage}
        </div>
      ) : null}
      {quoteMissing ? (
        <div className="border-b border-amber-500/40 bg-amber-500/5 px-3 py-2 text-ui-sm">
          {intl.formatMessage({ id: "review.quote.notFound" })}
        </div>
      ) : null}
      <div
        className={
          renderState === "error"
            ? "hidden"
            : "h-full min-h-0 w-full min-w-0 overflow-auto p-4 max-sm:p-2"
        }
      >
        <div ref={viewportRef} className="w-full min-w-0" data-docx-fit-viewport>
          <div
            className="relative mx-auto"
            data-docx-fit-frame
            style={fit ? { width: fit.width, height: fit.height } : undefined}
          >
            {/* docx-preview 保留纸张原始宽度；窄 Preview Pane 需要只缩小不放大，
                并同步包装层宽高，避免单独 transform 后仍保留未缩放的横向滚动区。 */}
            <div
              ref={contentRef}
              className="w-max"
              data-docx-fit-content
              style={
                fit
                  ? {
                      position: "absolute",
                      left: 0,
                      top: 0,
                      transform: `scale(${fit.scale})`,
                      transformOrigin: "top left",
                    }
                  : undefined
              }
            >
              <div ref={renderContainerRef} />
            </div>
          </div>
        </div>
      </div>
      {/* 定位卡挂在**不滚动**的外层：卡片不跟着内容滚，也不吃 docx 的 scale 缩放 */}
      <ReviewQuoteCallout
        range={quoteRange}
        note={quoteHighlight?.note}
        hostRef={calloutHostRef}
        marked={quoteMarked}
        {...(quoteMark ? { onToggleMarked: onToggleQuoteMark } : {})}
        onDismiss={() => setQuoteRange(null)}
      />
    </div>
  );
}
