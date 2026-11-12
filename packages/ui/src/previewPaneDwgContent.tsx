/**
 * 预览面板（对话旁）的 DWG/DXF 内容：复用 mlightcad 内核 DwgMlightViewer。
 *
 * 桌面与 Web 都走 fileService.readBinaryPreview 拿字节（base64 → ArrayBuffer），
 * 前端本地解析渲染，服务端不参与。失败时不做 sidecar 降级——对话面板没有空间
 * 相对路径、用不了 /api/space 链路——展示文案引导用「我的空间」打开或下载原件。
 */
import { useMemo, useState } from "react";
import type { FileBinaryPreview } from "@zcode/shared";
import { decodeBase64ToArrayBuffer } from "@/lib/officeFilePreview.js";
import { DwgMlightViewer } from "@/dwg/DwgMlightViewer.js";
import type { DwgChatQuoteTarget } from "@/dwg/dwgChatQuote.js";

export type DwgFilePreviewKind = "dwg" | "dxf";

export function getDwgFilePreviewKind(path?: string): DwgFilePreviewKind | null {
  if (!path) return null;
  const lowered = path.toLowerCase();
  if (lowered.endsWith(".dwg")) return "dwg";
  if (lowered.endsWith(".dxf")) return "dxf";
  return null;
}

export function PreviewPaneDwgContent({
  error,
  loading,
  preview,
  sourcePath,
  chatQuote,
}: {
  error: string | null;
  loading: boolean;
  preview: FileBinaryPreview | null;
  sourcePath: string;
  /** 有对话输入框的宿主传入：开启「选中 → 右键 → 加入对话」并指定写入目标。 */
  chatQuote?: DwgChatQuoteTarget | null;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const fileName = useMemo(() => sourcePath.split(/[\\/]/).pop() ?? sourcePath, [sourcePath]);
  const loadContent = useMemo(
    () => async (): Promise<ArrayBuffer> => {
      if (!preview) throw new Error("图纸尚未读取完成");
      return decodeBase64ToArrayBuffer(preview.dataBase64);
    },
    [preview],
  );

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-ui-sm text-foreground-subtle">
        {error}
      </div>
    );
  }
  if (loading || !preview) {
    return (
      <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtle">
        正在读取图纸…（首次打开需要几秒）
      </div>
    );
  }
  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-ui-sm text-foreground-subtle">
        <p>{failed}</p>
        <p>可在「我的空间」打开该图纸，或下载后用本地 CAD 查看。</p>
      </div>
    );
  }
  return (
    <div className="h-full bg-[#141414]">
      <DwgMlightViewer
        className="h-full w-full"
        fileName={fileName}
        pathKey={sourcePath}
        loadContent={loadContent}
        enableChatQuote={!!chatQuote}
        quoteTarget={chatQuote ?? null}
        onNotice={() => undefined}
        onFailed={(failure: unknown) => {
          setFailed(failure instanceof Error ? failure.message : String(failure));
        }}
      />
    </div>
  );
}
