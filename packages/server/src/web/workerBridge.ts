import WebSocket from "ws";
import type { WSContext } from "hono/ws";
import type { WebWorkerHandle } from "./workerRegistry.js";

const MAX_PENDING_BYTES = 4 * 1024 * 1024;

export interface WorkerWsBridge {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/**
 * 浏览器 WS ↔ 该 uid worker 的 `/ws` 透明桥。
 *
 * worker 只监听 127.0.0.1 且带一次性 token；浏览器只看到网关的 `/ws`，
 * 不会接触 worker 端口或 token。浏览器消息在 worker 连接建立前短暂缓冲，
 * 超过 4MB 直接关闭，避免慢 worker 把网关内存吃光。
 */
export function createWorkerWsBridge(
  browser: WSContext,
  worker: WebWorkerHandle,
): WorkerWsBridge {
  let target: WebSocket | null = null;
  let closed = false;
  let targetOpen = false;
  let pendingBytes = 0;
  const pending: Array<string | ArrayBuffer | Uint8Array> = [];

  const connect = (): void => {
    target = new WebSocket(
      `ws://127.0.0.1:${worker.port}/ws?token=${encodeURIComponent(worker.token)}`,
      { perMessageDeflate: false },
    );
    target.on("open", () => {
      targetOpen = true;
      for (const data of pending) target?.send(data);
      pending.length = 0;
      pendingBytes = 0;
    });
    target.on("message", (data, isBinary) => {
      if (closed) return;
      const payload = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : new Uint8Array(data as ArrayBuffer);
      browser.send(isBinary ? Uint8Array.from(payload) : payload.toString("utf8"));
    });
    target.on("close", (code, reason) => {
      if (closed) return;
      closed = true;
      // 1005/1006 是保留状态码，不能由应用主动发送；对浏览器统一收口成 1011。
      const safeCode = code === 1005 || code === 1006 ? 1011 : code;
      browser.close(safeCode, reason.toString());
    });
    target.on("error", () => {
      if (closed) return;
      closed = true;
      browser.close(1011, "worker connection failed");
    });
  };

  connect();

  return {
    send(data) {
      if (closed) return;
      if (targetOpen && target) {
        target.send(data);
        return;
      }
      const size =
        typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      if (pendingBytes + size > MAX_PENDING_BYTES) {
        closed = true;
        pending.length = 0;
        target?.close();
        browser.close(1013, "worker backlog");
        return;
      }
      pending.push(data);
      pendingBytes += size;
    },
    close(code, reason) {
      if (closed) return;
      closed = true;
      pending.length = 0;
      target?.close(code, reason);
    },
  };
}
