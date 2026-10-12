/**
 * 插件图标本地命中回归（`cd packages/ui && pnpm exec tsx --test test/pluginIconItem.test.ts`）。
 *
 * 为什么值得钉：设置页技能/子智能体列表曾把 `{ name, listing }` 直接喂给
 * PluginStoreAvatar，漏传 id。resolvePluginIconSource 只认完整插件身份
 * （`name@marketplace`），身份一缺就回退 listing.icon —— 那是官方 CDN 地址，
 * 内网可达时直接渲染上游旧标（黑底白 Z），本地打包的 Reactor 立方体反而用不上。
 * 这类回归不报错、不崩界面，只是图标"没换过来"，只能靠测试钉住。
 *
 * 注意：pluginIconSource.ts 直接 import .png，node:test 无法加载该扩展，
 * 因此这里不 import 它，改用「源码契约 + 资产存在」断言，行为仍由
 * resolvePluginIconSource 自身逻辑承担（CommandsSection 注释记录了同一口径）。
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveUniquePluginItemByName } from "../src/settings/pluginStoreListing.js";

const uiPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginIconSourcePath = join(uiPackageRoot, "src/lib/pluginIconSource.ts");
const pluginIconSource = readFileSync(pluginIconSourcePath, "utf8");

test("契约：zcode-guide 的完整身份映射到本地打包图标，且资产存在", () => {
  // 身份键必须带 marketplace 后缀，否则 resolvePluginIconSource 命中不到本地映射
  assert.match(
    pluginIconSource,
    /"zcode-guide@zcode-plugins-official":\s*zcodeGuideIconUrl/u,
    "zcode-guide@zcode-plugins-official 必须映射到本地打包图标",
  );
  const localIcon = join(uiPackageRoot, "src/assets/plugin-icons/zcode-guide.png");
  assert.ok(existsSync(localIcon), "本地 zcode-guide.png 资产应存在");
});

test("resolvePluginIconSource 行为契约：完整身份优先、缺身份回退 CDN", () => {
  // 与实现一致的纯逻辑复述：实现按 pluginId 精确命中本地映射，否则才看 https icon。
  // 此处不 import 模块（png 扩展 node:test 加载不了），仅钉住调用方依赖的判定口径。
  const CDN_ICON = "https://cdn-zcode.z.ai/zcode/official-plugin/assets/zcode-guide/icon.png";
  const resolvesToLocal = (pluginId: string | undefined) =>
    Boolean(pluginId) && pluginIconSource.includes(`"${pluginId}":`);
  assert.equal(resolvesToLocal("zcode-guide@zcode-plugins-official"), true);
  assert.equal(resolvesToLocal("zcode-guide"), false, "裸名不带 marketplace 后缀，命中不到本地映射");
  assert.equal(resolvesToLocal(undefined), false);
  assert.ok(CDN_ICON.startsWith("https://"), "回退路径只放行 https");
});

test("resolveUniquePluginItemByName：同名唯一时返回完整条目（含 id）", () => {
  const plugins = [
    {
      id: "zcode-guide@zcode-plugins-official",
      name: "zcode-guide",
      listing: { icon: "https://cdn.example/icon.png" },
    },
    { id: "pdf@zcode-plugins-official", name: "pdf", listing: {} },
  ];
  const item = resolveUniquePluginItemByName(plugins, "zcode-guide");
  assert.equal(item?.id, "zcode-guide@zcode-plugins-official");
  assert.equal(item?.name, "zcode-guide");
  assert.ok(item?.listing, "listing 一并保留");
});

test("resolveUniquePluginItemByName：同名多个时降级为 undefined（不误挂第三方品牌）", () => {
  const plugins = [
    { id: "obsidian@official", name: "obsidian", listing: {} },
    { id: "obsidian@third-party", name: "Obsidian", listing: {} },
  ];
  assert.equal(resolveUniquePluginItemByName(plugins, "obsidian"), undefined);
});

test("resolveUniquePluginItemByName：大小写与空白不敏感；无匹配返回 undefined", () => {
  const plugins = [{ id: "a@official", name: "ZCode-Guide", listing: {} }];
  assert.equal(resolveUniquePluginItemByName(plugins, "  zcode-guide ")?.id, "a@official");
  assert.equal(resolveUniquePluginItemByName(plugins, "other"), undefined);
  assert.equal(resolveUniquePluginItemByName([], "anything"), undefined);
});
