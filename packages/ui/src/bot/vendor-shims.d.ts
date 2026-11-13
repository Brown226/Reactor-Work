/**
 * [本地定制] vendor/ds-bot-client 与 shell 的 ambient 类型声明。
 *
 * DS-Bot 的视图是纯 JS（用 h() 而非 JSX），没有 .d.ts；tsc 不开 allowJs，
 * 否则 composite 项目的 declaration emit 会把 vendor JS 里的全局引用
 * （如 window.SpeechRecognition）泄成 private name 错误（TS9006）。
 *
 * 用 ambient module 声明把它们被 Reactor 消费的具名导出放宽成 any：
 * 真正的形状校验在 adapters/botStore.ts 的 roster 类型上。
 * 上游未来若自带类型，删掉本文件即可。
 */

declare module "@/bot/shell/app.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const App: any;
}

declare module "@/bot/shell/locale.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const createLocale: any;
}

declare module "@/bot/vendor/ds-bot-client/i18n.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const installLocale: any;
}

declare module "@/bot/vendor/ds-bot-client/styles.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const installStyles: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const CONVERSATION_CSS: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const SHELL_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/about.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ABOUT_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/bot-settings.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const BOT_SETTINGS_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/feedback.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const FEEDBACK_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/folder-menu.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const FOLDER_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/group-settings.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const GROUP_SETTINGS_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/member-status.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const MEMBER_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/model-menu.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const MODEL_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/providers-page.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const PROVIDERS_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/schedules.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const SCHEDULE_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/secret-card.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const SECRET_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/sidebar.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const SIDEBAR_CSS: any;
}

declare module "@/bot/vendor/ds-bot-client/usage-page.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const USAGE_CSS: any;
}
