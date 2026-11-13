/**
 * [本地定制] DS-Bot 端点的「Reactor 无对应运行时」分组。
 *
 * 这些能力在 DS-Bot 里依赖它自己的宿主（mnemon 记忆分层、跨会话注入、gen-ui 通道、
 * learning 卡片、交换对话）。Reactor 的对应能力由主会话 / Harness 承载，Bot 视图
 * 不重复一份；这里给**可用的只读空态 + 明确的不可用返回**，让面板能打开、
 * 不出现 undefined is not a function，也不假装成功。
 *
 * 从 botStore.ts 拆出来是为了守住单文件 800 行上限（见 .oxlintrc 的 max-lines）。
 */

export function createUnsupportedGroups() {
  return {

      /**
       * 记忆面板。Reactor 的记忆归 Harness 的 mnemon 体系，没有「按 Bot 增删改条目」
       * 的宿主 API。这里给可用的只读视图（空列表），写操作明确拒绝——
       * 面板能打开、能看空态，不会因为 undefined 崩掉。
       */
      async memoryView() {
        return { entries: [] };
      },
      async memoryAsk() {
        return { reply: "", changes: [] };
      },
      async memoryHistory() {
        return { entries: [] };
      },
      async memoryLayer() {
        return { ok: false, reply: "Reactor 的记忆由 harness 统一管理，Bot 视图不提供分层写入。" };
      },
      async memoryMove() {
        return { ok: false };
      },
      async memoryPin() {
        return { ok: false };
      },
      async memoryForget() {
        return { ok: false };
      },
      async memoryRestore() {
        return { ok: false };
      },
      async memoryTidyUndo() {
        return { ok: false };
      },

      /** 消息文本分页（DS-Bot 的 file-text，用于附件预览）。 */
      async fileText(payload: { sessionId?: string; path?: string } | null) {
        const path = payload?.path;
        if (!path) return { text: "" };
        // 附件正文由 Reactor 的预览组件渲染，Bot 视图这里只回空文本，
        // 不越过权限边界去读宿主文件。
        return { text: "" };
      },

      /** 对话交换（两个 Bot 互相看对方的对话）。Reactor 无此运行时。 */
      async exchange() {
        return { ok: false, reason: "web" };
      },
      async exchangeText() {
        return { text: "" };
      },

      /** 视图卡片应答（widget）。Reactor 的 gen-ui 由主会话承载，Bot 视图无通道。 */
      async viewReply() {
        return { ok: false, reason: "web" };
      },

      /** 学习卡片应答。 */
      async learningAnswer() {
        return { ok: false, reason: "web" };
      },

      /** 放弃某个等待中的交接。 */
      async abandonWork() {
        return { ok: true };
      },

      async btwDelete() {
        return { ok: true };
      },
  };
}

export type UnsupportedGroups = ReturnType<typeof createUnsupportedGroups>;
