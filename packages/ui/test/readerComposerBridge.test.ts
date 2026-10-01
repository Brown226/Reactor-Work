/**
 * readerComposerBridge 纯函数（`npx tsx --test packages/ui/test/readerComposerBridge.test.ts`）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendPdfQuoteToComposerDraft,
  extractCitationsFromText,
  flattenPdfJsOutline,
  formatPdfQuoteDraft,
  scanPaperPagesForFiguresAndFormulas,
  splitReferenceEntries,
} from "../src/pdf-reader/readerComposerBridge.js";
import { readV4ComposerDraft, V4_DRAFT_SCOPE_ROOT } from "../src/v4/composer/composerDraftStore.js";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";
import type { ComposerTextInsertRequest } from "../src/store/zcodeSessionStoreTypes.js";

/** node 下没有 window：给草稿槽落盘路径挂一个内存 localStorage，断言真实写入。 */
function installMemoryStorage(): () => void {
  const store = new Map<string, string>();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  };
  return () => {
    if (previous === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previous;
    }
  };
}

/** 桥接函数内部是动态 import（保持纯函数模块可测），落库时机异步：轮询到稳定为止。 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

function readInsertRequest(
  workspacePath: string,
  workspaceIdentity?: string,
): ComposerTextInsertRequest | null {
  return (
    useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
      .composerTextInsertRequest ?? null
  );
}

test("splitReferenceEntries：编号条目优先", () => {
  const entries = splitReferenceEntries("[1] Alpha paper.\n[2] Beta work.\n[3] Gamma study.");
  assert.equal(entries.length, 3);
  assert.match(entries[0], /Alpha/);
});

test("extractCitationsFromText：从 References 后拆条", () => {
  const text =
    "Abstract body.\nReferences\n[1] A. Author. Paper. 2020\n[2] B. Writer. Work.\n[3] C. Cite. More.";
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

test("appendPdfQuoteToComposerDraft：有会话时改走插入请求（目标会话 + append）", async () => {
  const restoreWindow = installMemoryStorage();
  try {
    useZCodeSessionStore.setState({ workspaces: {} });
    appendPdfQuoteToComposerDraft({
      workspacePath: "/ws",
      workspaceIdentity: "remote:ws",
      scopeId: V4_DRAFT_SCOPE_ROOT,
      sessionId: "sess-1",
      draft: "[PDF 引用] a.pdf page=2\n---\n原文\n---",
    });
    await waitFor(() => readInsertRequest("/ws", "remote:ws") !== null);

    const request = readInsertRequest("/ws", "remote:ws");
    assert.equal(request?.sessionId, "sess-1");
    assert.equal(request?.mode, "append");
    assert.match(request?.text ?? "", /\[PDF 引用\] a\.pdf/);
    // 旧 bug 的症状：正文落进根草稿槽，当前会话输入框看不到。这里锁死不能回退。
    assert.equal(readV4ComposerDraft("/ws", "remote:ws", V4_DRAFT_SCOPE_ROOT), null);
  } finally {
    restoreWindow();
  }
});

test("appendPdfQuoteToComposerDraft：无会话时仍写根草稿槽且不吞掉已有草稿", async () => {
  const restoreWindow = installMemoryStorage();
  try {
    useZCodeSessionStore.setState({ workspaces: {} });
    appendPdfQuoteToComposerDraft({
      workspacePath: "/ws",
      workspaceIdentity: "remote:ws",
      scopeId: V4_DRAFT_SCOPE_ROOT,
      sessionId: null,
      draft: "[PDF 引用] a.pdf page=2\n---\n原文\n---",
    });
    await waitFor(() => readV4ComposerDraft("/ws", "remote:ws", V4_DRAFT_SCOPE_ROOT) !== null);
    assert.equal(
      readV4ComposerDraft("/ws", "remote:ws", V4_DRAFT_SCOPE_ROOT)?.text,
      "[PDF 引用] a.pdf page=2\n---\n原文\n---\n",
    );

    // 第二次引用叠加在已有草稿之后，不覆盖用户已输入内容。
    appendPdfQuoteToComposerDraft({
      workspacePath: "/ws",
      workspaceIdentity: "remote:ws",
      scopeId: V4_DRAFT_SCOPE_ROOT,
      draft: "[PDF 引用] b.pdf page=9\n---\n第二段\n---",
    });
    await waitFor(() =>
      Boolean(
        readV4ComposerDraft("/ws", "remote:ws", V4_DRAFT_SCOPE_ROOT)?.text.includes(
          "[PDF 引用] b.pdf",
        ),
      ),
    );
    const merged = readV4ComposerDraft("/ws", "remote:ws", V4_DRAFT_SCOPE_ROOT)?.text ?? "";
    assert.ok(merged.startsWith("[PDF 引用] a.pdf page=2"));
    assert.match(merged, /\[PDF 引用\] b\.pdf page=9/);

    // 无会话不做实时插入请求（保持今天的行为）。
    assert.equal(readInsertRequest("/ws", "remote:ws"), null);
  } finally {
    restoreWindow();
  }
});

test("scanPaperPagesForFiguresAndFormulas：图注按 label 去重并带页码", () => {
  const { figures } = scanPaperPagesForFiguresAndFormulas([
    { page: 3, text: "As shown in Figure 2, the flux ... Fig. 2 again" },
    { page: 5, text: "Table 1 summarizes ... Figure 2 repeats" },
  ]);
  assert.equal(figures.length, 2);
  assert.deepEqual(
    figures.map((f) => [f.label, f.page, f.kind]),
    [
      ["Figure 2", 3, "figure"],
      ["Table 1", 5, "table"],
    ],
  );
});

test("scanPaperPagesForFiguresAndFormulas：公式候选带页码且过滤噪声行", () => {
  const { formulas } = scanPaperPagesForFiguresAndFormulas([
    {
      page: 4,
      text: "Q = α·A·(T_s − T_f) ≤ Q_max\nSee https://example.com for details\nThis plain sentence has no math hints at all.",
    },
  ]);
  assert.equal(formulas.length, 1);
  assert.equal(formulas[0].page, 4);
  assert.ok(formulas[0].text.includes("Q = "));
});

test("scanPaperPagesForFiguresAndFormulas：空输入返回空数组", () => {
  const { figures, formulas } = scanPaperPagesForFiguresAndFormulas([]);
  assert.deepEqual(figures, []);
  assert.deepEqual(formulas, []);
});
