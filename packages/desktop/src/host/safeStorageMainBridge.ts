import { HostMessageTypes, HostResponseTypes } from "@zcode/shared";
import type { CredentialSafeStorageAdapter } from "@zcode/services/node";

/**
 * safeStorage host↔main 代理桥。
 *
 * 为什么需要代理：Electron 的 utility process 只暴露 net / systemPreferences 两个
 * Electron 模块（Electron 41 源码 lib/utility/api/module-list.ts 实证），host 进程拿不到
 * safeStorage；而凭据 store 由 host 持有，加解密只能委托持有 OS 钥匙串的 main。
 * 明文经同机 parentPort（进程内 MessagePort）往返，不落盘不落网络，也不扩大受信
 * 边界 —— main 与 host 本就是同一桌面应用的进程组（v1 推导钥时代明文本就对同用户
 * 所有进程可见）。
 *
 * 仿 createBrowserControlMainBridge 的可注入设计：postToMain 由装配层提供、无全局
 * 状态，响应由 host/index.ts 的 parentPort.on("message") 分发进 handleResultMessage。
 */
export type SafeStorageOperation = "is-available" | "encrypt" | "decrypt";

export interface SafeStorageOperationResultMessage {
  type: typeof HostMessageTypes.SafeStorageOperationResult;
  requestId: string;
  ok: boolean;
  /** operation=is-available：main 的 isEncryptionAvailable() 结果。 */
  available?: boolean;
  /** operation=encrypt 的密文（base64url）或 decrypt 的明文。 */
  payload?: string;
  error?: string;
}

interface PendingEntry {
  resolve: (message: SafeStorageOperationResultMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 请求死线。main 内的 safeStorage 调用是同步 OS API，正常毫秒级返回；这里的
 * 超时只用于 parentPort 死锁/消息丢失时清理 pending 防泄漏 —— 超时一律 reject
 * 并放弃该请求（迟到响应被 handleResultMessage 忽略），不重试、不用超时值伪装成功。
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface SafeStorageMainBridgeDependencies {
  postToMain: (message: unknown) => void;
}

export interface SafeStorageMainBridge {
  /** 供 services 的 CredentialCipherProvider 使用的 safeStorage 能力（异步实现）。 */
  adapter: CredentialSafeStorageAdapter;
  /** host/index.ts 消息分发入口：把 main 的操作结果路由回 pending 请求。 */
  handleResultMessage: (message: SafeStorageOperationResultMessage) => void;
}

export function createSafeStorageMainBridge(
  dependencies: SafeStorageMainBridgeDependencies,
): SafeStorageMainBridge {
  const pending = new Map<string, PendingEntry>();
  let nextSeq = 0;

  const requestOperation = (input: {
    operation: SafeStorageOperation;
    plainText?: string;
    cipherText?: string;
  }): Promise<SafeStorageOperationResultMessage> => {
    const requestId = `safe-storage-${Date.now()}-${nextSeq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`safeStorage operation ${input.operation} timed out`));
      }, DEFAULT_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      try {
        dependencies.postToMain({
          type: HostResponseTypes.SafeStorageOperationRequest,
          requestId,
          ...input,
        });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const adapter: CredentialSafeStorageAdapter = {
    async isEncryptionAvailable(): Promise<boolean> {
      const result = await requestOperation({ operation: "is-available" });
      if (!result.ok) {
        throw new Error(result.error ?? "safeStorage is-available request failed");
      }
      return result.available === true;
    },

    async encryptString(plainText: string): Promise<Buffer> {
      const result = await requestOperation({ operation: "encrypt", plainText });
      if (!result.ok) {
        throw new Error(result.error ?? "safeStorage encrypt request failed");
      }
      if (result.payload === undefined) {
        throw new Error("safeStorage encrypt result missing payload");
      }
      return Buffer.from(result.payload, "base64url");
    },

    async decryptString(encrypted: Buffer): Promise<string> {
      const result = await requestOperation({
        operation: "decrypt",
        cipherText: encrypted.toString("base64url"),
      });
      if (!result.ok) {
        throw new Error(result.error ?? "safeStorage decrypt request failed");
      }
      if (result.payload === undefined) {
        throw new Error("safeStorage decrypt result missing payload");
      }
      return result.payload;
    },
  };

  return {
    adapter,
    handleResultMessage(message): void {
      const entry = pending.get(message.requestId);
      if (!entry) {
        // 超时后迟到的响应或未知 requestId：直接忽略。
        return;
      }
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      entry.resolve(message);
    },
  };
}
