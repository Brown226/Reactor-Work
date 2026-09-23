import assert from "node:assert/strict";
import test from "node:test";
import {
  PARSE_DWG_DESCRIPTION,
  extractStandardRefs,
  getStandardIdent,
} from "../src/tools/parse-dwg.js";

test("getStandardIdent：GB/T / NB/T / HAF / DL", () => {
  assert.equal(getStandardIdent("GB 150-2011"), "GB");
  assert.equal(getStandardIdent("GB/T 14976-2012"), "GB/T");
  assert.equal(getStandardIdent("NB/T 20001-2013"), "NB/T");
  assert.equal(getStandardIdent("HAF 003-2021"), "HAF");
  assert.equal(getStandardIdent("DL 5068-2014"), "DL");
  assert.equal(getStandardIdent(""), "");
});

test("extractStandardRefs：《名称》（编号）与纯编号两种形态", () => {
  const refs = extractStandardRefs([
    "-《发电厂化学设计规范》（DL 5068-2014）",
    "管道执行 GB/T 14976-2012 与 GB 50050-2017",
  ]);
  const byNo = new Map(refs.map((ref) => [ref.standardNo, ref]));
  assert.ok(byNo.has("DL 5068-2014"), "应捕获带书名号的标准引用");
  assert.equal(byNo.get("DL 5068-2014")?.standardName, "发电厂化学设计规范");
  assert.equal(byNo.get("DL 5068-2014")?.standardIdent, "DL");
  assert.ok(byNo.has("GB/T 14976-2012"));
  assert.equal(byNo.get("GB/T 14976-2012")?.standardIdent, "GB/T");
  assert.ok(byNo.has("GB 50050-2017"));
  assert.equal(byNo.get("GB 50050-2017")?.standardName, "");
});

test("extractStandardRefs：去重与去空白", () => {
  const refs = extractStandardRefs([
    "依据（GB 50050-2017）",
    "再次出现 GB 50050-2017 只保留一次",
  ]);
  const hits = refs.filter((ref) => ref.standardNo.includes("GB 50050-2017"));
  assert.equal(hits.length, 1);
  assert.ok(hits.every((ref) => ref.standardNo === ref.standardNo.trim()));
});

test("parse_dwg：工具描述面向模型可用", () => {
  assert.match(PARSE_DWG_DESCRIPTION, /parse_dwg|DWG/);
});
