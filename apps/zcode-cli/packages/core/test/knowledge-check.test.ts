/**
 * KnowledgeCheck 的确定性判定口径回归（`npx tsx --test packages/core/test/knowledge-check.test.ts`）。
 *
 * 这个文件守的不是"函数能跑"，而是**归一化与版本判定这几条踩过坑的口径**：
 * 库数据里三种编号写法并存、两位年号、全角标点、以及"版本标注必须参与匹配"。
 * 任何一条松动都会表现成"审查结果开始误报/漏报"，而那种缺陷在人工抽检里很难被发现。
 *
 * 后半段是工具级回归：缓存目录用 `REACTOR_KNOWLEDGE_DIR` 指到临时目录，
 * 这样不需要真实同步过知识库就能钉住 stale / notice / textFile 的行为。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_INLINE_TEXT_CHARS,
  buildFamilyCoverage,
  extractReferences,
  identFamily,
  judgeReference,
  knowledgeCheckToolEntry,
  normalizeReferenceText,
  parseStandardNo,
} from "../src/tool/handlers/knowledge-check.js";
import type { StandardLibraryEntry } from "../src/tool/handlers/knowledge-check.js";

const IDENTS = ["GB/T", "GB", "DL/T", "DL", "CECS", "HG/T", "JJG"];

test("归一化：全角、破折号、空白一律归一", () => {
  assert.equal(normalizeReferenceText("GB／T ８１６３—２０１８"), "GB/T8163-2018");
  assert.equal(normalizeReferenceText("gb/t 8163～2018"), "GB/T8163-2018");
  assert.equal(normalizeReferenceText("GB\t50016\n-2014"), "GB50016-2014");
});

test("解析：库里三种写法都要能拆开", () => {
  assert.deepEqual(parseStandardNo("GB/T 12459-2017", IDENTS), {
    ident: "GB/T",
    num: "12459",
    year: "2017",
    version: "",
  });
  assert.equal(parseStandardNo("GB/T8163-1999", IDENTS)?.num, "8163");
  const shortYear = parseStandardNo("GB12238-89", IDENTS);
  assert.equal(shortYear?.year, "1989", "两位年号按 19xx 补齐");
  const nineties = parseStandardNo("GB 50270-98", IDENTS);
  assert.equal(nineties?.year, "1998");
  const zero = parseStandardNo("GB 50084-01", IDENTS);
  assert.equal(zero?.year, "2001", "00-49 归到 20xx");
});

test("解析：版本标注必须被识别，脏年份不能静默当成年份", () => {
  assert.equal(parseStandardNo("GB50016-2014（2018年版）", IDENTS)?.version, "2018版");
  assert.equal(parseStandardNo("GB 50016-2014(局部修订)", IDENTS)?.version, "局部修订");
  assert.equal(parseStandardNo("GB 50016-2014(英文版)", IDENTS)?.version, "英文版");
  // 源数据里真实存在的脏值：`GB 1222-2323`，不能当成 2323 年参与比对
  assert.equal(parseStandardNo("GB 1222-2323", IDENTS), null);
  assert.equal(identFamily("GB/T"), "GB");
  assert.equal(identFamily("DL/T"), "DL");
});

const LIB: StandardLibraryEntry[] = [
  { standardNo: "GB/T 8163-2018", standardName: "输送流体用无缝钢管", status: "current", ident: "GB/T", publishDate: null },
  { standardNo: "GB/T 8163-2008", standardName: "输送流体用无缝钢管", status: "abolished", ident: "GB/T", publishDate: null },
  { standardNo: "GB/T 9123-2010", standardName: "钢制管法兰盖", status: "abolished", ident: "GB/T", publishDate: null },
  { standardNo: "GB/T 9124.1-2019", standardName: "钢制管法兰第1部分：PN系列", status: "current", ident: "GB/T", publishDate: null },
  { standardNo: "GB 50016-2014", standardName: "建筑设计防火规范", status: "abolished", ident: "GB", publishDate: null },
  { standardNo: "GB 50016-2014(2018年版)", standardName: "建筑设计防火规范(2018年版)", status: "current", ident: "GB", publishDate: null },
  { standardNo: "GB/T 12235-2007", standardName: "钢制截止阀和升降式止回阀", status: "current", ident: "GB/T", publishDate: null },
  { standardNo: "GB12238-89", standardName: "通用阀门法兰和对夹连接蝶阀", status: "abolished", ident: "GB", publishDate: null },
  { standardNo: "GB/T 12238-2008", standardName: "法兰和对夹连接弹性密封蝶阀", status: "current", ident: "GB/T", publishDate: null },
];

const judge = (reference: string) => judgeReference(parseStandardNo(reference, IDENTS)!, LIB);

test("判定：现行引用通过", () => {
  const result = judge("GB/T 8163-2018");
  assert.equal(result.code, "ok");
  assert.equal(result.severity, "none");
});

test("判定：已废止引用要给出库中现行版本", () => {
  const result = judge("GB/T 9123-2010");
  assert.equal(result.code, "abolished");
  assert.equal(result.severity, "error");
  // 幂等键/编号族邻接：库里有 9124.1-2019，但同编号族没有现行版时不该硬凑建议
  assert.equal(result.suggestion, null);
  assert.match(result.message, /已废止/);
});

test("判定：版本标注参与匹配 —— 引 2018 年版不能误报成废止", () => {
  // 库靠版本标注区分「已废止的原版」与「现行版」时，文档漏写标注要单独报 no_version，
  // 而不是含糊地判通过（设计文件里漏写「（2018年版）」非常常见）。
  const plain = judge("GB 50016-2014");
  assert.equal(plain.code, "no_version");
  assert.equal(plain.severity, "warning");
  assert.equal(plain.libraryStatus, "current");
  assert.match(plain.message, /应写明版本/);
  const versioned = judge("GB 50016-2014（2018年版）");
  assert.equal(versioned.code, "ok", "带标注的 2018 年版是现行");
  assert.equal(versioned.libraryStatus, "current");
});

test("判定：未注年代号要提示版本数并指出缺 /T", () => {
  const many = judge("GB 12235");
  assert.equal(many.code, "no_year");
  assert.equal(many.severity, "warning");
  assert.equal(many.suggestion, "GB/T 12235-2007");
  assert.match(many.message, /推荐性|缺 \/T/);

  // 库数据里 GB12238-89（前缀 GB）与 GB/T 12238-2008（前缀 GB/T）并存：
  // 只看同前缀会看不见现行版，必须合并同编号族再判。
  const dual = judge("GB 12238");
  assert.equal(dual.code, "no_year");
  assert.equal(dual.suggestion, "GB/T 12238-2008");
  assert.match(dual.message, /现行/);
});

test("判定：库里没有的行业标准要报未收录，而不是编一个结论", () => {
  const result = judge("DL5027-2015");
  assert.equal(result.code, "missing");
  assert.equal(result.libraryNo, null);
  assert.match(result.message, /人工确认/);
});

test("判定：库缺口与编号笔误必须分流（信噪比：6 条未收录里 5 条是库缺口）", () => {
  const coverage = buildFamilyCoverage(LIB);
  // 库里 GB 覆盖充分（多条）、DL 完全没有。
  assert.ok((coverage.get("GB") ?? 0) >= 5, "GB 族应有多条覆盖");
  assert.equal(coverage.get("DL") ?? 0, 0, "DL 族应判为无覆盖");

  const gap = judgeReference(parseStandardNo("DL5027-2015", IDENTS)!, LIB, coverage);
  assert.equal(gap.code, "family_not_collected");
  assert.equal(gap.severity, "info");
  assert.match(gap.message, /无法核对/);
  assert.match(gap.message, /不能据此判定该标准不存在/);

  // 覆盖充分却查不到：更像编号/年代号笔误，仍是 warning 并要人工确认。
  const typo = judgeReference(parseStandardNo("GB/T 99999-2020", IDENTS)!, LIB, coverage);
  assert.equal(typo.code, "missing");
  assert.equal(typo.severity, "warning");
  assert.match(typo.message, /同体系已收录/);

  // 不传覆盖度时不能静默得到乐观结论：走保守的 missing 分支。
  const unknown = judge("DL5027-2015");
  assert.equal(unknown.code, "missing");
  assert.match(unknown.message, /未提供库覆盖度统计/);
});

test("抽取：给出字符偏移与行号，且不吃掉库外的行业标准", () => {
  const text = [
    "一、引用标准",
    "GB/T 8163-2018、DL 5027-2015、GB 12238",
    "管件按 GB/T8163-1999 供货；材质 Q235-B。",
  ].join("\n");
  const found = extractReferences(text, IDENTS);
  const quoted = found.map((item) => item.quoted);
  assert.deepEqual(quoted, ["GB/T 8163-2018", "DL 5027-2015", "GB 12238", "GB/T8163-1999"]);
  assert.equal(found[0]!.line, 2);
  assert.equal(found[3]!.line, 3);
  // 偏移必须能切回原文：这是「点击问题 → 原文高亮」的正确性前提
  for (const item of found) {
    assert.equal(text.slice(item.startOffset, item.endOffset).replace(/\s+/g, " ").trim(), item.quoted);
  }
  assert.ok(
    !found.some((item) => item.quoted.includes("Q235")),
    "材料牌号 Q235-B 不是标准引用",
  );
});

const CACHE_ENV_KEY = "REACTOR_KNOWLEDGE_DIR";
const previousCacheDir = process.env[CACHE_ENV_KEY];

function withTempCache(run: (cacheDir: string) => Promise<void>): Promise<void> {
  const cacheDir = mkdtempSync(join(tmpdir(), "knowledge-check-"));
  process.env[CACHE_ENV_KEY] = cacheDir;
  return run(cacheDir).finally(() => {
    if (previousCacheDir === undefined) delete process.env[CACHE_ENV_KEY];
    else process.env[CACHE_ENV_KEY] = previousCacheDir;
    rmSync(cacheDir, { recursive: true, force: true });
  });
}

function seedStandards(cacheDir: string, fetchedAt: string): void {
  writeFileSync(
    join(cacheDir, "standards.json"),
    JSON.stringify({
      maxUpdatedAt: "2026-09-22T14:25:38.502Z",
      fetchedAt,
      items: LIB,
    }),
    "utf8",
  );
}

test("工具：rules 空库是合法状态，不得判 stale、不得提管理台", () =>
  withTempCache(async (cacheDir) => {
    writeFileSync(
      join(cacheDir, "rule-libraries.json"),
      JSON.stringify({ fetchedAt: new Date().toISOString(), libraries: [], items: {} }),
      "utf8",
    );
    const result = (await knowledgeCheckToolEntry.handler({ action: "rules" }, {} as never)) as {
      stale: boolean;
      notice: string | null;
      items: unknown[];
    };
    assert.equal(result.stale, false, "服务器上就是 0 个已发布库，同步多少次都不会变");
    assert.deepEqual(result.items, []);
    assert.match(result.notice ?? "", /没有已发布的规范库|未启用/);
    assert.ok(!/管理台/.test(result.notice ?? ""), "notice 面向普通用户，不能提管理台操作");
  }));

test("工具：缓存缺失才判 stale，并给出可执行提示", () =>
  withTempCache(async (cacheDir) => {
    const result = (await knowledgeCheckToolEntry.handler(
      { action: "rules" },
      {} as never,
    )) as { stale: boolean; notice: string };
    assert.equal(result.stale, true);
    assert.match(result.notice, /同步知识库/);
  }));

test("工具：旧快照只提示不判失败（stale=false + notice 说明快照年龄）", () =>
  withTempCache(async (cacheDir) => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    seedStandards(cacheDir, fiveDaysAgo);
    const result = (await knowledgeCheckToolEntry.handler(
      { action: "standards", text: "管件按 GB/T 8163-2018 供货。" },
      {} as never,
    )) as { stale: boolean; notice: string | null; summary: { total: number } };
    assert.equal(result.stale, false, "旧库仍可用，只是结论边界要说明");
    assert.match(result.notice ?? "", /天前/);
    assert.equal(result.summary.total, 1);
  }));

test("工具：textFile 用源文件本身做高亮目标，偏移是全文基准", () =>
  withTempCache(async (cacheDir) => {
    seedStandards(cacheDir, new Date().toISOString());
    const textFile = join(cacheDir, "design.extracted.txt");
    writeFileSync(textFile, "第一段。\n管件按 GB/T 8163-1999 供货。\n第三段。", "utf8");
    const result = (await knowledgeCheckToolEntry.handler(
      { action: "standards", textFile, sourcePath: textFile },
      {} as never,
    )) as { textPath: string | null; issues: { startOffset: number; endOffset: number }[] };
    assert.equal(result.textPath, textFile, "textFile 模式不再复制快照，直接用源文件");
    const offset = textFile === null ? 0 : "管件按 GB/T 8163-1999 供货。".indexOf("GB/T 8163-1999") + "第一段。\n".length;
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.startOffset, offset);
  }));

test("工具：内联正文超上限要报错并指向 textFile（不许手工切片）", () =>
  withTempCache(async (cacheDir) => {
    seedStandards(cacheDir, new Date().toISOString());
    const huge = "字".repeat(MAX_INLINE_TEXT_CHARS + 1);
    await assert.rejects(
      () => knowledgeCheckToolEntry.handler({ action: "standards", text: huge }, {} as never),
      /textFile/,
    );
  }));

