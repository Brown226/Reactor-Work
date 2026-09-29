/**
 * GenUI 动作回传格式（`npx tsx --test packages/ui/test/genUiActionBridge.test.ts`）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatGenUiActionPrompt } from "../src/genUi/genUiActionBridge.js";

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
