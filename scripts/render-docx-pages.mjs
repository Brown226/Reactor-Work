/**
 * 把 `.docx` 逐页渲染成 PNG，用于文档产出的视觉验收（`docs/已完成/已完成-文档产出-规范-v1.md` 第 7 节）。
 *
 * 为什么需要它：解包看 XML 只能证明属性写对了，证明不了 Word 打开后的样子。列宽够不够、
 * 有没有单元格被压成竖排、表头和表体是否一眼可分 —— 这些只能用渲染结果判断。
 *
 * 为什么不用 Word 自动化：本机 `New-Object -ComObject Word.Application` 会被拒
 * （0x800702E4 需要提升），而无人的环境里没法应答 UAC。改用仓库里已有的 `docx-preview`
 * （应用内 docx 预览用的就是它）：它按 OOXML 的 tblGrid / shd / borders / rFonts 渲染。
 * 保真度边界：页眉页脚与页码域不如 Word（那部分用单测从 XML 断言，见 document-style.test.ts）。
 *
 * 用法：`pnpm render:docx <file.docx> [outDir]`
 * 依赖本机装有 Edge 或 Chrome（用独立浏览器进程，不碰任何正在运行的应用）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JSZIP = join(ROOT, "node_modules/jszip/dist/jszip.min.js");
const DOCX_PREVIEW = join(ROOT, "node_modules/docx-preview/dist/docx-preview.min.js");

const [docxArg, outArg] = process.argv.slice(2);
if (!docxArg) {
  console.error("用法：pnpm render:docx <file.docx> [outDir]");
  process.exit(1);
}
const docxPath = resolve(docxArg);
const outDir = resolve(outArg ?? join(ROOT, ".tmp-render"));
mkdirSync(outDir, { recursive: true });
const stem = basename(docxPath).replace(/\.docx$/i, "");
const base64 = readFileSync(docxPath).toString("base64");

/** Edge 优先、Chrome 兜底：两个都是 Chromium，渲染结果一致。 */
async function launchBrowser() {
  const errors = [];
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (error) {
      errors.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`没有可用的 Edge/Chrome：\n${errors.join("\n")}`);
}

const browser = await launchBrowser();
try {
  const page = await (await browser.newContext()).newPage();
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}#host{padding:24px}</style></head><body><div id="host"></div></body></html>`,
  );
  // docx-preview 的 UMD 构建依赖全局 JSZip：不先注入就在 loadAsync 处炸。
  await page.addScriptTag({ path: JSZIP });
  await page.addScriptTag({ path: DOCX_PREVIEW });

  const evidence = await page.evaluate(async (payload) => {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const host = document.getElementById("host");
    await globalThis.docx.renderAsync(new Blob([bytes]), host, null, {
      inWrapper: true,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
    });
    const pages = [...host.querySelectorAll("section.docx")];
    const tables = [...host.querySelectorAll("section.docx table")];
    const lastTable = tables.at(-1);
    return {
      // 页面尺寸反证纸张方向：A4 纵向 ≈ 794px、横向 ≈ 1123px（96dpi）
      pageSizes: pages.map(
        (el) =>
          `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`,
      ),
      styleClasses: [
        ...new Set(
          [...host.querySelectorAll("[class]")]
            .map((el) => (typeof el.className === "string" ? el.className : ""))
            .filter((name) => name.startsWith("docx_")),
        ),
      ],
      issueColumnWidthsPt: lastTable
        ? [...lastTable.rows[0].cells].map(
            (cell) => cell.getAttribute("style")?.match(/width:\s*([\d.]+)pt/)?.[1] ?? null,
          )
        : null,
      headerShade: lastTable?.rows[0]?.cells[0]
        ? getComputedStyle(lastTable.rows[0].cells[0]).backgroundColor
        : null,
    };
  }, base64);

  const handles = await page.$$("section.docx");
  const files = [];
  for (const [index, handle] of handles.entries()) {
    const file = join(outDir, `${stem}-page-${index + 1}.png`);
    await handle.screenshot({ path: file });
    files.push(file);
  }
  const report = { docx: docxPath, pages: files, ...evidence };
  writeFileSync(join(outDir, `${stem}-render.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
