/**
 * 切片（KB-①）—— 纯函数，照 BuildingAI `segmentation.service.ts` 的 `splitRecursive` 口径。
 *
 * ## 为什么中文切分要单独讲究
 *
 * 默认分隔符若只写 `["\n\n", ". ", " "]`，中文文档会**在句中断开**（中文没有空格），
 * 产出的片段既读不通、检索质量也差。所以默认分隔符**含中文句号 `。`**（与公共库同口径）。
 *
 * 三条纪律：
 *  ① 先按高优先级分隔符切；仍超长才降级到更细的分隔符，**最后才硬切**（硬切是兜底，不是常规路径）；
 *  ② **重叠**必须在切片时就加进去（存储层不再处理），否则相邻片段之间会丢上下文；
 *  ③ **过短片段合并**：`MIN_SEGMENT_CHARS` 以下的碎片并回前一片段，避免"1 个字的片段"污染召回。
 */

import {
  MIN_SEGMENT_CHARS,
  type ChunkOptions,
  type Segment,
} from "./types.js";

/** 按分隔符切（保留分隔符本身 —— 句号/precision 丢失会让片段读起来突兀） */
function splitKeepSeparator(text: string, separator: string): string[] {
  if (separator === "") {
    // 空分隔符 = 按字符切（最后的兜底手段）
    return Array.from(text);
  }
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const idx = rest.indexOf(separator);
    if (idx === -1) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, idx + separator.length));
    rest = rest.slice(idx + separator.length);
  }
  return parts;
}

/**
 * 递归切分：优先用前面的分隔符，切完整体仍超长时对超长块降级到下一个分隔符。
 *
 * 返回**有序**的片段数组（顺序即原文顺序 —— 位置信息靠它，不能乱）。
 */
export function splitRecursive(text: string, opts: ChunkOptions): string[] {
  const source = String(text ?? "");
  if (source.trim().length === 0) return [];
  const maxLen = Math.max(1, Math.floor(opts.maxSegmentLength));
  const separators = opts.separators !== undefined && opts.separators.length > 0 ? opts.separators : ["\n\n", "。", ". ", " ", ""];

  const chunks: string[] = [];

  const recurse = (piece: string, sepIndex: number): void => {
    if (piece.length <= maxLen) {
      if (piece.length > 0) chunks.push(piece);
      return;
    }
    // 没有更细的分隔符了 → 硬切（兜底）
    if (sepIndex >= separators.length) {
      for (let i = 0; i < piece.length; i += maxLen) chunks.push(piece.slice(i, i + maxLen));
      return;
    }
    const sep = separators[sepIndex] ?? "";
    const parts = splitKeepSeparator(piece, sep);
    // 用当前分隔符切完仍是"一整块"（说明该分隔符不出现）→ 换下一个分隔符
    if (parts.length <= 1) {
      recurse(piece, sepIndex + 1);
      return;
    }
    // 先贪心合并到接近上限（避免把每个短句都切成一个片段），再对超长的继续降级
    let buffer = "";
    for (const part of parts) {
      if (part.length > maxLen) {
        if (buffer.length > 0) {
          chunks.push(buffer);
          buffer = "";
        }
        recurse(part, sepIndex + 1);
        continue;
      }
      if (buffer.length + part.length > maxLen) {
        if (buffer.length > 0) chunks.push(buffer);
        buffer = part;
      } else {
        buffer += part;
      }
    }
    if (buffer.length > 0) chunks.push(buffer);
  };

  recurse(source, 0);
  return chunks.filter((c) => c.length > 0);
}

/** 给相邻片段加重叠（后一片段的开头带上前一片段的尾巴） */
export function applyOverlap(chunks: readonly string[], overlap: number): string[] {
  const n = Math.max(0, Math.floor(overlap));
  if (n === 0 || chunks.length <= 1) return [...chunks];
  const out: string[] = [chunks[0]!];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const head = prev.slice(Math.max(0, prev.length - n));
    out.push(head + chunks[i]!);
  }
  return out;
}

/** 过短片段并回前一片段（首片过短则并入后一片） */
function mergeShortChunks(chunks: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of chunks) {
    if (out.length > 0 && c.trim().length < MIN_SEGMENT_CHARS) {
      out[out.length - 1] = out[out.length - 1]! + c;
    } else {
      out.push(c);
    }
  }
  // 只剩一片且它过短时无需处理（单片段文档就是这样）
  return out;
}

/**
 * 把一篇文档切成带位置信息的片段（存储层直接可用）。
 *
 * `docId`/`docName` 由调用方给；`position` 由本函数按最终顺序编号（0-based）。
 */
export function chunkDocument(
  docId: string,
  docName: string,
  text: string,
  opts: ChunkOptions,
): Segment[] {
  const raw = splitRecursive(text, opts);
  const withOverlap = applyOverlap(raw, opts.segmentOverlap ?? 0);
  const merged = mergeShortChunks(withOverlap);
  return merged.map((chunk, index) => ({
    id: `${docId}#${index}`,
    docId,
    docName,
    position: index,
    text: chunk,
    length: chunk.length,
  }));
}
