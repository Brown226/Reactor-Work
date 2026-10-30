/**
 * 模型能力自动检测自检（2026-10-22）
 *
 * 验证两件事：
 *   ① 名字推断（离线）：能确认家族的模型给出正确能力，**未知别名必须给空**（保守原则）；
 *   ② 真实探测（--live）：带 tools 的极小请求能否被上游正确判为「支持 / 拒绝 / 无法判定」。
 *
 * 为什么需要②：探测的判定逻辑依赖真实上游的响应形状（200 / 4xx 报文），
 * 光靠类型和单测证明不了「它真的能区分」。
 *
 * 用法：
 *   node packages/server/scripts/verify-model-capabilities.mjs
 *   node packages/server/scripts/verify-model-capabilities.mjs --live
 *   REACTOR_PROBE_BASE_URL=http://10.0.0.9:3425/v1 REACTOR_PROBE_MODEL=auto/dfmodel node ... --live
 *
 * 退出码：0 = 全部断言通过；1 = 有断言失败。
 */

const mod = await import(new URL("../dist/gateway/model-capabilities.js", import.meta.url).href);
const { inferFeatures, probeToolsSupport } = mod;

let failed = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      期望 ${e}\n      实际 ${a}`);
};

console.log("=== ① 名字推断（离线）===");

/** 能确认家族：应当给出能力 */
check("deepseek-v4.1-flash（带 vendor 前缀）", inferFeatures("workbuddy/deepseek-v4.1-flash").features, [
  "tools",
  "reasoning",
]);
check("qwen3-vl-8b（含 vl 修饰词）", inferFeatures("codex/qwen3-vl-8b").features, ["tools", "reasoning", "vision"]);
// anthropic 是协议标记，不是模型能力（2026-10-29 移出能力集合）
check("claude（不含协议标记）", inferFeatures("claude-sonnet-4").features, ["tools", "reasoning", "vision"]);
check("glm（不含协议标记）", inferFeatures("glm-4.6").features, ["tools", "reasoning"]);
check(
  "任何家族都不产出 anthropic",
  ["claude-sonnet-4", "glm-4.6", "deepseek-v4-pro", "qwen3-max"].some((m) =>
    inferFeatures(m).features.includes("anthropic"),
  ),
  false,
);
check("minimax 大小写混合", inferFeatures("minimax-code/MiniMax-M3.1-Flash").features, ["tools", "reasoning"]);

/** 保守原则：未知别名必须给空，绝不猜 tools */
check("auto/dfmodel（平台别名）", inferFeatures("auto/dfmodel").features, []);
check("group/never-stuck（平台别名）", inferFeatures("group/never-stuck").features, []);
check("auto/dfmodel 的置信度", inferFeatures("auto/dfmodel").confidence, "none");

/** 非对话模型：即使名字里有 qwen/vl 也不能标能力 */
check("qwen3-vl-embedding-8b（向量模型）", inferFeatures("qwen3-vl-embedding-8b").features, []);
check("bge-reranker（重排模型）", inferFeatures("bge-reranker-v2").features, []);

if (process.argv.includes("--live")) {
  const base = (process.env.REACTOR_PROBE_BASE_URL ?? "http://127.0.0.1:3425/v1").replace(/\/+$/, "");
  const model = process.env.REACTOR_PROBE_MODEL ?? "auto/dfmodel";
  const apiKey = process.env.REACTOR_PROBE_API_KEY ?? "magpie";
  console.log(`\n=== ② 真实探测（live）：${base} · ${model} ===`);

  const r = await probeToolsSupport({
    url: `${base}/chat/completions`,
    headers: { authorization: `Bearer ${apiKey}` },
    model,
  });
  console.log(`  结论 tools = ${r.tools} · HTTP ${r.httpStatus ?? "-"} · ${r.detail}`);

  // 不断言 true/false（取决于上游实际能力），只断言「拿到了一个有意义的判定且不崩溃」
  if (r.tools === null) {
    console.log("  提示：无法判定（上游不可达或错误与 tools 无关），未写库 —— 这是允许的结果");
  }
  check("探测返回了可读结论", typeof r.detail === "string" && r.detail.length > 0, true);
}

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
