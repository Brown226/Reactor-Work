/**
 * 网关用量捕获（额度分配 P1b）：从上游回执提取 usage → 落计量账本。
 *
 * ## 为什么在网关侧做（而不是只靠端侧上报）
 *
 * 端侧 `POST /desktop/audit/batch` 是「自愿上报」：旁路、改码、进程崩溃都会让用量凭空消失。
 * 网关是**调用的唯一出口**（BRD M10-01），它看到的 usage 是上游回执的原始事实 ——
 * 这是账本（`usage_ledger`）的权威来源，端侧上报退居对账口径。
 *
 * ## 三个必须守住的点
 *
 * ① **口径与端侧一致**（否则两套数永远对不上、成本算重）：
 *    · Anthropic：`input_tokens` 是**非缓存**输入，`cache_read_input_tokens` /
 *      `cache_creation_input_tokens` 单列 ⇒ 直接映射四段。
 *    · OpenAI：`prompt_tokens` **含**缓存命中（`prompt_tokens_details.cached_tokens`），
 *      而端侧（AI SDK）与 Anthropic 形态的 `input` 都是非缓存部分 ⇒ 必须**减去**缓存，
 *      否则缓存读会被按正价重复计一遍（缓存价远低于正价，属于高估消耗）。
 * ② **不阻塞转发**：流式用**顺路解析**（pull 时喂给累加器再 enqueue），不做 `tee()` ——
 *    tee 的两个分支各自缓冲，客户端读得慢就会把已计量数据堆在另一支的内存队列里。
 *    解析失败只丢该条计量并记日志，绝不影响回执。
 * ③ **失败降级**：账本表未建（identity 尚未完成建表批，见方案 §6 启动竞态）或连接失败时
 *    进入 degraded，模型调用照常，恢复后自动回正常 —— 记账是旁路，不是链路。
 */

import { randomUUID } from "node:crypto";

import { computeCost, effectiveRates, hasBillableTokens, type ModelPricing } from "../common/pricing.js";
import type { IdentityDb } from "../identity/db.js";
import { recordUsage, type LedgerOutcome, type UsageLedgerEntry } from "../metering/repo.js";

/** 上游回执形态：决定 `usage` 字段怎么读。 */
export type UpstreamShape = "anthropic-messages" | "openai-chat" | "embeddings" | "rerank";

/** 一次调用捕获到的用量（四段 + 总；缺项为 null）。 */
export interface CapturedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** 非 null 项覆盖（`message_delta` 的 output 是累计值，覆盖而非累加）。 */
function mergeUsage(base: CapturedUsage | null, patch: Partial<CapturedUsage>): CapturedUsage {
  const merged: CapturedUsage = {
    inputTokens: patch.inputTokens ?? base?.inputTokens ?? null,
    outputTokens: patch.outputTokens ?? base?.outputTokens ?? null,
    cacheReadTokens: patch.cacheReadTokens ?? base?.cacheReadTokens ?? null,
    cacheWriteTokens: patch.cacheWriteTokens ?? base?.cacheWriteTokens ?? null,
    totalTokens: patch.totalTokens ?? base?.totalTokens ?? null,
  };
  return merged;
}

/** 四段之和（Anthropic 不返回 total，端侧 AI SDK 也是这么算的 —— 保持同口径）。 */
function sumOrNull(parts: Array<number | null>): number | null {
  const present = parts.filter((n): n is number => n !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

/** Anthropic 形态 usage（非流式回执与 SSE `message_start.message.usage` 同形）。 */
function usageFromAnthropic(raw: unknown): CapturedUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: sumOrNull([input, output, cacheRead, cacheWrite]),
  };
}

/** OpenAI 形态 usage（chat completions 与 embeddings 都是它）。 */
function usageFromOpenAI(raw: unknown): CapturedUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const total = num(u.total_tokens);
  const details = typeof u.prompt_tokens_details === "object" && u.prompt_tokens_details !== null
    ? (u.prompt_tokens_details as Record<string, unknown>)
    : undefined;
  const cached = num(details?.cached_tokens);
  if (prompt === null && completion === null && total === null && cached === null) return null;
  // ★ 口径对齐：prompt_tokens 含缓存 ⇒ input = prompt - cached（见文件头 ①）
  const input = prompt === null ? null : Math.max(0, prompt - (cached ?? 0));
  return {
    inputTokens: input,
    outputTokens: completion,
    cacheReadTokens: cached,
    cacheWriteTokens: null,
    totalTokens: total ?? sumOrNull([input, completion, cached]),
  };
}

/**
 * embeddings：OpenAI 兼容形态（只有 prompt_tokens，无输出）。
 *
 * ★ 同样要走「减缓存」口径：`prompt_tokens_details.cached_tokens` 在支持 prompt caching
 * 的上游（OpenAI 新版、部分代理）会出现，而 KB 向量化是**最典型的缓存命中考前场景** ——
 * 不减的话组织额度与费用会按正价重复计一遍缓存。与 chat 路径共用同一份分母口径。
 */
function usageFromEmbeddings(raw: unknown): CapturedUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens);
  const total = num(u.total_tokens) ?? prompt;
  const details = typeof u.prompt_tokens_details === "object" && u.prompt_tokens_details !== null
    ? (u.prompt_tokens_details as Record<string, unknown>)
    : undefined;
  const cached = num(details?.cached_tokens);
  if (prompt === null && total === null) return null;
  const input = prompt === null ? null : Math.max(0, prompt - (cached ?? 0));
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: cached,
    cacheWriteTokens: null,
    totalTokens: total,
  };
}

/** rerank：各家字段不一（Cohere `usage`、Jina 无、部分上游给 `total_tokens`）——宽松取。 */
function usageFromRerank(raw: unknown): CapturedUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const total = num(u.total_tokens) ?? num(u.prompt_tokens) ?? num(u.input_tokens);
  if (total === null) return null;
  return {
    inputTokens: num(u.prompt_tokens) ?? num(u.input_tokens) ?? total,
    outputTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: total,
  };
}

/** 从**非流式回执**提取（无 usage 字段 → null）。 */
export function extractUsage(shape: UpstreamShape, body: unknown): CapturedUsage | null {
  const raw = typeof body === "object" && body !== null ? (body as Record<string, unknown>).usage : undefined;
  switch (shape) {
    case "anthropic-messages":
      return usageFromAnthropic(raw);
    case "openai-chat":
      return usageFromOpenAI(raw);
    case "embeddings":
      return usageFromEmbeddings(raw);
    case "rerank":
      return usageFromRerank(raw);
  }
}

/**
 * SSE 增量累加器（anthropic-messages / openai-chat 两形态）。
 *
 * 按 `\n\n` 切事件块：chunk 边界可能落在任意位置，必须自己缓冲；
 * `\r\n` 先归一化（否则某些上游的 CRLF 会让块永远切不开）。
 */
export class SseUsageAccumulator {
  private buffer = "";
  private usage: CapturedUsage | null = null;

  constructor(private readonly shape: Exclude<UpstreamShape, "embeddings" | "rerank">) {}

  push(chunk: string): void {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.consumeBlock(block);
    }
  }

  /** 流结束时的最终用量（可能为 null：上游没给 usage）。 */
  finish(): CapturedUsage | null {
    return this.usage;
  }

  private consumeBlock(block: string): void {
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      const trimmed = line.trimEnd();
      if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (data === "[DONE]") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return; // 残块/心跳：跳过（丢一条计量好过打断转发）
    }
    this.consumeEvent(json);
  }

  private consumeEvent(ev: unknown): void {
    if (typeof ev !== "object" || ev === null) return;
    const e = ev as Record<string, unknown>;
    if (this.shape === "anthropic-messages") {
      if (e.type === "message_start") {
        const msg = e.message as Record<string, unknown> | undefined;
        const u = usageFromAnthropic(msg?.usage);
        if (u) this.usage = mergeUsage(this.usage, u);
      } else if (e.type === "message_delta") {
        // message_delta.usage.output_tokens 是**累计**输出（覆盖，不累加）
        const out = num((e.usage as Record<string, unknown> | undefined)?.output_tokens);
        if (out !== null) this.usage = mergeUsage(this.usage, { outputTokens: out });
      }
      return;
    }
    const u = usageFromOpenAI(e.usage);
    if (u) this.usage = mergeUsage(this.usage, u);
  }
}

/**
 * 顺路解析的透传流：数据先喂累加器再 enqueue 给客户端（无二次缓冲、背压天然同步）。
 * `onEnd` 恰好调用一次（正常结束 ok / 读取异常或客户端取消 aborted）。
 */
export function meteredStream(
  body: ReadableStream<Uint8Array> | null,
  accumulator: SseUsageAccumulator,
  onEnd: (usage: CapturedUsage | null, outcome: LedgerOutcome) => void,
): ReadableStream<Uint8Array> {
  let ended = false;
  const finish = (usage: CapturedUsage | null, outcome: LedgerOutcome): void => {
    if (ended) return;
    ended = true;
    onEnd(usage, outcome);
  };
  if (body === null) {
    finish(null, "error");
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish(accumulator.finish(), "ok");
          controller.close();
          return;
        }
        if (value) {
          try {
            accumulator.push(decoder.decode(value, { stream: true }));
          } catch {
            /* 解析失败不影响转发：这条计量记为无 usage */
          }
          controller.enqueue(value);
        }
      } catch (err) {
        finish(accumulator.finish(), "aborted");
        controller.error(err);
      }
    },
    cancel(reason) {
      finish(accumulator.finish(), "aborted");
      return reader.cancel(reason);
    },
  });
}

/* ---------------- 记账（含降级状态机） ---------------- */

export interface UsageRecorderStatus {
  /** disabled：未接库（env 单上游 / M0）⇒ 完全不记账；degraded：写库失败过；ok：正常 */
  state: "ok" | "degraded" | "disabled";
  /** degraded 时最近一次错误（供 /health 与排查） */
  lastError?: string;
}

export interface UsageRecorder {
  record(entry: UsageLedgerEntry): Promise<{ ok: boolean; inserted?: boolean; error?: string }>;
  /** 等待所有在途写入（冒烟/收尾用；线上不调用） */
  drain(): Promise<void>;
  status(): UsageRecorderStatus;
}

/**
 * 记账器：包装 `recordUsage`，遵守「失败降级不阻断」。
 *
 * 日志纪律（方案 §3.1）：进入/退出 degraded 记 info/error **各一次**，不逐条刷屏
 * （DB 长时间不可用时会连续失败，逐条 error 会把日志打爆且掩盖真正原因）。
 */
export function createUsageRecorder(opts: {
  db: IdentityDb | null;
  log?: (level: "info" | "error", message: string) => void;
}): UsageRecorder {
  const log = opts.log ?? ((level, message) => {
    if (level === "error") console.error(message);
    else console.log(message);
  });
  let degraded = false;
  let lastError: string | undefined;
  const pending = new Set<Promise<unknown>>();

  return {
    async record(entry) {
      const db = opts.db;
      if (!db) return { ok: true }; // 未接库：静默跳过（env/M0 形态零行为变化）
      const task = (async (): Promise<{ ok: boolean; inserted?: boolean; error?: string }> => {
        try {
          const r = await recordUsage(db, entry);
          if (degraded) {
            degraded = false;
            lastError = undefined;
            log("info", "[metering] 账本写入恢复（此前处于降级态）");
          }
          return { ok: true, inserted: r.inserted };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          lastError = message;
          if (!degraded) {
            degraded = true;
            log("error", `[metering] 账本写入失败，进入降级（模型调用不受影响）：${message}`);
          }
          return { ok: false, error: message };
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
      return task;
    },
    async drain() {
      await Promise.allSettled([...pending]);
    },
    status() {
      if (!opts.db) return { state: "disabled" };
      return degraded ? { state: "degraded", ...(lastError ? { lastError } : {}) } : { state: "ok" };
    },
  };
}

/* ---------------- 一次调用的计量上下文 ---------------- */

/** 记账所需的全部上下文（在 handler 里按本次调用组装）。 */
export interface MeterContext {
  requestId: string;
  principal: { kind: "user" | "dev"; sub?: string; deptId?: number | null };
  providerId: string;
  model: string | null;
  shape: UpstreamShape;
  pricing: ModelPricing | null;
  currency: string | null;
  /** 部门的库中最新值（快照口径与审计一致）；dev token 无主体时为 null */
  actorDept?: { deptId: number | null; deptPath: string | null } | null;
  startedAt: number;
}

/** 归属解析缓存的默认 TTL：部门调动不频繁，60s 足够且省掉每请求两次查询。 */
const ACTOR_CACHE_TTL_MS = 60_000;

export interface MeteringService {
  /** 生成一次调用的计量上下文（未接库时返回 null ⇒ 调用方按纯透传走） */
  begin(args: {
    principal: { kind: "user" | "dev"; sub?: string; deptId?: number | null };
    providerId: string;
    model: string | null;
    shape: UpstreamShape;
    pricing: ModelPricing | null;
    currency: string | null;
  }): MeterContext | null;
  /** 落账（非流式在返回前 await；流式在流结束后触发，不 await） */
  finish(meter: MeterContext, usage: CapturedUsage | null, outcome: LedgerOutcome, httpStatus: number | null): void;
  recorder: UsageRecorder;
}

/**
 * 计量服务：组装上下文 + 归属解析（带 TTL 缓存）+ 落账。
 *
 * `resolveActor` 注入是为了让本模块不直接依赖 identity/audit 的具体实现
 * （跨域导入最小化；装配处决定用谁）。
 */
export function createMeteringService(opts: {
  db: IdentityDb | null;
  resolveActor?: (db: IdentityDb, uid: string, fallbackDeptId: number | null) => Promise<{ deptId: number | null; deptPath: string | null }>;
  log?: (level: "info" | "error", message: string) => void;
}): MeteringService {
  const recorder = createUsageRecorder({ db: opts.db, ...(opts.log ? { log: opts.log } : {}) });
  const actorCache = new Map<string, { at: number; value: { deptId: number | null; deptPath: string | null } }>();

  const actorFor = async (
    uid: string,
    fallbackDeptId: number | null,
  ): Promise<{ deptId: number | null; deptPath: string | null } | null> => {
    if (!opts.resolveActor) return { deptId: fallbackDeptId, deptPath: null };
    const cached = actorCache.get(uid);
    const now = Date.now();
    if (cached && now - cached.at < ACTOR_CACHE_TTL_MS) return cached.value;
    try {
      const value = await opts.resolveActor(opts.db as IdentityDb, uid, fallbackDeptId);
      actorCache.set(uid, { at: now, value });
      return value;
    } catch {
      // 归属解析失败不阻断计量：回落令牌里的 deptId（deptPath 留空）
      return { deptId: fallbackDeptId, deptPath: null };
    }
  };

  return {
    begin(args) {
      if (!opts.db) return null;
      const startedAt = Date.now();
      const ctx: MeterContext = {
        requestId: randomUUID(),
        principal: args.principal,
        providerId: args.providerId,
        model: args.model,
        shape: args.shape,
        pricing: args.pricing,
        currency: args.currency,
        actorDept: null,
        startedAt,
      };
      // 归属异步解析（不阻塞转发路径）；未解析完成就落账时用令牌兜底
      if (args.principal.kind === "user" && args.principal.sub) {
        void actorFor(args.principal.sub, args.principal.deptId ?? null).then((v) => {
          ctx.actorDept = v;
        });
      }
      return ctx;
    },
    finish(meter, usage, outcome, httpStatus) {
      const isSystem = meter.principal.kind !== "user" || !meter.principal.sub;
      // Q5：dev token（无主体）记为系统调用 —— 计入组织额度、不进个人/部门额度
      const uid = isSystem ? systemSubjectFor(meter.shape) : (meter.principal.sub as string);
      const dept = isSystem ? { deptId: null, deptPath: null } : (meter.actorDept ?? { deptId: meter.principal.deptId ?? null, deptPath: null });

      const tokens = usage ?? {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: null,
      };
      const billable = hasBillableTokens(tokens);
      const rates = meter.pricing ? effectiveRates(meter.pricing) : null;
      const cost = rates && billable ? computeCost(tokens, rates) : null;
      const costSource: "server" | "none" | null = billable ? (cost !== null ? "server" : "none") : null;

      void recorder.record({
        requestId: meter.requestId,
        subjectKind: isSystem ? "system" : "user",
        uid,
        deptId: dept.deptId,
        deptPath: dept.deptPath,
        model: meter.model,
        provider: meter.providerId,
        apiShape: meter.shape,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        cacheWriteTokens: tokens.cacheWriteTokens,
        totalTokens: tokens.totalTokens,
        cost,
        costSource,
        currency: cost !== null ? (meter.currency ?? null) : null,
        pricingSnapshot: rates ?? undefined,
        outcome,
        httpStatus,
      });
    },
    recorder,
  };
}

/** 系统调用的主体标识（Q5：KB 向量化/重排是最典型的例子）。 */
function systemSubjectFor(shape: UpstreamShape): string {
  return shape === "embeddings" || shape === "rerank" ? "system:kb" : "system:dev";
}
