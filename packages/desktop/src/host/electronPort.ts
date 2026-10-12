import type { MessagePortMain } from "electron";
import type { MessagePortLike, MessagePortPayload } from "@zcode/rpc";

/**
 * 将 Electron MessagePortMain 适配为 RPC 层的 MessagePortLike 接口。
 *
 * Electron 的 MessagePortMain 使用 Node EventEmitter 风格 (.on/.off)，
 * 而 MessagePortLike 使用 Web 标准风格 (addEventListener/removeEventListener)。
 * 此适配器弥合两者差异，使 MessagePortProtocol 可以直接在 utilityProcess 中使用。
 */
export function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  // message 与 close 的 listener 统一收一个事件参数（close 调用方传无参箭头函数），
  // 对象字面量不必写同名重载方法；内部按 type 分派并窄化 listener。
  type AnyPortListener = (e: { data: MessagePortPayload }) => void;
  return {
    addEventListener(type: "message" | "close", listener: AnyPortListener) {
      if (type === "message") {
        // MessagePortMain 的 message 事件已经是 { data } 结构，直接转发
        port.on("message", listener as (e: { data: MessagePortPayload }) => void);
        return;
      }
      // renderer 进程退出/崩溃时 port 触发 close，host 侧借此让 RPC fail-closed。
      port.on("close", listener as () => void);
    },
    removeEventListener(type: "message" | "close", listener: AnyPortListener) {
      if (type === "message") {
        port.off("message", listener as (e: { data: MessagePortPayload }) => void);
        return;
      }
      port.off("close", listener as () => void);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}
