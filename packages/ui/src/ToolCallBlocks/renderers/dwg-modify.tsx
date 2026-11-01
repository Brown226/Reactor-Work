/**
 * dwg_modify 工具卡：DWG 改图结果的回显与联动入口。
 *
 * 双向联动（P3，见 docs/未完成-DWG看图-mlightcad接入方案.md）：
 * - 推：结果首次出现时向 dwgViewerBus 发 agent-modify 定位事件，
 *   正在展示该图纸的 mlightcad 查看器（对话面板/我的空间）会自动缩放到
 *   被修改的实体——改完图不用自己找变化在哪；
 * - 拉：卡片上常驻「在图中定位」按钮，点按重新发事件（chat-quote）。
 * 事件按 filePath+handles 去重，流式重渲染不会重复触发。
 */
import { useEffect, useMemo, useRef } from "react";
import { MapPinIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { emitDwgViewerLocate } from "@/dwg/dwgViewerBus.js";
import { ToolLayout } from "../ToolLayout.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const DWG_MODIFY_TOOL_ICON = <MapPinIcon className="size-4 shrink-0 text-foreground-subtle" />;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDwgModifyToolCall(toolCall: { toolName?: string }): boolean {
  // MCP 工具名可能带 server 前缀（如 mcp__dwg-tools__dwg_modify），按后缀认领
  const name = (toolCall.toolName ?? "").toLowerCase();
  return name === "dwg_modify" || name.endsWith("__dwg_modify") || name.endsWith("/dwg_modify");
}

interface DwgModifyPayload {
  filePath: string | null;
  handles: string[];
  modifiedCount: number;
  backupPath: string | null;
  failed: boolean;
  errorText: string | null;
}

/** 从 MCP 输出（content[].text 包着 JSON）或已解析对象里取改图回显字段。 */
function extractDwgModifyPayload(output: unknown): DwgModifyPayload {
  let parsed: unknown = output;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {
        filePath: null,
        handles: [],
        modifiedCount: 0,
        backupPath: null,
        failed: true,
        errorText: typeof parsed === "string" ? parsed : null,
      };
    }
  }
  // MCP textResult：{ content: [{ type: "text", text: "<json>" }] }
  if (isPlainRecord(parsed) && Array.isArray(parsed.content)) {
    const firstText = parsed.content.find(
      (item) => isPlainRecord(item) && item.type === "text" && typeof item.text === "string",
    ) as { text: string } | undefined;
    if (firstText) {
      try {
        parsed = JSON.parse(firstText.text);
      } catch {
        return {
          filePath: null,
          handles: [],
          modifiedCount: 0,
          backupPath: null,
          failed: true,
          errorText: firstText.text,
        };
      }
    }
  }
  if (!isPlainRecord(parsed)) {
    return {
      filePath: null,
      handles: [],
      modifiedCount: 0,
      backupPath: null,
      failed: true,
      errorText: null,
    };
  }
  const failed = parsed.status === "failed" || parsed.isError === true;
  const modify = isPlainRecord(parsed.modify) ? parsed.modify : null;
  const outputPath = parsed.outputPath ?? modify?.outputPath;
  const backupPath = modify?.backupPath;
  const handles = Array.isArray(modify?.modifiedHandles)
    ? modify.modifiedHandles.filter((item): item is string => typeof item === "string")
    : [];
  return {
    filePath: typeof outputPath === "string" ? outputPath : null,
    handles,
    modifiedCount: handles.length,
    backupPath: typeof backupPath === "string" ? backupPath : null,
    failed,
    errorText: typeof parsed.error === "string" ? parsed.error : null,
  };
}

export function DwgModifyToolCallBlock(context: ToolCallBlockRenderContext) {
  const { toolCall } = context.toolCallNode;
  const payload = useMemo(() => extractDwgModifyPayload(toolCall.output), [toolCall.output]);
  const inputFilePath =
    isPlainRecord(toolCall.input) && typeof toolCall.input.file_path === "string"
      ? toolCall.input.file_path
      : null;
  const filePath = payload.filePath ?? inputFilePath;
  const handles = payload.handles;
  const emittedKeyRef = useRef<string | null>(null);

  // 推：改图结果第一次出现（输出就绪）就通知查看器定位；重渲染/快照回填按 key 去重
  useEffect(() => {
    if (!filePath || handles.length === 0) return;
    const key = `${filePath}#${handles.join(",")}`;
    if (emittedKeyRef.current === key) return;
    emittedKeyRef.current = key;
    emitDwgViewerLocate({ path: filePath, handles, origin: "agent-modify" });
  }, [filePath, handles]);

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={DWG_MODIFY_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={context.kindLabelOverride ?? "DWG 改图"}
        sourceLabel={context.sourceLabel}
        primaryText={
          <span className="truncate font-mono text-foreground-subtlest">
            {filePath ?? toolCall.title ?? "dwg_modify"}
          </span>
        }
        secondaryText={
          payload.modifiedCount > 0 ? (
            <span className="truncate">
              已修改 {payload.modifiedCount} 处{payload.backupPath ? "（已留 .bak 备份）" : ""}
            </span>
          ) : null
        }
        statusLabel={context.statusLabel}
        statusTooltip={
          toolCall.status === "failed" ? (payload.errorText ?? context.errorText) : undefined
        }
        showFailureStatus={toolCall.status === "failed" || payload.failed}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={() => (
          <div className="mb-2 space-y-2 rounded-xl border border-border bg-panel px-4 py-3">
            {filePath ? (
              <div className="flex items-center gap-2 font-mono text-ui-base text-foreground">
                <span className="shrink-0 text-foreground-subtle">图纸</span>
                <span className="min-w-0 truncate">{filePath}</span>
              </div>
            ) : null}
            {payload.failed ? (
              <p className="text-ui-sm text-red-600">
                {payload.errorText ?? "改图失败，原图未被修改"}
              </p>
            ) : payload.modifiedCount > 0 ? (
              <>
                <p className="text-ui-sm text-foreground-subtle">
                  已修改 {payload.modifiedCount} 处实体
                  {payload.backupPath ? `，备份：${payload.backupPath}` : ""}。
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    emitDwgViewerLocate({ path: filePath ?? "", handles, origin: "chat-quote" })
                  }
                >
                  <MapPinIcon className="mr-2 size-4" /> 在图中定位
                </Button>
              </>
            ) : (
              <pre className="max-h-25 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-base text-foreground-subtle">
                {payload.errorText ?? "读取完成（未修改实体）"}
              </pre>
            )}
          </div>
        )}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
