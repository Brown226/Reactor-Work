/**
 * 聊天模型选择器精简：单来源平铺 + 触发器占位兜底
 * （`npx tsx --test test/modelConfigSelect.test.ts`，需在 packages/ui 目录下执行）。
 *
 * 覆盖本次收敛的两条不变量：
 * 1. provider 分组层只在**多来源**时展示——单来源直接平铺模型，不再渲染来源标题；
 * 2. 触发器占位不再出现「管理模型」兜底（该入口已从聊天输入框移除），无分组时回落默认占位。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowModelProviderLevel, type ModelSelectGroup } from "../src/ModelConfigSelect.js";
import { resolveModelSelectTriggerDisplay } from "../src/chat-input-toolbar/modelSelection.js";

function group(key: string, values: string[]): ModelSelectGroup {
  return {
    key,
    label: key,
    items: values.map((value) => ({ key: `${key}:${value}`, value, name: value })),
  };
}

test("shouldShowModelProviderLevel：无分组不展示 provider 层", () => {
  assert.equal(shouldShowModelProviderLevel([]), false);
});

test("shouldShowModelProviderLevel：单一来源平铺，不展示 provider 层", () => {
  const groups = [group("registry-provider:reactor-enterprise", ["a", "b"])];
  assert.equal(shouldShowModelProviderLevel(groups), false);
});

test("shouldShowModelProviderLevel：两个及以上来源保留 provider 层", () => {
  const groups = [group("registry-provider:reactor-enterprise", ["a"]), group("family:zai", ["b"])];
  assert.equal(shouldShowModelProviderLevel(groups), true);
});

test("resolveModelSelectTriggerDisplay：命中可选分组时返回该值", () => {
  const groups = [group("registry-provider:reactor-enterprise", ["m1"])];
  assert.deepEqual(resolveModelSelectTriggerDisplay("m1", groups), {
    value: "m1",
    placeholder: undefined,
  });
});

test("resolveModelSelectTriggerDisplay：无分组时不再回落「管理模型」占位", () => {
  // 入口移除后，未选中模型应回落默认占位（undefined），而不是旧的「管理模型」兜底文案。
  assert.deepEqual(resolveModelSelectTriggerDisplay("", []), {
    value: undefined,
    placeholder: undefined,
  });
});

test("resolveModelSelectTriggerDisplay：<synthetic> 仍视为未选择", () => {
  const groups = [group("registry-provider:reactor-enterprise", ["m1"])];
  assert.deepEqual(resolveModelSelectTriggerDisplay("<synthetic>", groups), {
    value: undefined,
    placeholder: undefined,
  });
});
