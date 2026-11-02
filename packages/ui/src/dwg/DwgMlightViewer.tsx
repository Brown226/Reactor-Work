/**
 * mlightcad（LibreDWG WASM + three.js）渲染内核的 React 包装。
 *
 * 为什么用它：产品定位是「看图」——块、填充、标注、图层这些 sidecar 手写 SVG
 * 做不完的保真度它开箱即得；它在前端本地解析文件字节，服务端不需要参与渲染。
 *
 * 初始化边界（P0 spike 实测，见 docs/未完成-DWG看图-mlightcad接入方案.md）：
 * - worker/wasm 资产由 dwgViewerAssetsPlugin 提供在 /dwg-assets/；
 * - 字体在 /dwg/fonts/（scripts/fetch-dwg-fonts.mjs 下载，gitignored）；
 *   缺字体时几何仍渲染、文字缺失，用 onNotice 提示，不算失败；
 * - createInstance 会重建 fontLoader，baseUrl 必须传给 DocManager 的 options
 *   （它按 <baseUrl>/fonts/ 拼字体清单 URL），FontManager 再设一份供显式加载；
 * - 文档管理器是全局单例（worker/转换器只初始化一次），组件卸载只关文档会话；
 * - 任何失败都走 onFailed，由父组件决定是否降级到 SVG 兜底。
 *
 * 类型口径：该库是 GPL 第三方包，其 d.ts 的 `export *` 链在 NodeNext 下有名字
 * 歧义折叠（顶层拿不到 AcApDocManager 等），这里用本地接口描述用到的最小 API 面，
 * 以 spike 实测运行为准；不试图给整个库建类型。
 */
import { useEffect, useRef, useState } from "react";
import { dwgPathMatches, onDwgViewerLocate } from "./dwgViewerBus.js";
import {
  appendDwgSelectionQuoteToComposerDraft,
  describeDwgSelection,
  formatDwgQuoteBlock,
  type DwgChatQuoteTarget,
} from "./dwgChatQuote.js";

/**
 * 静态资产地址解析：与 pdfjs 资产同一口径（见 lib/pdfJsAssets.ts）。
 * Web 端 BASE_URL="/" → 源站根；桌面端 BASE_URL="./" 且渲染进程走 file:// →
 * 必须经 `new URL(BASE_URL, location.href)` 推成绝对 file URL，手写 "/dwg-assets/"
 * 在桌面端会解析到磁盘根而 404（2026-11-02 桌面接线时确认）。
 */
function resolveDwgAsset(relativePath: string): string {
  const viteBaseUrl =
    typeof import.meta.env?.BASE_URL === "string" ? import.meta.env.BASE_URL : "/";
  const applicationBaseUrl = new URL(viteBaseUrl, window.location.href);
  return new URL(relativePath, applicationBaseUrl).href;
}

const DWG_ASSETS_BASE = resolveDwgAsset("dwg-assets/");
/** DocManager 的字体库根：实际清单 URL = <root>/fonts/fonts.json。 */
const DWG_FONT_REPO_ROOT = resolveDwgAsset("dwg");
const DWG_FONTS_BASE_URL = resolveDwgAsset("dwg/fonts/");
/** 中文图纸兜底字体链：GB 大字体 + 宋体 + 基础 SHX（cad-data 仓库的最小集）。 */
const DEFAULT_FONT_CHAIN = ["hztxt", "gbcbig", "simsun", "txt", "simplex"];

// ── mlightcad 最小 API 面（运行时契约以 spike 实测为准） ──────────────────

interface DwgEntityExtents {
  minPoint?: { x: number; y: number };
  maxPoint?: { x: number; y: number };
}

interface DwgEntityLike {
  getGeomExtents?: () => DwgEntityExtents | undefined;
}

interface DwgDatabaseLike {
  getAcDbEntityByHandle?(handle: string): DwgEntityLike | undefined;
}

interface DwgViewLike {
  zoomTo(box: unknown): void;
  dispose(): void;
}

interface DwgDocManagerLike {
  curDocument?: { database?: DwgDatabaseLike } | null;
  curView?: DwgViewLike | null;
  openDocument(
    fileName: string,
    content: ArrayBuffer,
    options: { mode: number },
    view?: DwgViewLike,
  ): Promise<boolean>;
  closeDocument(doc?: unknown): Promise<unknown>;
}

interface ViewerModule {
  AcApDocManager: {
    tryGetInstance(): DwgDocManagerLike | undefined;
    createInstance(options: {
      notificationCenter?: boolean;
      baseUrl?: string;
      webworkerFileUrls?: Record<string, string>;
    }): DwgDocManagerLike | undefined;
  };
  AcTrView2d: new (options: {
    container?: HTMLElement;
    calculateSizeCallback?: () => { width: number; height: number };
  }) => DwgViewLike;
  AcEdOpenMode: { Read: number };
}

interface MtextModule {
  FontManager: {
    instance: {
      baseUrl: string;
      setDefaultFonts(names: readonly string[]): void;
      getAvailableFonts(): Promise<unknown[]>;
    };
  };
}

interface DataModelModule {
  AcDbFileType: { DWG: unknown };
  AcDbDatabaseConverterManager: {
    instance: { register(fileType: unknown, converter: unknown): void };
  };
  AcGeBox2d: new (min: unknown, max: unknown) => unknown;
  AcGePoint2d: new (x: number, y: number) => unknown;
}

interface ConverterModule {
  AcDbLibreDwgConverter: new (options: { useWorker: boolean; parserWorkerUrl: string }) => unknown;
}

interface MlightcadLibs {
  dataModel: DataModelModule;
  converter: ConverterModule;
  viewer: ViewerModule;
  mtext: MtextModule;
  docManager: DwgDocManagerLike;
}

let libsPromise: Promise<MlightcadLibs> | null = null;

async function ensureMlightcadLibs(): Promise<MlightcadLibs> {
  libsPromise ??= (async () => {
    const [dataModel, converter, viewer, mtext] = (await Promise.all([
      import("@mlightcad/data-model"),
      import("@mlightcad/libredwg-converter"),
      import("@mlightcad/cad-simple-viewer"),
      import("@mlightcad/mtext-renderer"),
    ])) as unknown as [DataModelModule, ConverterModule, ViewerModule, MtextModule];
    // LibreDWG 是 GPL，viewer 默认不注册 DWG 转换器，宿主显式注册（内网自用）
    dataModel.AcDbDatabaseConverterManager.instance.register(
      dataModel.AcDbFileType.DWG,
      new converter.AcDbLibreDwgConverter({
        useWorker: true,
        parserWorkerUrl: `${DWG_ASSETS_BASE}libredwg-parser-worker.js`,
      }),
    );
    const docManager =
      viewer.AcApDocManager.tryGetInstance() ??
      viewer.AcApDocManager.createInstance({
        notificationCenter: false,
        baseUrl: DWG_FONT_REPO_ROOT,
        webworkerFileUrls: {
          mtextRender: `${DWG_ASSETS_BASE}mtext-renderer-worker.js`,
          dwgParser: `${DWG_ASSETS_BASE}libredwg-parser-worker.js`,
        },
      });
    if (!docManager) {
      throw new Error("mlightcad 文档管理器初始化失败");
    }
    mtext.FontManager.instance.baseUrl = DWG_FONTS_BASE_URL;
    mtext.FontManager.instance.setDefaultFonts(DEFAULT_FONT_CHAIN);
    return { dataModel, converter, viewer, mtext, docManager };
  })().catch((error: unknown) => {
    libsPromise = null;
    throw error;
  });
  return libsPromise;
}

/** 当前打开的图纸数：归零时关掉文档会话，避免反复开关累积解析结果占内存。 */
let openDocumentCount = 0;

export interface DwgMlightViewerProps {
  /** 展示用文件名（决定 DXF/DWG 解析分支），如 "结构图_A.dwg"。 */
  fileName: string;
  /** 取文件字节（空间走 /preview 流，对话面板走既有取数链路）。 */
  loadContent: () => Promise<ArrayBuffer>;
  /** 事件总线路径匹配键：空间相对路径或工作区路径。 */
  pathKey: string;
  className?: string;
  /** 初始化/打开失败（父组件据此降级到 SVG 兜底）。 */
  onFailed?: (error: unknown) => void;
  /** 图纸打开成功（含解析耗时），供外层展示。 */
  onReady?: (elapsedMs: number) => void;
  /** 非致命提示（如字体缺失只影响文字）。 */
  onNotice?: (message: string) => void;
  /**
   * 开启「选中 → 右键 → 加入对话」：挂在有对话输入框的宿主（对话旁预览面板）时开启；
   * 我的空间等无 composer 的宿主不传。
   */
  enableChatQuote?: boolean;
  /** 引用写入目标（会话输入框或根草稿槽），enableChatQuote 时必传。 */
  quoteTarget?: DwgChatQuoteTarget | null;
}

export function DwgMlightViewer({
  fileName,
  loadContent,
  pathKey,
  className,
  onFailed,
  onReady,
  onNotice,
  enableChatQuote = false,
  quoteTarget = null,
}: DwgMlightViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DwgViewLike | null>(null);
  // 右键引用菜单：记录容器内坐标；空选择集不弹
  const [quoteMenu, setQuoteMenu] = useState<{ x: number; y: number; handles: string[] } | null>(
    null,
  );
  // 用 ref 持有回调，避免父组件每次渲染传新函数导致重复打开文档
  const callbacksRef = useRef({ onFailed, onReady, onNotice, loadContent });
  callbacksRef.current = { onFailed, onReady, onNotice, loadContent };

  useEffect(() => {
    let cancelled = false;
    let opened = false;
    let disposeView: (() => void) | null = null;
    const offLocate = onDwgViewerLocate((event) => {
      if (!cancelled && dwgPathMatches(event.path, pathKey)) {
        void flyToHandles(event.handles);
      }
    });

    void (async () => {
      try {
        const libs = await ensureMlightcadLibs();
        if (cancelled || !containerRef.current) return;
        const container = containerRef.current;
        const content = await callbacksRef.current.loadContent();
        if (cancelled) return;

        const view = new libs.viewer.AcTrView2d({
          container,
          // 默认取 canvas 自身 clientWidth（初始 300×150），必须按容器算尺寸
          calculateSizeCallback: () => ({
            width: container.clientWidth,
            height: container.clientHeight,
          }),
        });
        disposeView = () => view.dispose();
        viewRef.current = view;

        const started = performance.now();
        const ok = await libs.docManager.openDocument(
          fileName,
          content,
          { mode: libs.viewer.AcEdOpenMode.Read },
          view,
        );
        if (cancelled) return;
        if (!ok) {
          throw new Error(`图纸解析失败：${fileName}`);
        }
        opened = true;
        openDocumentCount += 1;
        // 字体清单加载失败只影响文字，几何照常——单独提示而不是整体失败
        void libs.mtext.FontManager.instance
          .getAvailableFonts()
          .then((fonts) => {
            if (!cancelled && fonts.length === 0) {
              callbacksRef.current.onNotice?.(
                "图纸字体不可用（未运行 scripts/fetch-dwg-fonts.mjs），文字暂不显示，几何已渲染。",
              );
            }
          })
          .catch(() => {
            if (!cancelled) {
              callbacksRef.current.onNotice?.("图纸字体加载失败，文字暂不显示，几何已渲染。");
            }
          });
        callbacksRef.current.onReady?.(Math.round(performance.now() - started));
      } catch (error) {
        if (!cancelled) {
          callbacksRef.current.onFailed?.(error);
        }
      }
    })();

    return () => {
      cancelled = true;
      offLocate();
      viewRef.current = null;
      disposeView?.();
      if (opened) {
        openDocumentCount = Math.max(0, openDocumentCount - 1);
        if (openDocumentCount === 0) {
          void ensureMlightcadLibs()
            .then((libs) => libs.docManager.closeDocument())
            .catch(() => undefined);
        }
      }
    };
    // fileName / pathKey 变化即重开图纸；其余回调走 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName, pathKey]);

  /** 生成引用块并写进对话输入框（菜单项回调）。 */
  const fireQuote = (): void => {
    if (!quoteTarget || quoteMenu === null) return;
    const handles = quoteMenu.handles;
    void ensureMlightcadLibs()
      .then((libs) => {
        const db = libs.docManager.curDocument?.database;
        const summary = describeDwgSelection(db, handles);
        const block = formatDwgQuoteBlock(fileName, summary);
        appendDwgSelectionQuoteToComposerDraft({ target: quoteTarget, block });
      })
      .catch(() => undefined);
  };

  return (
    <div
      className={`relative ${className ?? ""}`}
      data-testid="dwg-mlight-viewer"
      onContextMenu={(event) => {
        if (!enableChatQuote) return;
        event.preventDefault();
        const selectionSet = (
          viewRef.current as unknown as { selectionSet?: { ids: readonly string[] } } | null
        )?.selectionSet;
        const handles = selectionSet ? [...selectionSet.ids] : [];
        if (handles.length === 0) {
          setQuoteMenu(null);
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        setQuoteMenu({
          x: Math.min(event.clientX - rect.left, Math.max(0, rect.width - 240)),
          y: Math.min(event.clientY - rect.top, Math.max(0, rect.height - 96)),
          handles,
        });
      }}
    >
      <div ref={containerRef} className="h-full w-full" />
      {quoteMenu ? (
        // 全容器透明遮罩：点 anywhere / 再按右键都收起菜单
        <div
          className="absolute inset-0 z-20"
          onMouseDown={() => setQuoteMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setQuoteMenu(null);
          }}
        >
          <div
            className="absolute min-w-56 rounded-lg border border-border bg-popover p-1 shadow-lg"
            style={{ left: quoteMenu.x, top: quoteMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-ui-sm text-foreground hover:bg-surface"
              onClick={() => {
                fireQuote();
                setQuoteMenu(null);
              }}
            >
              把选中的 {quoteMenu.handles.length} 个实体加入对话
            </button>
            <p className="px-2 pb-1 text-ui-xs text-foreground-subtle">
              实体 handle 一并引用，agent 可据此回答选中内容
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 按 handle 把实体框进视口（P3：agent 改图回显/引用定位）。 */
async function flyToHandles(handles: string[]): Promise<void> {
  if (handles.length === 0) return;
  const libs = await ensureMlightcadLibs().catch(() => null);
  if (!libs) return;
  const database = libs.docManager.curDocument?.database;
  const view = libs.docManager.curView;
  if (!database || !view) return;
  const boxes: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [];
  for (const handle of handles) {
    const entity = database.getAcDbEntityByHandle?.(handle);
    const extents = entity?.getGeomExtents?.();
    if (extents?.minPoint && extents?.maxPoint) {
      boxes.push({
        minX: extents.minPoint.x,
        minY: extents.minPoint.y,
        maxX: extents.maxPoint.x,
        maxY: extents.maxPoint.y,
      });
    }
  }
  if (boxes.length === 0) return;
  const box = boxes.reduce(
    (acc, item) => ({
      minX: Math.min(acc.minX, item.minX),
      minY: Math.min(acc.minY, item.minY),
      maxX: Math.max(acc.maxX, item.maxX),
      maxY: Math.max(acc.maxY, item.maxY),
    }),
    boxes[0]!,
  );
  view.zoomTo(
    new libs.dataModel.AcGeBox2d(
      new libs.dataModel.AcGePoint2d(box.minX, box.minY),
      new libs.dataModel.AcGePoint2d(box.maxX, box.maxY),
    ),
  );
}
