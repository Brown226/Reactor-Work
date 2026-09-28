/**
 * Markdown → docx 生成（domain 纯函数 + 图片取数）。
 *
 * 用 marked.lexer 解析块级结构，逐块映射为 docx 文档节点（spec 6.3）：
 * 标题层级 / 段落 / 列表 / 表格 / 代码块 / 引用 / 分割线；图片按需读取本地
 * 文件 buffer 后内联。公式按纯文本保留（Word 对复杂 CSS 支持有限）。
 *
 * 排版值一律走 `docxStyle.ts`（令牌来自 `@zcode/shared`）：这里只挑样式名，
 * **不写内联字体字号** —— `document.xml` 里一旦出现 `w:rFonts`/`w:sz`，排版就退回读者本机
 * Word 默认值，同一份导出在不同机器上会长得不一样（`test/markdownToDocx.test.ts` 有这条断言）。
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ISectionOptions,
} from "docx";
import { marked, type Token, type Tokens } from "marked";

import {
  DOCX_STYLE_IDS,
  MARKDOWN_HEADER_SHADE,
  MARKDOWN_IMAGE_MAX_WIDTH_PX,
  MARKDOWN_RULE_COLOR,
  markdownDocumentStyles,
  markdownSectionProperties,
  markdownTableProperties,
} from "@/lib/docxStyle.js";

/** docx 文档块：段落与表格的联合（section children 接受二者混排） */
type DocxBlock = Paragraph | Table;

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
}

async function loadImageData(
  src: string,
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const data = new Uint8Array(await blob.arrayBuffer());
    const scale = Math.min(1, MARKDOWN_IMAGE_MAX_WIDTH_PX / Math.max(1, bitmap.width));
    return {
      data,
      width: Math.round(bitmap.width * scale),
      height: Math.round(bitmap.height * scale),
    };
  } catch {
    return null;
  }
}

function inlineTokensToRuns(tokens: Token[] | undefined, style: RunStyle = {}): TextRun[] {
  const runs: TextRun[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text": {
        const textToken = token as Tokens.Text;
        // marked 的 text 节点可能嵌套子 token（如 strong 内嵌链接）
        if ("tokens" in textToken && Array.isArray(textToken.tokens)) {
          runs.push(...inlineTokensToRuns(textToken.tokens, style));
        } else {
          runs.push(new TextRun({ text: textToken.text, ...style }));
        }
        break;
      }
      case "strong":
        runs.push(...inlineTokensToRuns((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        runs.push(...inlineTokensToRuns((token as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case "del":
        runs.push(...inlineTokensToRuns((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "codespan":
        // 等宽字体在字符样式里（`ReactorCode`），不放 run 上 —— 见文件头注释。
        runs.push(
          new TextRun({
            text: (token as Tokens.Codespan).text,
            style: DOCX_STYLE_IDS.code,
            ...style,
          }),
        );
        break;
      case "br":
        runs.push(new TextRun({ text: "", break: 1, ...style }));
        break;
      case "link":
        runs.push(
          ...inlineTokensToRuns((token as Tokens.Link).tokens, {
            ...style,
          }),
        );
        break;
      case "image": {
        const image = token as Tokens.Image;
        runs.push(new TextRun({ text: image.text || "[图片]", ...style }));
        break;
      }
      default:
        break;
    }
  }
  return runs;
}

async function listItemToParagraphs(
  item: Tokens.ListItem,
  depth: number,
  ordered: boolean,
  ordinal: number,
): Promise<DocxBlock[]> {
  // 有序列表按「序号. 」文本前缀输出，无序/任务列表用 bullet 或勾选框前缀
  const prefix = item.task ? (item.checked ? "☑ " : "☐ ") : ordered ? `${ordinal}. ` : "";
  const paragraphs: DocxBlock[] = [];
  const ownRuns: TextRun[] = [];
  let nested: DocxBlock[] = [];
  const flush = () => {
    if (ownRuns.length > 0 || nested.length > 0) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun(prefix), ...ownRuns],
          bullet: item.task || ordered ? undefined : { level: Math.min(depth, 4) },
          spacing: { after: 60 },
        }),
        ...nested,
      );
      ownRuns.length = 0;
      nested = [];
    }
  };
  for (const token of item.tokens) {
    if (token.type === "text") {
      ownRuns.push(...inlineTokensToRuns((token as Tokens.Text).tokens));
    } else if (token.type === "paragraph") {
      flush();
      ownRuns.push(...inlineTokensToRuns((token as Tokens.Paragraph).tokens));
    } else if (token.type === "list") {
      flush();
      nested.push(...(await listToParagraphs(token as Tokens.List, depth + 1)));
    } else if (token.type === "code") {
      flush();
      paragraphs.push(...codeToParagraphs((token as Tokens.Code).text));
    } else if (token.type === "blockquote") {
      flush();
      paragraphs.push(...(await blockquoteToParagraphs(token as Tokens.Blockquote)));
    } else {
      flush();
    }
  }
  flush();
  return paragraphs;
}

async function listToParagraphs(list: Tokens.List, depth: number): Promise<DocxBlock[]> {
  const out: DocxBlock[] = [];
  // marked 在无序列表上把 start 置为 ""，有序列表才是数字
  let ordinal = typeof list.start === "number" ? list.start : 1;
  for (const item of list.items) {
    out.push(...(await listItemToParagraphs(item, depth, Boolean(list.ordered), ordinal)));
    ordinal += 1;
  }
  return out;
}

function codeToParagraphs(code: string): Paragraph[] {
  // 每行一个段落便于跨页断行；等宽字体、底纹与零段距都在样式里。
  return code
    .split("\n")
    .map(
      (line) => new Paragraph({ style: DOCX_STYLE_IDS.codeBlock, children: [new TextRun(line)] }),
    );
}

async function imageParagraph(token: Tokens.Image): Promise<Paragraph> {
  const loaded = await loadImageData(token.href);
  if (!loaded) {
    return new Paragraph({ children: [new TextRun(`[图片缺失: ${token.href}]`)] });
  }
  return new Paragraph({
    children: [
      new ImageRun({
        type: "png",
        data: loaded.data,
        transformation: { width: loaded.width, height: loaded.height },
      }),
    ],
    spacing: { after: 120 },
  });
}

async function blockquoteParagraphs(token: Token, depth: number): Promise<DocxBlock[]> {
  // 引用块逐 token 加左侧缩进；嵌套引用递归加深
  const out: DocxBlock[] = [];
  if (token.type === "paragraph") {
    out.push(
      new Paragraph({
        style: DOCX_STYLE_IDS.quote,
        children: inlineTokensToRuns((token as Tokens.Paragraph).tokens),
        // 嵌套引用靠缩进递进；左侧竖线与文字颜色在样式里。
        indent: { left: 240 * (depth + 1) },
      }),
    );
  } else if (token.type === "blockquote") {
    for (const inner of (token as Tokens.Blockquote).tokens) {
      out.push(...(await blockquoteParagraphs(inner, depth + 1)));
    }
  } else if (token.type === "code") {
    out.push(...codeToParagraphs((token as Tokens.Code).text));
  } else {
    out.push(...(await tokensToParagraphs([token])));
  }
  return out;
}

async function blockquoteToParagraphs(token: Tokens.Blockquote): Promise<DocxBlock[]> {
  const out: DocxBlock[] = [];
  for (const inner of token.tokens) {
    out.push(...(await blockquoteParagraphs(inner, 0)));
  }
  return out;
}

async function tokensToParagraphs(tokens: Token[]): Promise<DocxBlock[]> {
  const out: DocxBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        out.push(
          new Paragraph({
            heading:
              (
                [
                  HeadingLevel.HEADING_1,
                  HeadingLevel.HEADING_2,
                  HeadingLevel.HEADING_3,
                  HeadingLevel.HEADING_4,
                  HeadingLevel.HEADING_5,
                  HeadingLevel.HEADING_6,
                ] as const
              )[heading.depth - 1] ?? HeadingLevel.HEADING_6,
            children: inlineTokensToRuns(heading.tokens),
          }),
        );
        break;
      }
      case "paragraph":
        out.push(
          new Paragraph({
            children: inlineTokensToRuns((token as Tokens.Paragraph).tokens),
          }),
        );
        break;
      case "list":
        out.push(...(await listToParagraphs(token as Tokens.List, 0)));
        break;
      case "code":
        out.push(...codeToParagraphs((token as Tokens.Code).text));
        break;
      case "blockquote":
        out.push(...(await blockquoteToParagraphs(token as Tokens.Blockquote)));
        break;
      case "hr":
        out.push(
          new Paragraph({
            border: { bottom: { color: MARKDOWN_RULE_COLOR, style: BorderStyle.SINGLE, size: 6 } },
            spacing: { after: 120 },
          }),
        );
        break;
      case "table":
        out.push(...(await tableToTables(token as Tokens.Table)));
        break;
      case "image":
        out.push(await imageParagraph(token as Tokens.Image));
        break;
      default:
        break;
    }
  }
  return out;
}

async function tableToTables(table: Tokens.Table): Promise<Table[]> {
  const properties = markdownTableProperties(table.header.length);
  const columnWidth = {
    size: Math.floor(100 / Math.max(1, table.header.length)),
    type: WidthType.PERCENTAGE,
  };
  const toCell = (cellTokens: Token[], isHeader: boolean) =>
    new TableCell({
      children: [
        new Paragraph({
          style: isHeader ? DOCX_STYLE_IDS.tableHeader : DOCX_STYLE_IDS.tableBody,
          children: inlineTokensToRuns(cellTokens),
          ...(isHeader ? { alignment: AlignmentType.CENTER } : {}),
        }),
      ],
      // 底纹给单元格：段落底纹只铺文字行高，表头会缺一角。
      ...(isHeader ? { shading: MARKDOWN_HEADER_SHADE } : {}),
      width: columnWidth,
    });
  const headerRow = new TableRow({
    children: table.header.map((cell) => toCell(cell.tokens, true)),
    tableHeader: true,
    cantSplit: true,
  });
  const bodyRows = table.rows.map(
    (row) =>
      new TableRow({
        children: row.map((cell) => toCell(cell.tokens, false)),
        cantSplit: true,
      }),
  );
  return [
    new Table({
      rows: [headerRow, ...bodyRows],
      layout: properties.layout,
      columnWidths: properties.columnWidths,
      borders: properties.borders,
      margins: properties.margins,
      width: properties.width,
    }),
    new Paragraph({ spacing: { after: 120 } }),
  ];
}

/** 文档标题取第一个一级标题；没有就退回中性标题，不把整段正文塞进文档属性。 */
function documentTitle(tokens: Token[]): string {
  const heading = tokens.find(
    (token): token is Tokens.Heading =>
      token.type === "heading" && (token as Tokens.Heading).depth === 1,
  );
  const raw = heading?.text?.trim();
  return raw && raw.length > 0 ? raw.slice(0, 200) : "Markdown 导出";
}

/** markdown 源码 → docx ArrayBuffer。图片缺失时降级为文字占位（spec 3.2.1）。 */
export async function markdownToDocx(markdown: string): Promise<ArrayBuffer> {
  const tokens = marked.lexer(markdown);
  const children = await tokensToParagraphs(tokens);
  const section: ISectionOptions = {
    properties: markdownSectionProperties(),
    children,
  };
  const doc = new Document({
    title: documentTitle(tokens),
    creator: "Reactor",
    lastModifiedBy: "Reactor",
    description: "由 Reactor 从 Markdown 导出",
    styles: markdownDocumentStyles(),
    sections: [section],
  });
  return Packer.toBlob(doc).then((blob) => blob.arrayBuffer());
}
