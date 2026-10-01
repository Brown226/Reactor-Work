/**
 * GenUI 动作回传格式与路由（`npx tsx --test packages/ui/test/genUiActionBridge.test.ts`）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendGenUiActionToComposerDraft,
  formatGenUiActionPrompt,
} from "../src/genUi/genUiActionBridge.js";
import {
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "../src/v4/composer/composerDraftStore.js";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";

/** node 下没有 window：给草稿槽落盘路径挂一个内存 localStorage，断言真实写入。 */
function installMemoryStorage(): () => void {
  const state = new Map<string, string>();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => state.get(key) ?? null,
      setItem: (key: string, value: string) => {
        state.set(key, value);
      },
      removeItem: (key: string) => {
        state.delete(key);
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

test("formatGenUiActionPrompt：按钮动作", () => {
  const prompt = formatGenUiActionPrompt({ actionId: "refresh_weather" });
  assert.equal(prompt, "[GenUI action] actionId=refresh_weather");
});

test("formatGenUiActionPrompt：表单值进 JSON", () => {
  const prompt = formatGenUiActionPrompt({
    actionId: "submit",
    formValues: { formId: "weather_form", city: "北京" },
  });
  assert.match(prompt, /actionId=submit/);
  assert.match(prompt, /values=\{/);
  assert.match(prompt, /北京/);
});

test("formatGenUiActionPrompt：缺 actionId 时占位", () => {
  assert.match(formatGenUiActionPrompt({}), /actionId=action/);
});

test("appendGenUiActionToComposerDraft：有会话时改走插入请求（目标会话 + append）", async () => {
  const restoreWindow = installMemoryStorage();
  try {
    useZCodeSessionStore.setState({ workspaces: {} });
    appendGenUiActionToComposerDraft({
      workspacePath: "/ws",
      workspaceIdentity: "remote:ws",
      scopeId: V4_DRAFT_SCOPE_ROOT,
      sessionId: "sess-1",
      event: { actionId: "submit", formValues: { city: "北京" } },
    });
    const readRequest = () =>
      useZCodeSessionStore
        .getState()
        .getWorkspaceState("/ws", "remote:ws").composerTextInsertRequest;
    await waitFor(() => readRequest() != null);

    const request = readRequest();
    assert.equal(request?.sessionId, "sess-1");
    assert.equal(request?.mode, "append");
    assert.match(request?.text ?? "", /actionId=submit/);
    // 旧 bug 的症状：动作文本落进根草稿槽，当前会话输入框看不到。
    assert.equal(readV4ComposerDraft("/ws", "remote:ws", V4_DRAFT_SCOPE_ROOT), null);
  } finally {
    restoreWindow();
  }
});

test("appendGenUiActionToComposerDraft：无会话时仍写根草稿槽且追加在已有正文之后", async () => {
  const restoreWindow = installMemoryStorage();
  try {
    useZCodeSessionStore.setState({ workspaces: {} });
    appendGenUiActionToComposerDraft({
      workspacePath: "/ws",
      workspaceIdentity: "remote:ws",
      scopeId: V4_DRAFT_SCOPE_ROOT,
      sessionId: null,
      event: { actionId: "first" },
    });
    await waitFor(
      () => readV4ComposerDraft("/ws", "remote:ws", V4_DRAFT_SCOPE_ROOT) !== null,
    );
    appendGenUiActionToComposerDraft({
      workspacePath: "/ws",
      workspaceIdentity: "remote:ws",
      scopeId: V4_DRAFT_SCOPE_ROOT,
      event: { actionId: "second" },
    });
    await waitFor(() =>
      Boolean(
        readV4ComposerDraft("/ws", "remote:ws", V4_DRAFT_SCOPE_ROOT)?.text.includes(
          "actionId=second",
        ),
      ),
    );
    const merged = readV4ComposerDraft("/ws", "remote:ws", V4_DRAFT_SCOPE_ROOT)?.text ?? "";
    assert.ok(merged.startsWith("[GenUI action] actionId=first"));
    assert.match(merged, /\[GenUI action\] actionId=second/);
    assert.equal(
      useZCodeSessionStore.getState().getWorkspaceState("/ws", "remote:ws")
        .composerTextInsertRequest,
      null,
    );
  } finally {
    restoreWindow();
  }
});
