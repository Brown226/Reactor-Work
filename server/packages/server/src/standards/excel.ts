/**
 * 标准清单 Excel 解析 / 模板 / 导出（STD-IO）。
 *
 * 为什么单独一个模块而不是塞进 routes.ts：routes.ts 已经 250 行量级，
 * 而 Excel 侧要管表头契约、单元格类型归一、日期序列号转换、坏行收集，
 * 再塞进去会把「HTTP 形状」和「文件格式」两件事搅在一起。契约见
 * docs/standards-excel-io-spec.md，改列定义前先读那份。
 *
 * 为什么用 exceljs 而不是 xlsx(SheetJS)：exceljs 的 TypeScript 类型是一等公民，
 * 且 writeBuffer 产出的文件 Excel/WPS 都认；社区版 SheetJS 只发 npm 不在 pnpm 默认源，
 * 内网装不上。
 */
import Excel from "exceljs";

import { standardKey, type StandardStatus } from "./repo.js";

/** 模板 8 列，顺序即契约（spec §2）。改动 = 前后数据不一致，必须同步 spec。 */
export const STANDARD_HEADERS = [
  "标准编号",
  "标准名称",
  "状态",
  "分类",
  "发布日期",
  "实施日期",
  "废止日期",
  "替换信息",
] as const;

/** 状态中文 → 规范串。同义异形（废止/已废止）必须在此归一，不能落到表里。 */
export function normalizeStatus(raw: unknown): StandardStatus {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (/废止|abolish/i.test(text)) return "abolished";
  if (/即将实施|upcoming/i.test(text)) return "upcoming";
  if (/现行|current|有效/i.test(text)) return "current";
  return "unknown";
}

/** 规范串 → 中文标签（导出用）。与 admin 的 STANDARD_STATUS_LABELS 是同一套语义的两次呈现。 */
export const STATUS_LABELS: Record<StandardStatus, string> = {
  current: "现行",
  upcoming: "即将实施",
  abolished: "已废止",
  unknown: "未标注",
};

/** 替换字符 U+FFFD：文本已损坏的确定信号，坏行入库会污染自检比对（见 routes.ts 原注释）。 */
function hasReplacementChar(value: string): boolean {
  return value.includes("�");
}

/**
 * exceljs 的 `xlsx.load` 类型定义写死 `load(data: Buffer)`，而本仓 @types/node 把
 * Buffer 泛型细化为 `Buffer<ArrayBuffer>`，两者运行时是同一类型、纯类型层不兼容。
 * 用 Parameters<> 取出真实入参类型做一次断言，把不兼容收窄在这一处——
 * exceljs 若换了签名，断言目标会自动跟随，不会烂到调用方。
 */
type ExcelLoadInput = Parameters<Excel.Workbook["xlsx"]["load"]>[0];

async function loadWorkbook(data: Uint8Array): Promise<Excel.Workbook> {
  const workbook = new Excel.Workbook();
  await workbook.xlsx.load(Buffer.from(data) as unknown as ExcelLoadInput);
  return workbook;
}

/**
 * 单元格 → 纯文本。
 * 只取 values，不取公式与富文本结构：导入方是人填的表格，公式结果列没有意义，
 * 而 { formula } 对象 String() 化会得到 "[object Object]" 这种脏值。
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDate(value);
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    // exceljs 对富文本/公式/超链接给的是对象壳，取其中最可能的文本承载字段。
    const record = value as { text?: unknown; result?: unknown; richText?: unknown };
    if (typeof record.text === "string") return record.text.trim();
    if (typeof record.result === "string") return record.result.trim();
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((part) => (typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : ""))
        .join("")
        .trim();
    }
    return "";
  }
  return String(value).trim();
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 单元格 → `YYYY-MM-DD` 或 null。
 *
 * Excel 的日期有两种落法：真日期单元格（exceljs 给 Date）和手打字符串。
 * 另有一种隐形坑——用户在单元格里打了「2024/3/5」被 Excel 自动识别成日期，
 * exceljs 会给 Date，此时按本地时区格式化即可，不要按 UTC（会差一天）。
 */
function cellDate(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { ok: false };
    return { ok: true, value: formatDate(value) };
  }
  const text = cellText(value);
  if (text === "") return { ok: true, value: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return { ok: false };
    return { ok: true, value: text };
  }
  // Excel 日期序列号（1900 纪元，含 1900-02-29 那个历史 bug 的偏移量 25569）
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 0 && serial < 100000) {
      const parsed = new Date(Math.round((serial - 25569) * 86400) * 1000);
      if (!Number.isNaN(parsed.getTime())) return { ok: true, value: formatDate(parsed) };
    }
  }
  return { ok: false };
}

export interface ParsedStandardRow {
  row: number;
  standardNo: string;
  standardName: string;
  status: StandardStatus;
  category: string | null;
  publishDate: string | null;
  implementDate: string | null;
  abolishDate: string | null;
  replaceInfo: string | null;
}

export interface ParseResult {
  /** Excel 数据行总数（不含表头与全空行）。 */
  received: number;
  /** 净化后可用行（已做文件内去重）。 */
  valid: ParsedStandardRow[];
  /** 无法解析的行，row 是 Excel 里的真实行号（含表头偏移），方便用户回去定位。 */
  invalid: Array<{ row: number; reason: string }>;
  /** 文件内重复被跳过的明细。 */
  fileDuplicates: Array<{ row: number; standardNo: string; standardName: string }>;
}

/**
 * 解析上传的标准清单 xlsx。
 *
 * 表头必须 8 列齐备且列名匹配（允许首尾空格）——列序错位会让「状态」列的数据
 * 写进「分类」，这种静默错位比报错更难发现，所以宁可 400。
 */
export async function parseStandardsWorkbook(data: Uint8Array): Promise<ParseResult> {
  const workbook = await loadWorkbook(data);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("工作簿里没有工作表");

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  for (let col = 1; col <= STANDARD_HEADERS.length; col += 1) {
    headers.push(cellText(headerRow.getCell(col).value));
  }
  for (let index = 0; index < STANDARD_HEADERS.length; index += 1) {
    const expected = STANDARD_HEADERS[index];
    const actual = headers[index] ?? "";
    if (actual !== expected) {
      throw new Error(
        `第 ${index + 1} 列表头应为「${expected}」，实际是「${actual || "空"}」；请使用「下载模板」生成的文件`,
      );
    }
  }

  const valid: ParsedStandardRow[] = [];
  const invalid: Array<{ row: number; reason: string }> = [];
  const fileDuplicates: Array<{ row: number; standardNo: string; standardName: string }> = [];
  const seen = new Set<string>();
  let received = 0;

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells = [
      cellText(row.getCell(1).value),
      cellText(row.getCell(2).value),
      cellText(row.getCell(3).value),
      cellText(row.getCell(4).value),
      row.getCell(5).value,
      row.getCell(6).value,
      row.getCell(7).value,
      cellText(row.getCell(8).value),
    ];
    // 全空行不是数据，不计入 received（表尾常有用户留下的空行）
    if (cells.every((cell) => cell === "" || cell === null)) return;
    received += 1;

    const standardNo = String(cells[0] ?? "");
    const standardName = String(cells[1] ?? "");
    if (!standardNo) {
      invalid.push({ row: rowNumber, reason: "标准编号为空" });
      return;
    }
    if (!standardName) {
      invalid.push({ row: rowNumber, reason: `标准名称为空（编号 ${standardNo}）` });
      return;
    }
    if (hasReplacementChar(standardNo) || hasReplacementChar(standardName)) {
      invalid.push({ row: rowNumber, reason: `编号或名称含乱码字符（${standardNo}）` });
      return;
    }

    const dates: (string | null)[] = [];
    for (let index = 4; index <= 6; index += 1) {
      const result = cellDate(cells[index]);
      if (!result.ok) {
        invalid.push({
          row: rowNumber,
          reason: `${STANDARD_HEADERS[index]}不是可识别的日期（${standardNo}）`,
        });
        return;
      }
      dates.push(result.value);
    }

    // 文件内去重：同一二元组只保留首次出现，后续行进 fileDuplicates。
    // 与库中判重口径一致，见 findExistingStandardKeys 注释。
    const key = standardKey(standardNo, standardName);
    if (seen.has(key)) {
      fileDuplicates.push({ row: rowNumber, standardNo, standardName });
      return;
    }
    seen.add(key);

    valid.push({
      row: rowNumber,
      standardNo,
      standardName,
      status: normalizeStatus(cells[2]),
      category: String(cells[3] ?? "") || null,
      publishDate: dates[0] ?? null,
      implementDate: dates[1] ?? null,
      abolishDate: dates[2] ?? null,
      replaceInfo: String(cells[7] ?? "") || null,
    });
  });

  return { received, valid, invalid, fileDuplicates };
}

/** 生成空模板：只有表头 + 一个说明 sheet，不在数据 sheet 放示例行（防误导入，spec §4.3）。 */
export async function buildTemplateWorkbook(): Promise<Uint8Array> {
  const workbook = new Excel.Workbook();
  const sheet = workbook.addWorksheet("标准清单");
  sheet.addRow([...STANDARD_HEADERS]);
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).commit();
  sheet.columns = [
    { width: 22 },
    { width: 40 },
    { width: 10 },
    { width: 16 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 30 },
  ];
  const help = workbook.addWorksheet("填写说明");
  help.addRow(["列", "必填", "说明"]);
  help.getRow(1).font = { bold: true };
  help.addRow(["标准编号", "是", "如 GB/T 50001-2017"]);
  help.addRow(["标准名称", "是", ""]);
  help.addRow(["状态", "否", "现行 / 即将实施 / 已废止 / 未标注，留空按未标注"]);
  help.addRow(["分类", "否", "如 材料/冶金"]);
  help.addRow(["发布日期", "否", "YYYY-MM-DD"]);
  help.addRow(["实施日期", "否", "YYYY-MM-DD"]);
  help.addRow(["废止日期", "否", "YYYY-MM-DD"]);
  help.addRow(["替换信息", "否", "源清单原文，如 替换:CB/T1033-1999;;"]);
  help.addRow(["", "", ""]);
  help.addRow(["筛重规则", "", "按「标准编号 + 标准名称」判重，两者都相同才算重复"]);
  help.addRow(["标识符", "", "由标准编号自动识别，无需填写"]);
  help.getColumn(1).width = 14;
  help.getColumn(2).width = 8;
  help.getColumn(3).width = 60;
  // 返回 Uint8Array 而不是 Buffer：Buffer 在 @types/node 里泛型细化为
  // Buffer<ArrayBuffer> / Buffer<ArrayBufferLike>，跨模块传递容易卡在类型上，
  // 而调用方（Hono c.body）本来就要 BodyInit。运行时二者同一块内存。
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export interface ExportStandardRow {
  standardNo: string;
  standardName: string;
  status: StandardStatus;
  category: string | null;
  publishDate: string | null;
  implementDate: string | null;
  abolishDate: string | null;
  replaceInfo: string | null;
}

/** 导出：列序与模板严格一致，状态输出中文（导出的文件改完能直接再导回）。 */
export async function buildExportWorkbook(
  rows: readonly ExportStandardRow[],
): Promise<Uint8Array> {
  const workbook = new Excel.Workbook();
  const sheet = workbook.addWorksheet("标准清单");
  sheet.addRow([...STANDARD_HEADERS]);
  sheet.getRow(1).font = { bold: true };
  sheet.columns = [
    { width: 22 },
    { width: 40 },
    { width: 10 },
    { width: 16 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 30 },
  ];
  for (const row of rows) {
    sheet.addRow([
      row.standardNo,
      row.standardName,
      STATUS_LABELS[row.status] ?? row.status,
      row.category ?? "",
      row.publishDate ?? "",
      row.implementDate ?? "",
      row.abolishDate ?? "",
      row.replaceInfo ?? "",
    ]);
  }
  // 冻结首行 + 自动筛选：13445 行没有这两样基本没法用
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: STANDARD_HEADERS.length },
  };
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
