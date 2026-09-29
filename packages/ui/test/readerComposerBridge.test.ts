/**
 * readerComposerBridge 纯函数（`npx tsx --test packages/ui/test/readerComposerBridge.test.ts`）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCitationsFromText,
  flattenPdfJsOutline,
  formatPdfQuoteDraft,
  splitReferenceEntries,
} from "../src/pdf-reader/readerComposerBridge.js";

test("splitReferenceEntries：编号条目优先", () => {
  const entries = splitReferenceEntries("[1] Alpha paper.\n[2] Beta work.\n[3] Gamma study.");
  assert.equal(entries.length, 3);
  assert.match(entries[0], /Alpha/);
});

test("extractCitationsFromText：从 References 后拆条", () => {
  const text = "Abstract body.\nReferences\n[1] A. Author. Paper. 2020\n[2] B. Writer. Work.\n[3] C. Cite. More.";
  const cites = extractCitationsFromText(text);
  assert.ok(cites.length >= 2);
  assert.equal(cites[0].marker, "[1]");
  assert.match(cites[0].text, /Author/);
});

test("extractCitationsFromText：无 References 返回空", () => {
  assert.deepEqual(extractCitationsFromText("Just an abstract."), []);
});

test("flattenPdfJsOutline：嵌套层级展平", () => {
  const outline = flattenPdfJsOutline(
    [
      {
        title: "Intro",
        dest: "p1",
        items: [{ title: "Related", dest: "p2" }],
      },
    ],
    (dest) => (dest === "p1" ? 1 : dest === "p2" ? 2 : null),
  );
  assert.equal(outline.length, 2);
  assert.equal(outline[0].level, 1);
  assert.equal(outline[1].level, 2);
  assert.equal(outline[1].page, 2);
});

test("formatPdfQuoteDraft：含文件名页码与原文", () => {
  const draft = formatPdfQuoteDraft({
    fileName: "attention.pdf",
    page: 3,
    text: "Scaled Dot-Product Attention",
    instruction: "请解释这句话。",
  });
  assert.match(draft, /attention\.pdf/);
  assert.match(draft, /page=3/);
  assert.match(draft, /Scaled Dot-Product Attention/);
  assert.match(draft, /请解释这句话/);
});
