/**
 * [本地定制] DS-Bot 视图的宿主通信 —— Reactor 桥接。
 *
 * 上游同名文件（app/ui/src/api.js）用 fetch 打 `api/bot` + SSE 拉 `api/bot/feed`。
 * Reactor 里视图与宿主同进程，不需要 HTTP 这一跳：直接 re-export 桥接层实现，
 * 契约（call 的返回与抛错、openFeed 的 (event, data)）与上游完全一致。
 */
export { call, openFeed } from "../adapters/botBridge.js";
