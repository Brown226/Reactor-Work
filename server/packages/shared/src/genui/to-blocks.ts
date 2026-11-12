/**
 * GenUI 树 → 文档 IR（第三刀）—— **「同一棵归一化树 → 多渲染器」的那座桥**。
 *
 * 设计来源：LeAgent 的 `services/gen_ui/{docx,pptx,print}_renderer.py`
 * （Apache-2.0）。但**落点不同**：LeAgent 为每种产物各写一个渲染器；
 * Reactor 已经有 W3 的**办公 IR**（`shared/src/office/ir.ts`）+ docx 渲染器，
 * 所以这里只做**一次映射** `GenUI 树 → Block[]`，导出复用既有渲染器。
 *
 * ## 为什么这比「再写一个 docx 渲染器」好
 *
 * 同一个面板内容要能出现在**聊天面板**（React）、**docx**（Pandoc 式块渲染）、
 * 将来的 pptx/pdf。若每种目标各写一遍遍历，三份实现必然漂移（LeAgent 就是这样三份）。
 * 映射到 IR 后：**语义只定义一次**，渲染器各管各的绘制。
 *
 * ## 映射原则（**有损的地方必须说明**）
 *
 * GenUI 是**交互**载体（Tabs/ScrollArea/按钮），文档是**线性**载体。因此：
 *  - 交互容器（`Tabs`/`ScrollArea`）→ **展平**为线性内容（Tab 用小节标题保留标签名）；
 *  - 数据族（`Stat`/`MetricCard`/`KpiBoard`）→ `MetricsBlock`（文档里就是一行行指标）；
 *  - 表格 → `TableBlock`（带原始数值，让**表格引擎**在文档侧同样润色）；
 *  - 无法表达的（`HtmlFrame` 的任意 HTML）→ 降级为**代码块 + 说明**，**不静默丢弃**；
 *  - `SlideDeck` → 每个 `Slide` 一个小节（文档里幻灯片就是分节）。
 */

import type { Block } from "../office/ir.js";
import { GENUI_LIMITS, type GenUiNode } from "./types.js";

/** 有损映射的说明（导出时随文件/返回值告知使用者，不静默） */
export interface GenUiToBlocksResult {
  readonly blocks: readonly Block[];
  /** 无法在文档里表达的节点（kind + 原因），逐条列出 */
  readonly losses: readonly string[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const propsOf = (n: GenUiNode): Readonly<Record<string, unknown>> => n.props ?? {};

/** 文本 → 段落块（空文本不产块） */
const para = (text: string): Block[] => (text.trim() === "" ? [] : [{ type: "paragraph", text }]);

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : typeof x === "number" ? String(x) : x === null || x === undefined ? "" : String(x)));
}

/**
 * 递归映射：一个 GenUI 节点 → 若干 IR 块（**顺序即文档顺序**）。
 *
 * 返回数组而不是单块：一个 GenUI 节点常对应多个文档块（如 `Card` = 标题 + 内容）。
 */
function nodeToBlocks(node: GenUiNode, out: Block[], losses: string[], depth: number): void {
  const props = propsOf(node);
  const kids = node.children ?? [];

  switch (node.kind) {
    case "Heading": {
      const level = Math.min(6, Math.max(1, num(props["level"]) ?? 2));
      out.push({ type: "heading", level: level as 1 | 2 | 3 | 4 | 5 | 6, text: str(props["value"]) ?? "" });
      return;
    }
    case "Text":
      out.push(...para(str(props["value"]) ?? ""));
      return;
    case "Markdown":
      // Markdown 块原样交给下游（docx 侧走同一套 markdown 解析）
      out.push({ type: "paragraph", text: str(props["content"]) ?? "" });
      return;
    case "CodeBlock":
      // IR 的 CodeBlock 是 `{lang, lines}`（按行存，便于渲染器逐行编号）
      {
        const raw = str(props["code"]) ?? "";
        out.push({ type: "code", lang: str(props["language"]) ?? "text", lines: raw === "" ? [] : raw.split("\n") });
      }
      return;
    case "Divider":
      out.push({ type: "divider" });
      return;
    case "Spacer":
      // 留白在文档里是空段落（`Spacer` 无内容；给一个轻量空行）
      out.push({ type: "paragraph", text: "" });
      return;
    case "Callout":
    case "Alert": {
      const variant = str(props["variant"]) ?? "info";
      const title = str(props["title"]);
      out.push({
        type: "callout",
        variant:
          variant === "success" || variant === "warning" || variant === "danger" || variant === "note" || variant === "tip"
            ? variant
            : "info",
        ...(title !== null ? { title } : {}),
        lines: [str(props["message"]) ?? ""],
      });
      return;
    }
    case "Stat":
    case "MetricCard":
      out.push({
        type: "metrics",
        items: [
          {
            label: str(props["label"]) ?? "",
            value: str(props["value"]) ?? "",
            ...(str(props["delta"]) !== null ? { delta: str(props["delta"])! } : {}),
          },
        ],
      });
      return;
    case "KpiBoard": {
      const items = Array.isArray(props["items"]) ? (props["items"] as unknown[]) : [];
      out.push({
        type: "metrics",
        items: items
          .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
          .map((it) => ({
            label: str(it["label"]) ?? str(it["name"]) ?? "",
            value: str(it["value"]) ?? "",
            ...(str(it["delta"]) !== null ? { delta: str(it["delta"])! } : {}),
          })),
      });
      return;
    }
    case "KeyValueList": {
      const items = Array.isArray(props["items"]) ? (props["items"] as unknown[]) : [];
      const rows = items
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((it) => [str(it["key"]) ?? str(it["k"]) ?? str(it["label"]) ?? "", str(it["value"]) ?? str(it["v"]) ?? ""]);
      if (rows.length === 0) return;
      out.push({ type: "table", header: ["项", "值"], rows });
      return;
    }
    case "Table": {
      // 表格在文档侧同样交给**共享表格引擎**（渲染器只绘制）——所以这里传原始数值，不做格式化
      const header = toStringArray(props["header"]);
      const rows = Array.isArray(props["rows"]) ? (props["rows"] as unknown[]).map(toStringArray) : [];
      if (header.length === 0 && rows.length === 0) {
        losses.push("Table：既无 header 也无 rows，未产出表格");
        return;
      }
      out.push({
        type: "table",
        header,
        rows,
        ...(str(props["caption"]) !== null ? { caption: str(props["caption"])! } : {}),
      });
      return;
    }
    case "Card": {
      const title = str(props["title"]);
      const subtitle = str(props["subtitle"]);
      if (title !== null || subtitle !== null) {
        out.push({ type: "heading", level: 3, text: [title, subtitle].filter((x): x is string => x !== null).join(" —— ") });
      }
      for (const k of kids) nodeToBlocks(k, out, losses, depth + 1);
      return;
    }
    case "SectionHeader": {
      const title = str(props["value"]) ?? "";
      const hint = str(props["hint"]);
      out.push({ type: "heading", level: 3, text: hint !== null ? `${title}（${hint}）` : title });
      return;
    }
    case "ScrollArea":
      // 滚动是**交互**属性，文档里没有对应物 → 展平（不丢内容）
      for (const k of kids) nodeToBlocks(k, out, losses, depth + 1);
      return;
    case "Tabs": {
      // 展平为「每个 Tab 一个小节」——**保留标签名**，否则读者不知道这块原本叫什么
      for (const tab of kids) {
        const label = str(propsOf(tab)["label"]);
        if (label !== null) out.push({ type: "heading", level: 4, text: label });
        for (const inner of tab.children ?? []) nodeToBlocks(inner, out, losses, depth + 1);
      }
      losses.push("Tabs：交互式标签页在文档里被展平为小节（内容完整保留，交互性丢失）");
      return;
    }
    case "TabItem":
      // 独立 TabItem（不在 Tabs 内）
      for (const k of kids) nodeToBlocks(k, out, losses, depth + 1);
      return;
    case "Stack":
    case "Row":
    case "Grid":
      // 布局在文档里只影响**视觉排布**，不影响语义 → 顺序展平（这是文档的固有局限）
      if (node.kind === "Grid" || node.kind === "Row") {
        losses.push(`${node.kind}：多列布局在文档里被展平为顺序内容（内容完整，排布丢失）`);
      }
      for (const k of kids) nodeToBlocks(k, out, losses, depth + 1);
      return;
    case "Progress": {
      const max = num(props["max"]) ?? 100;
      const value = num(props["value"]) ?? 0;
      out.push({ type: "paragraph", text: `${str(props["label"]) ?? "进度"}：${value}/${max}` });
      return;
    }
    case "Badge":
    case "Tag":
      out.push({ type: "paragraph", text: node.kind === "Badge" ? (str(props["value"]) ?? "") : (str(props["label"]) ?? "") });
      return;
    case "SlideDeck": {
      // 幻灯片 → 文档：每页一个小节（`Slide` 的 title 作小节标题）
      const slides = kids.filter((k) => k.kind === "Slide");
      slides.forEach((slide, i) => {
        const title = str(propsOf(slide)["title"]) ?? `第 ${i + 1} 页`;
        out.push({ type: "heading", level: 2, text: title });
        for (const inner of slide.children ?? []) nodeToBlocks(inner, out, losses, depth + 1);
      });
      if (slides.length === 0) losses.push("SlideDeck：没有 Slide 子节点，未产出小节");
      else losses.push("SlideDeck：幻灯片在文档里导出为分节（页面切分与版式丢失；要保留版式请导出 pptx）");
      return;
    }
    case "Slide":
      for (const k of kids) nodeToBlocks(k, out, losses, depth + 1);
      return;
    case "ImageGallery": {
      const items = Array.isArray(props["items"]) ? (props["items"] as unknown[]) : [];
      for (const raw of items) {
        if (typeof raw !== "object" || raw === null) continue;
        const it = raw as Record<string, unknown>;
        const src = str(it["src"]) ?? str(it["url"]);
        if (src === null) continue;
        out.push({
          type: "image",
          src,
          ...(str(it["alt"]) !== null ? { alt: str(it["alt"])! } : {}),
          ...(str(it["caption"]) !== null ? { caption: str(it["caption"])! } : {}),
        });
      }
      if (items.length > 0 && out.length === 0) losses.push("ImageGallery：条目缺少 src/url，未产出图片");
      return;
    }
    case "FeatureGrid": {
      const items = Array.isArray(props["items"]) ? (props["items"] as unknown[]) : [];
      for (const raw of items) {
        if (typeof raw !== "object" || raw === null) continue;
        const it = raw as Record<string, unknown>;
        const title = str(it["title"]) ?? str(it["label"]) ?? "";
        const desc = str(it["description"]) ?? str(it["text"]) ?? "";
        if (title === "" && desc === "") continue;
        out.push({
          type: "list",
          ordered: false,
          level: 0,
          items: [{ text: `${title}${title !== "" && desc !== "" ? "：" : ""}${desc}` }],
        });
      }
      losses.push("FeatureGrid：卡片网格在文档里导出为列表（内容完整，网格排布丢失）");
      return;
    }
    case "HtmlFrame": {
      /**
       * **不静默丢弃**：任意 HTML 在文档里无法表达，但把它当代码块放进去 ——
       * 读者至少能看到「这里原本有一块自绘内容」，而不是凭空少一段。
       */
      losses.push("HtmlFrame：任意 HTML 无法在文档里渲染，已降级为代码块（保留原文）");
      {
        const raw = str(props["html"]) ?? "";
        const capped = raw.length > GENUI_LIMITS.maxTextChars ? `${raw.slice(0, GENUI_LIMITS.maxTextChars)}…[truncated]` : raw;
        out.push({ type: "code", lang: "html", lines: capped === "" ? [] : capped.split("\n") });
      }
      return;
    }
    default:
      losses.push(`${node.kind}：尚无文档映射（已跳过）`);
      return;
  }
}

/**
 * 把（已归一的）GenUI 树映射为办公 IR 块序列。
 *
 * 入参是**归一之后**的树（`normalizeUiTree().tree.root`）：归一负责把模型写歪的东西修好，
 * 这里只负责「换成文档语义」。两层分开的好处：归一可以独立测，
 * 映射规则也可以独立测，出问题时能立刻判断是哪一层。
 */
export function genuiToBlocks(root: GenUiNode): GenUiToBlocksResult {
  const out: Block[] = [];
  const losses: string[] = [];
  nodeToBlocks(root, out, losses, 1);
  // 去重（同一类损失可能重复出现多次，报告里只留一条）
  return { blocks: out, losses: [...new Set(losses)] };
}
