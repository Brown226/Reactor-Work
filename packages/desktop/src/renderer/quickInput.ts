import type { QuickInputStatePayload } from "@zcode/shared";

declare global {
  interface Window {
    quickInput?: {
      submit?(payload: { text: string; imagePath?: string }): void;
      hide?(): void;
      onState?(callback: (state: QuickInputStatePayload) => void): () => void;
    };
  }
}

const bridge = window.quickInput;
const input = document.getElementById("input") as HTMLTextAreaElement | null;
const sendButton = document.getElementById("send");
const hint = document.getElementById("hint");

const MESSAGES: Record<string, { placeholder: string; hint: string; send: string }> = {
  "zh-CN": {
    placeholder: "随手问一句…（Enter 发送，Shift+Enter 换行，Esc 收起）",
    hint: "Enter 发送 · Esc 收起",
    send: "发送",
  },
  "en-US": {
    placeholder: "Quick ask… (Enter to send, Shift+Enter for newline, Esc to dismiss)",
    hint: "Enter to send · Esc to dismiss",
    send: "Send",
  },
};

function applyLocale(locale: string): void {
  const messages = MESSAGES[locale] ?? MESSAGES["zh-CN"];
  if (input) input.placeholder = messages.placeholder;
  if (hint) hint.textContent = messages.hint;
  if (sendButton) sendButton.textContent = messages.send;
  document.documentElement.lang = locale;
}

function submit(): void {
  const text = input?.value ?? "";
  if (text.trim().length === 0) {
    return;
  }
  bridge?.submit?.({ text });
  if (input) input.value = "";
}

sendButton?.addEventListener("click", submit);

input?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    bridge?.hide?.();
  }
});

bridge?.onState?.((state) => applyLocale(state.locale));

// 挂载即聚焦，用户按热键后可直接输入。
input?.focus();
