// 复刻 parse_document 的抽取路径（anydoc.toMarkdownBytes），把文本落成 .txt，
// 并校验每个待报问题条 originalText 是否为正文的逐字子串（保证可定位/可高亮）。
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const ASSET =
  "E:/工作/Reactor-Work/apps/zcode-cli/packages/file-tools-plugin/assets/win32-x64/anydoc/node_modules/@firecrawl/anydoc";
const PDF =
  "E:/工作/Reactor-Work/docs/审查板块原始数据/标准库测试文档/设计文件规范引用自查工具使用说明.pdf";
const DIR = "E:/工作/Reactor-Work/docs/审查板块原始数据/标准库测试文档/";

const anydoc = require(ASSET);
const md = await anydoc.toMarkdownBytes(new Uint8Array(readFileSync(PDF)));
writeFileSync(DIR + "_设计文件规范引用自查工具使用说明_extracted.txt", md, "utf8");
console.log("chars:", md.length, "| 与工具返回 charCount=774 是否一致:", md.length === 774);
console.log("=====RAW=====");
console.log(JSON.stringify(md));
console.log("=====END=====");

const quotes = [
  "文件格式如dwg",
  "引用的标准规范",
  "常用的文件格式如dwg、docx、pdf、xlsx 文件中引用的标准规范能够进行",
  "为不存在错误可上传的条数",
  "正在实施的现行标准",
  "二、注意事项：",
  "（1） 输入标准编号",
  "a) ",
];
for (const q of quotes) {
  const i = md.indexOf(q);
  console.log(i >= 0 ? `OK   ${JSON.stringify(q)} @ ${i}` : `MISS ${JSON.stringify(q)}`);
}
