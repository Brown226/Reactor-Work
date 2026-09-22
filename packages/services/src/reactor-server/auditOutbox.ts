/**
 * 用量上报的 outbox（落盘队列）。
 *
 * 语义继承原项目 Reactor-Destop 的 outbox/peek/ack，实现独立：**peek 不删 → 上报 → 全批 ack**，
 * 上报成功但 ack 前崩溃，重发由服务端的 `eventId` 幂等判重兜住——所以 ack 只按 ID 删，
 * 不依赖批次顺序。
 *
 * 所有权：**Host 单一写入者**（多窗口、手机远控共用同一个 Host；Renderer 不直接 POST、也不写这个文件）。
 * 因此这里不做跨进程文件锁：并发写是设计外的用法。文件路径由调用方给出
 * （生产用 `resolveAuditOutboxPath()`，测试给临时目录）。
 *
 * 落盘格式：JSONL（一行一条事件）。追加与 ack 都走"整文件原子重写"——量大不了
 * （上限 `AUDIT_OUTBOX_MAX_EVENTS`），换来崩溃后文件永远是可解析的完整行。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AUDIT_OUTBOX_MAX_EVENTS, type AuditEventInput } from "./auditContract.js";

export interface AuditOutbox {
  /** 入队（按 eventId 去重；超上限丢最旧）。 */
  append(events: readonly AuditEventInput[]): Promise<void>;
  /** 读一批但**不删**。 */
  peek(limit: number): Promise<AuditEventInput[]>;
  /** 确认已处理（accepted/duplicates/rejected 都算已处理）。 */
  ack(eventIds: readonly string[]): Promise<void>;
  /** 当前积压条数（日志/探针用）。 */
  size(): Promise<number>;
}

function parseLines(raw: string): AuditEventInput[] {
  const events: AuditEventInput[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AuditEventInput;
      if (parsed && typeof parsed.eventId === "string" && parsed.eventId.length > 0) {
        events.push(parsed);
      }
    } catch {
      // 半行/脏行只可能是外部改坏：跳过它，不让整份队列报废。
    }
  }
  return events;
}

export function createAuditOutbox(options: { filePath: string }): AuditOutbox {
  const { filePath } = options;
  let loaded = false;
  let events: AuditEventInput[] = [];
  let ids = new Set<string>();

  const load = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await readFile(filePath, "utf8");
      events = parseLines(raw);
      ids = new Set(events.map((event) => event.eventId));
    } catch {
      // 文件不存在 = 首次运行。
      events = [];
      ids = new Set();
    }
  };

  const flush = async (): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    const body = events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(tempPath, body.length > 0 ? `${body}\n` : "", "utf8");
    // rename 在同一目录内是原子的：读者要么看到旧文件，要么看到新文件。
    await rename(tempPath, filePath);
  };

  return {
    async append(incoming) {
      if (incoming.length === 0) return;
      await load();
      let changed = false;
      for (const event of incoming) {
        if (ids.has(event.eventId)) continue;
        events.push(event);
        ids.add(event.eventId);
        changed = true;
      }
      if (!changed) return;

      if (events.length > AUDIT_OUTBOX_MAX_EVENTS) {
        const overflow = events.length - AUDIT_OUTBOX_MAX_EVENTS;
        const dropped = events.splice(0, overflow);
        for (const event of dropped) ids.delete(event.eventId);
      }
      await flush();
    },

    async peek(limit) {
      await load();
      if (limit <= 0) return [];
      return events.slice(0, limit);
    },

    async ack(eventIds) {
      if (eventIds.length === 0) return;
      await load();
      const acked = new Set(eventIds);
      const remaining = events.filter((event) => !acked.has(event.eventId));
      if (remaining.length === events.length) return;
      events = remaining;
      ids = new Set(events.map((event) => event.eventId));
      await flush();
    },

    async size() {
      await load();
      return events.length;
    },
  };
}
