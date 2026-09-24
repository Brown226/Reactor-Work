/**
 * 「按原文片段找第几处」的回归（`npx tsx --test packages/ui/test/quoteSearch.test.ts`）。
 *
 * 这层是渲染后高亮唯一的定位依据：偏移在渲染后的正文里没有对应位置，能跨过去的是片段文字。
 * 规则必须与 CLI 侧 `normalizeWithMap` 一致，否则同一份文档两侧数出来的「第 N 处」不同，
 * 用户点了第二条却跳到第一处 —— 跳错位置比不跳更误导复核者。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { locateQuoteOccurrence, normalizeWithIndexMap } from "../src/lib/quoteSearch.js";

test("归一化：全角转半角、空白丢弃、连字符与斜杠统一、大写归一", () => {
  assert.equal(normalizeWithIndexMap("ＧＢ／Ｔ ８１６３").text, "GB/T8163");
  assert.equal(normalizeWithIndexMap("GB 12238").text, "GB12238");
  assert.equal(normalizeWithIndexMap("a—b–c~d〜e").text, "A-B-C-D-E");
  assert.equal(normalizeWithIndexMap("全角　空格").text, "全角空格");
});

test("归一化下标能回到原文：空白与全角转换都不错位", () => {
  const raw = "见 GB 12238。";
  const { text, indices } = normalizeWithIndexMap(raw);
  assert.equal(text, "见GB12238。");
  // 「1」在原文里的下标是 5（含空格）
  assert.equal(raw[indices[text.indexOf("1")]!], "1");
  // 归一化末位的句号必须指回原文字符
  assert.equal(raw[indices[indices.length - 1]!], "。");
});

test("取第 N 处：重复句子按序号命中，越界退回第一处", () => {
  const text = "第一条：安装调试。第二条：安装调试。";
  const first = locateQuoteOccurrence(text, "安装调试", 1);
  const second = locateQuoteOccurrence(text, "安装调试", 2);
  assert.ok(first && second);
  assert.notEqual(first.start, second.start);
  assert.equal(text.slice(first.start, first.end), "安装调试");
  assert.equal(text.slice(second.start, second.end), "安装调试");
  assert.equal(second.total, 2);
  // 序号越界不猜：退回第一处（与 CLI 的 collectOccurrences 同口径）
  assert.deepEqual(locateQuoteOccurrence(text, "安装调试", 9), first);
});

test("渲染差异不影响命中：空白被折叠、全半角混排仍能找到", () => {
  // 源码里的换行在渲染后是空格；引号与破折号也会被 markdown 改写
  const rendered = "# 标题\n\n支持 dwg、docx、pdf、xlsx 等常见文件。\n";
  const hit = locateQuoteOccurrence(rendered, "支持 dwg、docx、pdf、xlsx 等常见文件。");
  assert.ok(hit);
  assert.equal(rendered.slice(hit.start, hit.end), "支持 dwg、docx、pdf、xlsx 等常见文件。");

  const halfWidth = locateQuoteOccurrence("接口支持dwg、docx格式", "支持 dwg、docx");
  assert.ok(halfWidth, "分词空白差异要被归一化吸收");
});

test("找不到就返回 null，绝不退化成模糊匹配", () => {
  assert.equal(locateQuoteOccurrence("这是一段正文", "完全无关的句子"), null);
  assert.equal(locateQuoteOccurrence("这是一段正文", "   "), null);
  assert.equal(locateQuoteOccurrence("这是一段正文", ""), null);
});
