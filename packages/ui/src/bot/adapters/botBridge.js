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
  providers: () => botStore.providers(),
  "efforts": () => botStore.efforts(),
  "run-stats": (payload) => botStore.runStats(payload),
  usage: (payload) => botStore.usage(payload),
  folders: () => botStore.folders(),
  "folder-list": () => botStore.folderList(),
  "folder-pick": (payload) => botStore.folderPick(payload),
  schedules: () => botStore.schedules(),
  "schedule-create": (payload) => botStore.scheduleCreate(payload),
  "schedule-delete": (payload) => botStore.scheduleDelete(payload),
  diagnostics: () => botStore.diagnostics(),
  "diagnostics-log": () => botStore.diagnosticsLog(),
  "diagnostics-clear": () => botStore.diagnosticsClear(),
  "repo-stars": () => botStore.repoStars(),
  "stop-member-work": (payload) => botStore.stopWork(payload),
  "stop-room-work": (payload) => botStore.stopWork(payload),
  thinking: (payload) => botStore.thinking(payload),
  "set-flags": (payload) => botStore.setFlags(payload),
  resume: (payload) => botStore.resume(payload),
  "bot-open-part": (payload) => botStore.botOpenPart(payload),
  "side-new": (payload) => botStore.sideNew(payload),
  "side-ask": (payload) => botStore.sideAsk(payload),
  "side-close": () => botStore.sideClose(),
  "side-cancel": () => botStore.sideCancel(),
  "room-progress": (payload) => botStore.roomProgress(payload),
  "team-workspace": () => botStore.teamWorkspace(),
  "set-flags-team": (payload) => botStore.setTeamWorkspace(payload),
  "approval-answer": (payload) => botStore.approvalAnswer(payload),
  "answer-question": (payload) => botStore.answerQuestion(payload),
  "dismiss-question": (payload) => botStore.dismissQuestion(payload),
  "dismiss-view": (payload) => botStore.dismissView(payload),
  "bot-new-part": (payload) => botStore.botNewPart(payload),
  earlier: (payload) => botStore.earlier(payload),
  "avatar-library": () => botStore.avatarLibrary(),
  "avatar-import": (payload) => botStore.avatarImport(payload),
  "avatar-delete": (payload) => botStore.avatarDelete(payload),
  "duplicate-bot": (payload) => botStore.duplicateBot(payload),
  "private-release": (payload) => botStore.privateRelease(payload),
};

/**
 * 桌面版专属端点：Reactor 是 Web 宿主，这些能力天然不存在。
 *
 * 为什么要显式列出而不是让它落到 `unsupported`：这些端点里有相当一部分在上游
 * 是被「点击即调」的（停止 Computer use、断开连接器、删除密钥……）。统一抛
 * `bot/unsupported` 的后果是 `undefined is not a function` 之外的另一种崩法——
 * 页面红字。这里给「可读的拒绝」，用户看到的是「该功能在 Web 版不可用」。
 *
 * 分成三组：
 * - 桌面能力（computer / connector / im / mail / local-agent / secret / capability）
 * - 宿主更新（update / dsh-update）
 * - 未接入的次要功能（exchange-text / file-text / view-reply / learning / goal / memory
 *   的写操作）
 */
const WEB_UNAVAILABLE = new Set([
  // Computer use
  'computer-set-enabled', 'computer-set-level', 'computer-revoke-app', 'computer-provider-retry',
  'computer-system-status', 'computer-permission', 'computer-stop', 'computer-takeover',
  'computer-handback', 'computer-allow-foreground', 'computer-app-answer', 'computer-hold-answer',
  'computer-shot', 'computer-user-active', 'computer-cursor-wait',
  // Connectors / IM / Mail / Local agents / Secrets / Capabilities
  'connector-add', 'connector-cancel', 'connector-client', 'connector-connect', 'connector-disconnect',
  'connector-import', 'connector-import-scan', 'connector-remove', 'connector-request-cancel',
  'connector-retry', 'connector-set', 'connector-sign-in-code',
  'im-add', 'im-chat', 'im-login-start', 'im-login-wait', 'im-pair', 'im-remove', 'im-retry',
  'im-unpair', 'im-update',
  'mail-account-add', 'mail-account-remove', 'mail-rule-set', 'mail-send-answer', 'mail-sign-in-code',
  'local-agent-add', 'local-agent-models', 'local-agent-remove', 'local-agent-update',
  'secret-allow', 'secret-cancel', 'secret-delete', 'secret-set', 'secret-update',
  'capability-approve', 'capability-delete', 'capability-save', 'bot-capability',
  // 宿主更新
  'update-check', 'update-install', 'dsh-update-install',
  // 尚未接入的次要功能
  'exchange', 'exchange-text', 'file-text', 'view-reply', 'learning-answer',
  'goal-control', 'goal-draft', 'memory-ask', 'memory-forget', 'memory-history', 'memory-layer',
  'memory-move', 'memory-pin', 'memory-restore', 'memory-tidy-undo', 'memory-view',
  'add-agent', 'remove-agent', 'agent-adopt', 'agent-archive', 'agent-rename', 'agent-session',
  'provider-add', 'provider-key', 'provider-models', 'provider-remove',
  'browser-give-back', 'browser-stop', 'browser-takeover', 'btw-delete',
  'abandon-work', 'goal-draft', 'room-progress',
]);

/** 友好的不可用提示（上游会把它当 refusals 展示给用户）。 */
const WEB_UNAVAILABLE_MESSAGE = '该功能只在桌面版提供，Web 版暂不可用。';

/** 上游的 call 契约：成功返回值本身，失败抛带 code 的 Error。 */
export async function call(endpoint, payload, signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const handler = ENDPOINTS[endpoint];
  if (!handler) {
    if (WEB_UNAVAILABLE.has(endpoint)) {
      throw new BotCallError(WEB_UNAVAILABLE_MESSAGE, "bot/refused");
    }
    throw unsupported(endpoint);
  }
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
