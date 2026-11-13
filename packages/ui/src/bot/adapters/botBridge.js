/**
 * [本地定制] DS-Bot 视图 ↔ Reactor 的桥接层。
 *
 * 上游 DS-Bot 是 dsh 插件：视图通过 `POST api/bot { endpoint, payload }` 调插件，
 * 通过 `GET api/bot/feed`（SSE）拿实时事件。Reactor 没有这条 HTTP 路由，也不需要
 * 造一条——视图和宿主都在同一个浏览器进程里，直接派发到本地处理器即可。
 *
 * 这个文件就是上游 `ds-bot/src/client/api.js` 的 Reactor 版本：
 * - `call(endpoint, payload)` → 查表派发，抛错形状与上游一致（带 `code`）。
 * - `openFeed(onEvent)` → 订阅 Reactor 的广播，形状与 SSE 的 (event, data) 一致。
 *
 * 端点覆盖进度记录在 `ENDPOINTS` 的 `implemented` 标记上：未实现的端点返回
 * `bot/unsupported`，视图会把它当可读的拒绝消息展示，不会白屏。
 */
import { botStore } from "./botStore.js";

const REFUSALS = new Set(["bot/refused", "bot/invalid", "bot/read-only", "bot/not-found"]);

export class BotCallError extends Error {
  constructor(message, code = "bot/error") {
    super(message);
    this.name = "BotCallError";
    this.code = code;
  }
  /** 上游用这个判断「消息可以直接给用户看」。 */
  get isRefusal() {
    return REFUSALS.has(this.code);
  }
}

const unsupported = (endpoint) =>
  new BotCallError(`Reactor 暂未实现 ${endpoint}`, "bot/unsupported");

/* ------------------------------------------------------------------ *
 * 端点表
 * ------------------------------------------------------------------ */

const ENDPOINTS = {
  state: () => botStore.readState(),
  chat: (payload) => botStore.readChat(payload),
  send: (payload) => botStore.send(payload),
  "create-bot": (payload) => botStore.createBot(payload),
  "update-bot": (payload) => botStore.updateBot(payload),
  "delete-bot": (payload) => botStore.deleteBot(payload),
  "set-main": (payload) => botStore.setMain(payload),
  "set-prefs": (payload) => botStore.setPrefs(payload),
  "create-room": (payload) => botStore.createRoom(payload),
  "update-room": (payload) => botStore.updateRoom(payload),
  "delete-room": (payload) => botStore.deleteRoom(payload),
  "section-save": (payload) => botStore.saveSection(payload),
  "section-order": (payload) => botStore.orderSections(payload),
  "section-delete": (payload) => botStore.deleteSection(payload),
  "models": () => botStore.models(),
  "efforts": () => botStore.efforts(),
  "run-stats": (payload) => botStore.runStats(payload),
  "usage": (payload) => botStore.usage(payload),
};

/** 上游的 call 契约：成功返回值本身，失败抛带 code 的 Error。 */
export async function call(endpoint, payload, signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const handler = ENDPOINTS[endpoint];
  if (!handler) throw unsupported(endpoint);
  try {
    return await handler(payload ?? null);
  } catch (error) {
    if (error instanceof BotCallError) throw error;
    throw new BotCallError(
      error instanceof Error ? error.message : String(error),
      error?.code ?? "bot/internal",
    );
  }
}

/* ------------------------------------------------------------------ *
 * 实时事件
 * ------------------------------------------------------------------ */

/**
 * 订阅实时事件。上游的 `openFeed(onEvent)` 返回取消函数，事件名有：
 * `hello`（重连后让视图重新拉取）、`message`（新消息）、`stream`（回复流式片段）、
 * `lost`（断线）。这里把 Reactor 的 store 变更映射成同样的形状。
 */
export function openFeed(onEvent) {
  // 首帧：告诉视图可以按 `hello` 处理，与上游 SSE 的第一条事件一致。
  queueMicrotask(() => onEvent("hello", {}));
  const unsubscribe = botStore.subscribe((event, data) => onEvent(event, data));
  return () => unsubscribe();
}
