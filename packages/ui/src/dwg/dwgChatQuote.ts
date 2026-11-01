/**
 * DWG 选中实体 → 对话引用的桥接逻辑。
 *
 * 复用 GenUI/PDF「引用进会话」的既有通道（requestComposerTextInsert /
 * composerDraftStore 追加），插入的引用块里带实体 handle——handle 与
 * dwg-sidecar 输出（dwg_modify / dwg_graph 的 cadHandleId）同体系，
 * agent 拿到后可以直接反查实体语义回答「当前选中是什么」。
 */
import {
  appendBlockToComposerDraftText,
  normalizeComposerTextInsertSessionId,
} from "@/lib/composerTextInsert.js";

export interface DwgSelectionSummary {
  /** 选中实体总数（= handles.length）。 */
  total: number;
  /** 按类型聚合的展示名 → 数量（如 直线×3、文字×2）。 */
  typeCounts: Array<[string, number]>;
  /** 文字类实体（TEXT/MTEXT）的内容样本，最多 5 条。 */
  textSamples: string[];
  /** 实体 handle（十六进制，与 dwg-sidecar 输出同体系），最多 40 条防刷屏。 */
  handles: string[];
}

/** mlightcad 实体构造名 → 中文展示名（只映射常见类型，其余显示原名）。 */
const TYPE_LABELS: Record<string, string> = {
  AcDbLine: "直线",
  AcDbArc: "圆弧",
  AcDbCircle: "圆",
  AcDbEllipse: "椭圆",
  AcDbText: "文字",
  AcDbMText: "多行文字",
  AcDbPolyline: "多段线",
  AcDb2dPolyline: "二维多段线",
  AcDb3dPolyline: "三维多段线",
  AcDbLwPolyline: "轻量多段线",
  AcDbBlockReference: "块引用",
  AcDbHatch: "填充",
  AcDbDimension: "标注",
  AcDbSpline: "样条曲线",
};

/** libredwg 解析出的实体：只取文字值（类型/图层在 describeDwgSelection 里按构造名取）。 */
function resolveEntityText(entity: unknown): string | undefined {
  const candidate = entity as Record<string, unknown>;
  for (const key of ["text", "Value", "contents"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim().length > 0) {
      // MTEXT 可能带 {\f…} 控制码，粗滤一层保证引用可读
      return value
        .replace(/\{\\[^;]*;/g, "")
        .replace(/\\[Pp]/g, " ")
        .replace(/[{}]/g, "")
        .trim()
        .slice(0, 40);
    }
  }
  return undefined;
}

/**
 * 把 viewer 的选择集（handle 数组）解析成可读摘要。
 * db 为 mlightcad 的 AcDbDatabase（动态拿到，类型面从宽）。
 */
export function describeDwgSelection(db: unknown, handles: readonly string[]): DwgSelectionSummary {
  const typeCounter = new Map<string, number>();
  const textSamples: string[] = [];
  const resolvedHandles: string[] = [];
  for (const handle of handles.slice(0, 40)) {
    try {
      const entity = (db as { getObjectById?: (id: string) => unknown }).getObjectById?.(handle);
      if (!entity) continue;
      resolvedHandles.push(handle);
      const ctorName =
        (entity as { constructor?: { name?: string } }).constructor?.name ?? "Unknown";
      const label = TYPE_LABELS[ctorName] ?? ctorName.replace(/^AcDb/, "");
      typeCounter.set(label, (typeCounter.get(label) ?? 0) + 1);
      const text = resolveEntityText(entity);
      if (text && textSamples.length < 5) textSamples.push(text);
    } catch {
      // 单个实体解析失败不阻塞引用，跳过
    }
  }
  return {
    total: handles.length,
    typeCounts: [...typeCounter.entries()].sort((a, b) => b[1] - a[1]),
    textSamples,
    handles: resolvedHandles,
  };
}

/** 生成插进输入框的引用块（agent 可读：文件名 + 统计 + handle 清单）。 */
export function formatDwgQuoteBlock(fileName: string, summary: DwgSelectionSummary): string {
  const typeText =
    summary.typeCounts.length > 0
      ? summary.typeCounts.map(([label, count]) => `${label}×${count}`).join("、")
      : "未知类型";
  const lines = [`[引用图纸] ${fileName} · 选中 ${summary.total} 个实体（${typeText}）`];
  if (summary.textSamples.length > 0) {
    lines.push(`其中文字：${summary.textSamples.map((t) => `"${t}"`).join("、")}`);
  }
  lines.push(`实体 handle：${summary.handles.join(", ")}`);
  return lines.join("\n");
}

export interface DwgChatQuoteTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** v4 composer 草稿槽（根槽），无会话时的降级写入目标。 */
  scopeId: string;
  sessionId?: string | null;
}

/**
 * 把引用块送进对话输入框：有目标会话走 requestComposerTextInsert（append 到该会话草稿），
 * 无会话落根草稿槽——与 GenUI 动作回传同一套归属判定（composerTextInsert.ts 收口）。
 */
export function appendDwgSelectionQuoteToComposerDraft(params: {
  target: DwgChatQuoteTarget;
  block: string;
}): void {
  const targetSessionId = normalizeComposerTextInsertSessionId(params.target.sessionId);
  if (targetSessionId) {
    void import("@/store/zcodeSessionStore.js").then(({ useZCodeSessionStore }) => {
      useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          params.target.workspacePath,
          params.block,
          params.target.workspaceIdentity,
          undefined,
          "append",
          targetSessionId,
        );
    });
    return;
  }
  void import("@/v4/composer/composerDraftStore.js").then((mod) => {
    const existing = mod.readV4ComposerDraft(
      params.target.workspacePath,
      params.target.workspaceIdentity,
      params.target.scopeId,
    );
    const text = appendBlockToComposerDraftText(existing?.text, params.block);
    mod.persistV4ComposerDraft(
      params.target.workspacePath,
      params.target.workspaceIdentity,
      params.target.scopeId,
      {
        ...existing,
        text,
      },
    );
  });
}
