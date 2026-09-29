/**
 * Settings 默认启用集合与 official-plugin-definitions 的 defaultEnabled 机械对照。
 * 两处漂移会导致「设置里默认开的」和「seed 时默认开的」不一致（见
 * packages/shared/src/plugin-marketplaces.ts 与 official-plugin-definitions.ts 注释）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS as SHARED_IDS } from "@zcode/shared";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS as BOOTSTRAP_IDS } from "../src/app/official-plugin-definitions.js";

test("defaultEnabled：bootstrap 与 shared 默认启用集合一致", () => {
  const fromBootstrap = [...BOOTSTRAP_IDS].sort();
  const fromShared = [...SHARED_IDS].sort();
  assert.deepEqual(
    fromBootstrap,
    fromShared,
    `默认启用集合漂移。\n仅 bootstrap: ${fromBootstrap.filter((id) => !SHARED_IDS.has(id)).join(", ") || "(无)"}\n仅 shared: ${fromShared.filter((id) => !BOOTSTRAP_IDS.has(id)).join(", ") || "(无)"}`,
  );
});

test("defaultEnabled：文件能力三件套必须同时在场", () => {
  for (const id of [
    "file-tools@zcode-plugins-official",
    "ocr-tools@zcode-plugins-official",
    "dwg-tools@zcode-plugins-official",
  ]) {
    assert.ok(BOOTSTRAP_IDS.has(id), `bootstrap 缺 ${id}`);
    assert.ok(SHARED_IDS.has(id), `shared 缺 ${id}`);
  }
});
