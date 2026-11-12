/**
 * 协议转换冒烟（h）：验证 gateway/protocol-convert 的 Anthropic ↔ OpenAI 请求体映射。
 *
 * 用 node 直接跑（无需 DB/网络）：
 *   cd server && node packages/server/scripts/protocol-convert-smoke.mjs
 *
 * 先 `pnpm --filter @reactor/server build` 或直接从 src 走 tsx 也可；
 * 这里 import 编译产物 dist（与其它 smoke 脚本一致口径）。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, "../dist/gateway/protocol-convert.js");

if (!existsSync(distPath)) {
  console.error(`[protocol-convert-smoke] 未找到编译产物：${distPath}\n请先执行 cd server && pnpm --filter @reactor/server build`);
  process.exit(2);
}

const {
  anthropicToOpenAIChat,
  openAIChatToAnthropic,
  needsConversion,
  convertRequestBody,
} = await import(`file://${distPath}`);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("[protocol-convert-smoke] Anthropic → OpenAI");

check("基础字段映射：model/max_tokens/temperature/stream", () => {
  const out = anthropicToOpenAIChat({
    model: "m1",
    max_tokens: 128,
    temperature: 0.5,
    stream: true,
    stop_sequences: ["END"],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.model, "m1");
  assert.equal(out.max_tokens, 128);
  assert.equal(out.temperature, 0.5);
  assert.equal(out.stream, true);
  assert.deepEqual(out.stop, ["END"]);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, "user");
  assert.equal(out.messages[0].content, "hi");
});

check("system 字符串 → role:system 消息置顶", () => {
  const out = anthropicToOpenAIChat({
    system: "you are helpful",
    messages: [{ role: "user", content: "q" }],
  });
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content, "you are helpful");
  assert.equal(out.messages[1].role, "user");
});

check("图片 base64 源 → image_url data URL", () => {
  const out = anthropicToOpenAIChat({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ],
  });
  const parts = out.messages[0].content;
  assert.ok(Array.isArray(parts));
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, "data:image/png;base64,AAAA");
});

check("tool_use → assistant.tool_calls；tool_result → role:tool", () => {
  const out = anthropicToOpenAIChat({
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "get_time", input: { tz: "UTC" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "12:00" }],
      },
    ],
  });
  const assistant = out.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.tool_calls[0].id, "t1");
  assert.equal(assistant.tool_calls[0].function.name, "get_time");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { tz: "UTC" });
  const tool = out.messages.find((m) => m.role === "tool");
  assert.equal(tool.tool_call_id, "t1");
  assert.equal(tool.content, "12:00");
});

check("tools 定义 → function 形态", () => {
  const out = anthropicToOpenAIChat({
    messages: [{ role: "user", content: "x" }],
    tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
  });
  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tools[0].function.name, "f");
  assert.deepEqual(out.tools[0].function.parameters, { type: "object" });
});

console.log("[protocol-convert-smoke] OpenAI → Anthropic");

check("system 消息 → 顶层 system 字段", () => {
  const out = openAIChatToAnthropic({
    model: "m",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(out.system, "sys");
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, "user");
  assert.deepEqual(out.messages[0].content, [{ type: "text", text: "hi" }]);
});

check("max_tokens 缺省时补保守默认值", () => {
  const out = openAIChatToAnthropic({ messages: [{ role: "user", content: "x" }] });
  assert.equal(out.max_tokens, 4096);
});

check("max_completion_tokens 视为 max_tokens", () => {
  const out = openAIChatToAnthropic({ max_completion_tokens: 77, messages: [] });
  assert.equal(out.max_tokens, 77);
});

check("assistant.tool_calls → tool_use 块；role:tool → user.tool_result", () => {
  const out = openAIChatToAnthropic({
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "fn", arguments: '{"a":1}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
  });
  const assistant = out.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.content[0].type, "tool_use");
  assert.equal(assistant.content[0].name, "fn");
  assert.deepEqual(assistant.content[0].input, { a: 1 });
  const userMsg = out.messages.find((m) => m.role === "user");
  assert.equal(userMsg.content[0].type, "tool_result");
  assert.equal(userMsg.content[0].tool_use_id, "c1");
});

check("image_url data URL → Anthropic base64 源", () => {
  const out = openAIChatToAnthropic({
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,ZZZ" } }],
      },
    ],
  });
  const block = out.messages[0].content[0];
  assert.equal(block.type, "image");
  assert.equal(block.source.type, "base64");
  assert.equal(block.source.media_type, "image/jpeg");
  assert.equal(block.source.data, "ZZZ");
});

console.log("[protocol-convert-smoke] 派发判定");

check("needsConversion：auto/同形不转，跨对话协议才转", () => {
  assert.equal(needsConversion("auto", "openai-chat"), false);
  assert.equal(needsConversion("openai-chat", "openai-chat"), false);
  assert.equal(needsConversion("anthropic-messages", "openai-chat"), true);
  assert.equal(needsConversion("openai-chat", "anthropic-messages"), true);
  assert.equal(needsConversion("openai-responses", "openai-chat"), false);
  assert.equal(needsConversion("google-generative-ai", "anthropic-messages"), false);
});

check("convertRequestBody：同形原样返回，跨形转换", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
  assert.equal(convertRequestBody(body, "openai-chat", "openai-chat"), body);
  const converted = convertRequestBody(body, "openai-chat", "anthropic-messages");
  assert.equal(converted.messages[0].content[0].type, "text");
});

console.log(`\n[protocol-convert-smoke] 全部通过：${passed} 项`);
