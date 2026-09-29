// 评审用：复刻 parse_document 的抽取路径（anydoc.toMarkdownBytes），把 4 份待审文档落成 .txt，
// 并对每个待报问题条 originalText 做逐字子串校验，保证 ReportReviewIssues 能定位/高亮。
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const ASSET =
  "E:/工作/Reactor-Work/apps/zcode-cli/packages/file-tools-plugin/assets/win32-x64/anydoc/node_modules/@firecrawl/anydoc";
const DIR = "E:/工作/Reactor-Work/docs/审查板块原始数据/标准库测试文档/";

const docs = [
  ["软件登记表.doc", "_软件登记表_extracted.txt"],
  ["软件说明书.docx", "_软件说明书_extracted.txt"],
  ["设计文件规范引用自查工具使用说明.pdf", "_设计文件规范引用自查工具使用说明_extracted.txt"],
];

const anydoc = require(ASSET);
for (const [src, out] of docs) {
  const md = await anydoc.toMarkdownBytes(new Uint8Array(readFileSync(DIR + src)));
  writeFileSync(DIR + out, md, "utf8");
  console.log(`=== ${src} -> ${out}  chars=${md.length}`);
}

// .doc 是 OLE 二进制（文本多为 UTF-16LE）；确认 Opteron/Xeon 后面的字符到底是原文还是抽取损失
const docBuf = readFileSync(DIR + "软件登记表.doc");
const u16 = docBuf.toString("latin1");
for (const needle of ["Opteron", "Xeon", "Pentium"]) {
  let idx = -1;
  // UTF-16LE: 每个 ASCII 字符后跟一个 0x00
  const pat = needle.split("").join("\u0000") + "\u0000";
  idx = u16.indexOf(pat);
  if (idx >= 0) {
    const seg = u16.slice(idx, idx + needle.length * 2 + 24);
    const chars = [];
    for (let i = 0; i + 1 < seg.length; i += 2) chars.push(seg.charCodeAt(i) | (seg.charCodeAt(i + 1) << 8));
    console.log(`RAW ${needle} @${idx} codes:`, chars.map((c) => c.toString(16)).join(" "));
  } else {
    console.log(`RAW ${needle}: not found`);
  }
}

// 说明书 docx 的换行/空格事实：把 word/document.xml 里的段落文本抽出来核对
const JSZip = (() => {
  try {
    return require("E:/工作/Reactor-Work/node_modules/jszip");
  } catch {
    return null;
  }
})();
console.log("jszip available:", !!JSZip);
