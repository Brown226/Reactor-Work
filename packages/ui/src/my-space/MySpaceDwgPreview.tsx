/**
 * DWG/DXF 在线预览（我的空间）。
 *
 * 主渲染走 mlightcad（LibreDWG WASM + three.js，前端本地解析文件字节，见
 * DwgMlightViewer）：产品定位是「看图」，块/填充/标注/图层的保真度它开箱即得。
 * mlightcad 初始化或解析失败时降级到 SVG 兜底（服务端 sidecar graph + 手绘）：
 * 兜底不含圆弧之外的高阶图元，但足以认图，且不依赖 /dwg-assets、/dwg/fonts
 * 这些静态资产是否部署。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { spaceClient } from "./spaceClient.js";
import { DwgMlightViewer } from "../dwg/DwgMlightViewer.js";
import { SvgDwgPreview } from "./SvgDwgPreview.js";

export function MySpaceDwgPreview({ relPath }: { relPath: string }) {
  const [engine, setEngine] = useState<"mlight" | "svg">("mlight");
  if (engine === "svg") {
    return <SvgDwgPreview relPath={relPath} />;
  }
  return <MlightDwgPreview relPath={relPath} onFallback={() => setEngine("svg")} />;
}

/** mlightcad 主渲染。失败回调触发整体降级到 SVG。 */
function MlightDwgPreview({ relPath, onFallback }: { relPath: string; onFallback: () => void }) {
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [parseMs, setParseMs] = useState<number | null>(null);
  // 详情栏只有 288px 宽，看图必须放大；放大视图是重新挂载的同一内核
  // （文档管理器单例，重开解析约 2~3 秒），而非复制画布。
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setReady(false);
  }, [expanded]);

  // 空间文件流与其它预览同源（cookie 会话），拿到字节直接喂给前端解析器
  const loadContent = useCallback(async () => {
    const response = await fetch(spaceClient.previewUrl(relPath));
    if (!response.ok) {
      throw new Error(`读取图纸失败（HTTP ${response.status}）`);
    }
    return response.arrayBuffer();
  }, [relPath]);

  const fileName = useMemo(() => relPath.split("/").pop() ?? relPath, [relPath]);

  const viewer = (
    <DwgMlightViewer
      className="h-full w-full"
      fileName={fileName}
      pathKey={relPath}
      loadContent={loadContent}
      onReady={(ms) => {
        setReady(true);
        setParseMs(ms);
      }}
      onNotice={(message) => setNotice(message)}
      onFailed={() => onFallback()}
    />
  );

  const download = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => window.open(spaceClient.downloadUrl(relPath), "_blank")}
    >
      <Download className="mr-2 size-4" /> 下载原件
    </Button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1 overflow-hidden bg-[#141414]">
        {viewer}
        {!ready ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#141414] text-ui-sm text-white/80">
            正在打开图纸…（首次打开需要几秒）
          </div>
        ) : null}
        {notice ? (
          <div className="absolute inset-x-2 top-2 z-10 rounded-md bg-amber-500/90 px-2 py-1 text-ui-xs text-black">
            {notice}
          </div>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="absolute right-1.5 bottom-1.5 h-7 gap-1 bg-white/90 px-2 text-ui-xs hover:bg-white"
          data-testid="dwg-expand"
          onClick={() => setExpanded(true)}
        >
          <Maximize2 className="size-3" /> 放大
        </Button>
      </div>
      <div className="space-y-1 border-t border-border px-2 py-1.5 text-ui-xs text-foreground-subtle">
        <div className="flex flex-wrap items-center gap-x-3">
          <span>mlightcad 渲染</span>
          {parseMs !== null ? <span>打开 {parseMs} ms</span> : null}
          {download}
        </div>
        <div>支持滚轮缩放与拖拽平移；文字缺失通常是字体资产未部署。</div>
      </div>

      {expanded ? (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black/70 p-6">
          <div className="mb-2 flex items-center justify-between gap-4 text-white">
            <span className="truncate text-ui-sm">{relPath} · 放大视图</span>
            <div className="flex items-center gap-2">
              <span className="text-ui-xs opacity-80">滚轮缩放 · 拖拽平移</span>
              <Button
                size="sm"
                variant="ghost"
                className="text-white"
                data-testid="dwg-expand-close"
                onClick={() => setExpanded(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-[#141414]">
            {viewer}
            {!ready ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#141414] text-ui-sm text-white/80">
                正在打开图纸…
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
