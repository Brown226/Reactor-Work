/**
 * composer 文本插入请求：目标会话归因 + 追加拼接 + store 语义
 * （`npx tsx --test packages/ui/test/composerTextInsert.test.ts`）。
 *
 * 覆盖的缺陷：PDF「引用进会话」/ GenUI 动作回传在已有会话里被写进新建任务根草稿槽
 * `__draft__`，当前会话输入框看不到任何东西。这里锁住修好后的三条不变量：
 * 1. 请求带目标会话标识；
 * 2. 只有目标匹配的 composer 消费（草稿 composer 只吃无目标请求）；
 * 3. 追加语义不覆盖已有文本。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendBlockToComposerDraftText,
  matchesComposerTextInsertTarget,
  normalizeComposerTextInsertSessionId,
} from "../src/lib/composerTextInsert.js";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";

function resetWorkspaces() {
  useZCodeSessionStore.setState({ workspaces: {} });
}

test("normalizeComposerTextInsertSessionId：空白串等同草稿槽", () => {
  assert.equal(normalizeComposerTextInsertSessionId(undefined), null);
  assert.equal(normalizeComposerTextInsertSessionId(null), null);
  assert.equal(normalizeComposerTextInsertSessionId("   "), null);
  assert.equal(normalizeComposerTextInsertSessionId(" sess-1 "), "sess-1");
});

test("matchesComposerTextInsertTarget：无目标请求只命中草稿 composer", () => {
  const request = { requestId: 1, text: "hi" };
  assert.equal(matchesComposerTextInsertTarget(request, null), true);
  assert.equal(matchesComposerTextInsertTarget(request, undefined), true);
  // 已有会话不得消费无目标请求（Example Prompt 等仍只服务新建任务态）。
  assert.equal(matchesComposerTextInsertTarget(request, "sess-1"), false);
});

test("matchesComposerTextInsertTarget：带目标请求只命中该会话", () => {
  const request = { requestId: 2, text: "quote", sessionId: "sess-1" };
  assert.equal(matchesComposerTextInsertTarget(request, "sess-1"), true);
  assert.equal(matchesComposerTextInsertTarget(request, "sess-2"), false);
  // 目标会话存在时不能被草稿 composer 抢走。
  assert.equal(matchesComposerTextInsertTarget(request, null), false);
  assert.equal(matchesComposerTextInsertTarget(null, "sess-1"), false);
});

test("appendBlockToComposerDraftText：保留用户已输入正文", () => {
  assert.equal(
    appendBlockToComposerDraftText("用户已经敲了一半", "[PDF 引用] a.pdf page=2"),
    "用户已经敲了一半\n\n[PDF 引用] a.pdf page=2\n",
  );
  assert.equal(appendBlockToComposerDraftText(undefined, "[GenUI action] actionId=x"), "[GenUI action] actionId=x\n");
  assert.equal(appendBlockToComposerDraftText("   \n ", "block"), "block\n");
  // 追加必须发生在后面：原文本作为前缀逐字保留。
  const merged = appendBlockToComposerDraftText("keep me\nline2", "new block");
  assert.ok(merged.startsWith("keep me\nline2\n\n"));
});

test("requestComposerTextInsert：请求携带目标会话与 append 模式", () => {
  resetWorkspaces();
  const store = useZCodeSessionStore.getState();
  const requestId = store.requestComposerTextInsert(
    "/ws",
    "[PDF 引用] a.pdf page=2",
    "remote:ws",
    undefined,
    "append",
    " sess-1 ",
  );

  const request = useZCodeSessionStore
    .getState()
    .getWorkspaceState("/ws", "remote:ws").composerTextInsertRequest;
  assert.equal(request?.requestId, requestId);
  assert.equal(request?.mode, "append");
  // 目标会话已归一化（去空白），消费侧比较不再被空白差异骗过。
  assert.equal(request?.sessionId, "sess-1");
  assert.equal(matchesComposerTextInsertTarget(request, "sess-1"), true);
});

test("requestComposerTextInsert：无会话时仍是草稿槽请求（旧行为）", () => {
  resetWorkspaces();
  useZCodeSessionStore
    .getState()
    .requestComposerTextInsert("/ws", "example prompt", undefined, undefined, "replace", null);
  const request = useZCodeSessionStore.getState().getWorkspaceState("/ws").composerTextInsertRequest;
  assert.equal(request?.sessionId, undefined);
  assert.equal(matchesComposerTextInsertTarget(request, null), true);
});

test("clearComposerTextInsertRequest：按 requestId 去重，旧 id 不得清掉新请求", () => {
  resetWorkspaces();
  const store = useZCodeSessionStore.getState();
  const first = store.requestComposerTextInsert("/ws", "one", undefined, undefined, "append", "sess-1");
  const second = useZCodeSessionStore
    .getState()
    .requestComposerTextInsert("/ws", "two", undefined, undefined, "append", "sess-2");
  assert.equal(second, first + 1);

  // 旧请求的迟到清理不能抹掉新请求（版本号已经前移）。
  useZCodeSessionStore.getState().clearComposerTextInsertRequest("/ws", first);
  assert.equal(
    useZCodeSessionStore.getState().getWorkspaceState("/ws").composerTextInsertRequest?.requestId,
    second,
  );

  // 命中当前 requestId 才清空。
  useZCodeSessionStore.getState().clearComposerTextInsertRequest("/ws", second);
  assert.equal(
    useZCodeSessionStore.getState().getWorkspaceState("/ws").composerTextInsertRequest,
    null,
  );
  const version = useZCodeSessionStore.getState().getWorkspaceState("/ws").composerTextInsertVersion;
  assert.equal(version, second);
});

test("clearComposerTextInsertRequest：按 identity 分桶，不误清同路径的远程 workspace", () => {
  resetWorkspaces();
  const local = useZCodeSessionStore
    .getState()
    .requestComposerTextInsert("/ws", "local", undefined, undefined, "append", "sess-1");
  const remote = useZCodeSessionStore
    .getState()
    .requestComposerTextInsert("/ws", "remote", "remote:ws", undefined, "append", "sess-1");
  assert.equal(local, 1);
  assert.equal(remote, 1);

  useZCodeSessionStore.getState().clearComposerTextInsertRequest("/ws", remote, "remote:ws");
  assert.equal(
    useZCodeSessionStore.getState().getWorkspaceState("/ws").composerTextInsertRequest?.text,
    "local",
  );
  assert.equal(
    useZCodeSessionStore.getState().getWorkspaceState("/ws", "remote:ws").composerTextInsertRequest,
    null,
  );
});
