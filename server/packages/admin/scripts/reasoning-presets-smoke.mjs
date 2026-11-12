/**
 * 推理档位预设冒烟（纯函数，**不起 HTTP、不连 DB**）。
 *
 * 覆盖 `src/lib/reasoning-presets.ts`：
 *   ① 预设表自身一致性（key 唯一、levels 有序且非空集合才有 map、label 不重复）；
 *   ② 反查闭环 —— 每个预设的 levels+map 都必须能反查回自己的 key（否则界面选中后
 *      下次打开会跳成"自定义"，管理员会以为配置丢了）；
 *   ③ 按模型特征的推断 —— 已知家族命中对应预设，未知模型落安全缺省；
 *   ④ 已配置过的模型反查（非标准写法落 custom 且**不静默改写**原值）；
 *   ⑤ **安全断言**：任何非 off 预设，`disabled` 档都不许往请求体写字段。
 *      这一条是本次改动的命门 —— 用户最初的故障正是"打开思考后无法正常对话"，
 *      如果某个预设让"关闭思考"也带上游不认的参数，就等于把故障扩大到所有档位。
 *
 * 为什么单独一个脚本而不是并进 server 的 admin-smoke：那个是 pg 直连的数据域冒烟，
 * 而这里是 admin 前端的纯函数；且本脚本靠 Node 24 的 type stripping 直接跑 TS 源，
 * 不需要构建产物，改完立刻能验。
 *
 * 用法：pnpm --filter @reactor/admin smoke:reasoning-presets
 *      （或 node --experimental-strip-types scripts/reasoning-presets-smoke.mjs）
 */

import { fileURLToPath } from "node:url";

const LIB_URL = new URL("../src/lib/reasoning-presets.ts", import.meta.url).href;
const {
  REASONING_PRESETS,
  REASONING_CUSTOM_KEY,
  findReasoningPreset,
  matchReasoningPreset,
  suggestReasoningPreset,
} = await import(LIB_URL);

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

/* ① 预设表自身一致性 */
console.log("\n[1] 预设表自身一致性");
check("预设数量 ≥ 4（off / 安全缺省 / 至少两种真实传参）", REASONING_PRESETS.length >= 4);
check("key 唯一", new Set(REASONING_PRESETS.map((p) => p.key)).size === REASONING_PRESETS.length);
check("label 唯一", new Set(REASONING_PRESETS.map((p) => p.label)).size === REASONING_PRESETS.length);
check("custom 不在预设表里（由界面单独处理）", !REASONING_PRESETS.some((p) => p.key === REASONING_CUSTOM_KEY));
check(
  "每个预设都有非空 hint（界面直接展示，空 hint 会让管理员不知道该不该选）",
  REASONING_PRESETS.every((p) => p.hint.trim().length > 0),
);
check(
  "每个预设的 map 都是非空字符串（空串会被服务端按缺省 \"{}\" 兜，但显式写清更不易误读）",
  REASONING_PRESETS.every((p) => typeof p.map === "string" && p.map.trim().length > 0),
);
check(
  "levels 里不允许重复值（桌面端按集合展示，重复会让下拉出现两个相同选项）",
  REASONING_PRESETS.every((p) => new Set(p.levels).size === p.levels.length),
);

/* ② 反查闭环 */
console.log("\n[2] 反查闭环（levels+map → 预设 key）");
for (const preset of REASONING_PRESETS) {
  const back = matchReasoningPreset([...preset.levels], preset.map);
  check(`预设 ${preset.key} 可反查回自身`, back === preset.key, `实际反查到 ${back}`);
}
check("null levels + null map 反查到 off（服务端未配置时的形态）", matchReasoningPreset(null, null) === "off");
check(
  "非标准组合落 custom",
  matchReasoningPreset(["a", "b"], '{"foo": 1}') === REASONING_CUSTOM_KEY,
);

/* ③ 按模型特征推断 */
console.log("\n[3] 按模型特征推断");
const inferCases = [
  // [模型 id, 期望 preset, 说明]
  ["glm-4.6", "thinking-bool", "智谱 GLM：thinking 是对象"],
  ["glm-4.5-air", "thinking-bool", "GLM 家族"],
  ["zhipu/glm-4-plus", "thinking-bool", "带 zhipu 前缀"],
  ["qwen-max", "enable-thinking", "通义千问：enable_thinking 布尔"],
  ["qwq-32b", "enable-thinking", "QwQ 推理系"],
  ["o1", "effort", "OpenAI o 系列"],
  ["o4-mini", "effort", "o4-mini（不带尾边界的匹配）"],
  ["deepseek-reasoner", "effort", "命名带 reasoner"],
  ["some-vendor/thinking-model", "effort", "命名带 thinking"],
];
for (const [model, expected, why] of inferCases) {
  const got = suggestReasoningPreset({ model });
  check(`${model} → ${expected}（${why}）`, got === expected, `实际 ${got}`);
}
check(
  "完全陌生的模型落安全缺省 toggle-only（不瞎猜参数名）",
  suggestReasoningPreset({ model: "acme/unknown-9b" }) === "toggle-only",
);
check(
  "空 displayName 不导致崩溃",
  suggestReasoningPreset({ model: "x", displayName: null }) === "toggle-only",
);

/* ④ 已配置过的反查 */
console.log("\n[4] 已配置过的模型：反查而非重新推断");
const effortPreset = findReasoningPreset("effort");
check(
  "配成 effort 预设的模型，打开表单仍显示 effort",
  suggestReasoningPreset({
    model: "acme/unknown-9b",
    reasoningLevels: effortPreset.levels,
    reasoningMap: effortPreset.map,
  }) === "effort",
);
check(
  "配成非标准写法的模型落 custom（保留原值，绝不静默改写）",
  suggestReasoningPreset({ model: "x", reasoningLevels: ["weird"], reasoningMap: '{"zzz": 1}' }) ===
    REASONING_CUSTOM_KEY,
);
check(
  "levels 配了但 map 缺省 \"{}\" → 命中 toggle-only（这是最常见的手配形态）",
  suggestReasoningPreset({ model: "x", reasoningLevels: ["disabled", "enabled"], reasoningMap: "{}" }) ===
    "toggle-only",
);

/* ⑤ 安全断言：disabled 档不许写字段 */
console.log("\n[5] 安全断言：disabled 档不往请求体写字段");
for (const preset of REASONING_PRESETS) {
  if (preset.key === "off") continue;
  if (!preset.levels.includes("disabled")) continue;
  /*
   * 用一个廉价的形态检查代替真跑 CEL：disabled 分支必须返回空对象 `{}`。
   * 凡是写成 `? {"..."}` 的都在 disabled 时写入字段 —— 那正是要防的。
   */
  const disabledBranch = preset.map.split("?")[1]?.split(":")[0]?.trim() ?? "";
  check(
    `预设 ${preset.key} 在 disabled 档返回 {}`,
    disabledBranch === "{}" || disabledBranch === "",
    `disabled 分支实际是 "${disabledBranch}"`,
  );
}
check("off 预设 levels 为空（桌面端不展示思考档位）", findReasoningPreset("off").levels.length === 0);

console.log(
  failed === 0
    ? `\n全部通过（${REASONING_PRESETS.length} 个预设）\n`
    : `\n${failed} 项失败\n`,
);
process.exit(failed === 0 ? 0 : 1);
