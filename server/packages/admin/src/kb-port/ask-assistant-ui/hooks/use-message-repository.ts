// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/hooks/use-message-repository.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type { UIMessage } from "ai";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import type { RawMessageRecord } from "../libs/message-repository";
import { MessageRepository } from "../libs/message-repository";
import type { DisplayMessage } from "../types";

/**
 * Return value of useMessageRepository hook
 */
export interface UseMessageRepositoryReturn {
  /** Messages in the current active branch */
  messages: readonly UIMessage[];
  /** Display messages in the current active branch (with branch info) */
  displayMessages: readonly DisplayMessage[];
  /** Current head message ID */
  headId: string | null;
  /** Total number of messages */
  size: number;
  /** Add or update a message */
  addOrUpdateMessage: (
    parentId: string | null,
    message: UIMessage,
    sequence?: number,
    createdAt?: string,
  ) => void;
  /** Incrementally import messages (without clearing existing messages) */
  importIncremental: (records: RawMessageRecord[], setNewAsActive?: boolean) => boolean;
  /** Import messages from raw records (full replacement) */
  importMessages: (records: RawMessageRecord[], selectLatestBranch?: boolean) => void;
  /** Switch to the specified branch */
  switchToBranch: (messageId: string) => void;
  /** Get branch information */
  getBranchInfo: (messageId: string) => {
    branchNumber: number;
    branchCount: number;
    branches: string[];
  } | null;
  /** Get the parent ID of a message */
  getParentId: (messageId: string) => string | null | undefined;
  /** Delete a message */
  deleteMessage: (messageId: string) => void;
  /** Clear all messages */
  clear: () => void;
  /** Reset lastImportSeenIds to the given IDs (prevents rename/alias on next importIncremental) */
  resetLastSeenIds: (ids: string[]) => void;
  /** Check if a message exists */
  has: (messageId: string) => boolean;
  /** Get a message */
  getMessage: (messageId: string) => UIMessage | undefined;
}

/**
 * Message repository hook
 *
 * Provides message tree structure management with support for:
 * - Multiple root messages
 * - Multiple branches (versions) under the same parent message
 * - Branch switching
 * - Incremental updates (to avoid flickering from full rebuilds)
 */
export function useMessageRepository(): UseMessageRepositoryReturn {
  const repositoryRef = useRef<MessageRepository | null>(null);

  const versionRef = useRef(0);

  const subscribersRef = useRef<Set<() => void>>(new Set());

  if (!repositoryRef.current) {
    repositoryRef.current = new MessageRepository();
  }

  const repository = repositoryRef.current;

  const notifySubscribers = useCallback(() => {
    versionRef.current++;
    subscribersRef.current.forEach((callback) => callback());
  }, []);

  const subscribe = useCallback((callback: () => void) => {
    subscribersRef.current.add(callback);
    return () => {
      subscribersRef.current.delete(callback);
    };
  }, []);

  const getSnapshot = useCallback(() => versionRef.current, []);

  const addOrUpdateMessage = useCallback(
    (parentId: string | null, message: UIMessage, sequence: number = 0, createdAt?: string) => {
      repository.addOrUpdateMessage(parentId, message, sequence, createdAt);
      notifySubscribers();
    },
    [repository, notifySubscribers],
  );

  const importIncremental = useCallback(
    (records: RawMessageRecord[], setNewAsActive = true) => {
      const hasChange = repository.importIncremental(records, setNewAsActive);
      if (hasChange) {
        notifySubscribers();
      }
      return hasChange;
    },
    [repository, notifySubscribers],
  );

  const importMessages = useCallback(
    (records: RawMessageRecord[], selectLatestBranch = true) => {
      repository.import(records, selectLatestBranch);
      notifySubscribers();
    },
    [repository, notifySubscribers],
  );

  const switchToBranch = useCallback(
    (messageId: string) => {
      repository.switchToBranch(messageId);
      notifySubscribers();
    },
    [repository, notifySubscribers],
  );

  const deleteMessage = useCallback(
    (messageId: string) => {
      repository.deleteMessage(messageId);
      notifySubscribers();
    },
    [repository, notifySubscribers],
  );

  const clear = useCallback(() => {
    repository.clear();
    notifySubscribers();
  }, [repository, notifySubscribers]);

  const resetLastSeenIds = useCallback(
    (ids: string[]) => {
      repository.resetLastSeenIds(ids);
    },
    [repository],
  );

  const getBranchInfo = useCallback(
    (messageId: string) => {
      return repository.getBranchInfo(messageId);
    },
    [repository],
  );

  const getParentId = useCallback(
    (messageId: string) => {
      return repository.getParentId(messageId);
    },
    [repository],
  );

  const has = useCallback(
    (messageId: string) => {
      return repository.has(messageId);
    },
    [repository],
  );

  const getMessage = useCallback(
    (messageId: string) => {
      return repository.getMessage(messageId);
    },
    [repository],
  );

  const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const messages = useMemo(() => repository.getMessages(), [repository, version]);
  const displayMessages = useMemo(() => repository.getDisplayMessages(), [repository, version]);
  const headId = useMemo(() => repository.headId, [repository, version]);
  const size = useMemo(() => repository.size, [repository, version]);

  return {
    messages,
    displayMessages,
    headId,
    size,
    addOrUpdateMessage,
    importIncremental,
    importMessages,
    switchToBranch,
    getBranchInfo,
    getParentId,
    deleteMessage,
    clear,
    resetLastSeenIds,
    has,
    getMessage,
  };
}
