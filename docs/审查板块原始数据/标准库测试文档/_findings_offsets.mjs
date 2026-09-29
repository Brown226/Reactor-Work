// 取文本实体（含 CAD 句柄），并为每条待报问题计算精确字符偏移。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SIDECAR =
  "E:/工作/Reactor-Work/apps/zcode-cli/packages/file-tools-plugin/dist/dwg-sidecar/win-x64/dwg-sidecar.exe";
const DWG =
  "E:/工作/Reactor-Work/docs/审查板块原始数据/标准库测试文档/FZ9HX011101B25A43SDACFC (15169HX-JPS01-001).dwg";
const DIR = "E:/工作/Reactor-Work/docs/审查板块原始数据/标准库测试文档/";

function runSidecar(req) {
  return new Promise((res, rej) => {
    const c = spawn(SIDECAR, [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d.toString("utf8")));
    c.on("error", rej);
    c.on("close", () => res(JSON.parse(out.trim().split("\n").pop())));
    c.stdin.write(JSON.stringify(req));
    c.stdin.end();
  });
}

const r = await runSidecar({ command: "read", path: DWG, maxTextEntities: 20000 });
writeFileSync(DIR + "_FZ9HX011101B25A43SDACFC_entities.json", JSON.stringify(r.textEntities, null, 2), "utf8");

const text = readFileSync(DIR + "_FZ9HX011101B25A43SDACFC_extracted.txt", "utf8");
const lines = text.split("\n");
const starts = [];
let acc = 0;
for (const l of lines) {
  starts.push(acc);
  acc += l.length + 1;
}
/** 在同一行内找第 n 次出现的子串，返回全文字符偏移。 */
const span = (lineNo, needle, nth = 1) => {
  const line = lines[lineNo - 1];
  let i = -1;
  for (let k = 0; k < nth; k++) i = line.indexOf(needle, i + 1);
  if (i < 0) return { line: lineNo, start: null, end: null, note: "未命中" };
  return { line: lineNo, start: starts[lineNo - 1] + i, end: starts[lineNo - 1] + i + needle.length };
};
/** 跨行区间：从 (行a,子串) 到 (行b,子串结尾)。 */
const span2 = (la, na, lb, nb) => {
  const ia = lines[la - 1].indexOf(na);
  const ib = lines[lb - 1].indexOf(nb) + nb.length;
  return { line: la, start: starts[la - 1] + ia, end: starts[lb - 1] + ib };
};

const targets = [
  ["GB-50050", () => span(13, "GB 50050-2017")],
  ["GB-50316", () => span(14, "GB 50316-2000")],
  ["GB-11984", () => span(16, "GB 11984-2008")],
  ["GBT-22839", () => span(17, "GB/T 22839-2010")],
  ["JBT-2932", () => span(20, "JB/T 2932-1999")],
  ["HG-20520", () => span(15, "HG 20520-1992")],
  ["HG-21504", () => span(22, "HG 21504.1-1992")],
  ["HGT-20679", () => span(12, "HG/T 20679-2014")],
  ["GBT-17395-1", () => span(25, "GB/T 17395-2008")],
  ["GBT-17395-2", () => span2(270, "（GB/T", 271, "17395-2008")],
  ["液体输送-1", () => span(26, "《液体输送用不锈钢焊接钢管》")],
  ["液体输送-2", () => span(269, "《液体输送用不锈钢焊接钢管》")],
  ["钢制法兰", () => span(31, "《钢制法兰 第1部分：PN系列》")],
  ["制氧", () => span(334, "水处理及制氧装置篇")],
  ["DL-5190.6-列表", () => span(32, "DL 5190.6-2019")],
  ["DLT-5190.6-正文", () => span(312, "DL/T 5190.6-2019")],
  ["DLT5190.5-无空格", () => span(330, "DL/T5190.5-2019")],
  ["DLT-5190.5-1", () => span(334, "DL/T 5190.5-2019", 1)],
  ["DLT-5190.5-2", () => span(334, "DL/T 5190.5-2019", 2)],
  ["刚衬塑-1", () => span(572, "刚衬塑")],
  ["刚衬塑-2", () => span(581, "刚衬塑")],
  ["刚衬塑-3", () => span(584, "刚衬塑")],
  ["刚衬塑-4", () => span(596, "刚衬塑")],
  ["算碱", () => span(595, "算/碱管路")],
  ["瀑灌", () => span(290, "瀑灌或空隙现孔")],
  ["DL-5068", () => span(8, "DL 5068-2014")],
  ["DL-5053", () => span(9, "DL 5053-2012")],
  ["DLT-5054", () => span(10, "DL/T 5054-2016")],
  ["DLT-5072", () => span(11, "DL/T 5072-2007")],
  ["DLT-716", () => span(18, "DL/T 716-2000")],
  ["DLT-746", () => span(19, "DL/T 746-2016")],
  ["DLT-935", () => span(28, "DL/T 935-2020")],
  ["CECS-41", () => span(29, "CECS 41:2004")],
  ["TCECS-122", () => span(30, "T/CECS 122-2020")],
];
const offsets = {};
for (const [k, f] of targets) offsets[k] = f();

// 关键文本实体 → CAD 句柄
const ents = r.textEntities ?? [];
const handlesOf = (needle) =>
  ents.filter((e) => String(e.text).includes(needle)).map((e) => e.handle + ":" + String(e.text).slice(0, 40));
const handles = {
  "刚衬塑": handlesOf("刚衬塑"),
  "算/碱管路": handlesOf("算/碱管路"),
  "制氧": handlesOf("制氧"),
  "瀑灌": handlesOf("瀑灌"),
  "DL/T5190.5-2019": handlesOf("DL/T5190.5-2019"),
  "DL/T 5190.5-2019": handlesOf("DL/T 5190.5-2019"),
};
writeFileSync(DIR + "_offsets.json", JSON.stringify({ offsets, handles }, null, 2), "utf8");
console.log(JSON.stringify({ offsets, handles }, null, 2));
