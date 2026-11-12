/**
 * 登录页 shim —— 整台换皮第 1 步（用户诉求：「我想要人家的皮，能搬的尽数搬过去」）。
 *
 * ## 为什么需要这个文件
 *
 * `kb-port/pages/login/**` 是 BuildingAI 登录页的**原文照搬**（组件主体零改动，见
 * `docs/实施计划/知识库前端-移植清单-v1.md` 的「只改 import」口径）。上游页面的数据只从一个口出去：
 * 5 个 react-query 风格 hook + 2 个 zustand store + 3 个 services/shared 工具。
 * 本文件就是**把那个口接到我们自己的实现上** —— 页面一行不用改，这是移植切口干净的原因。
 *
 * ## 接了什么、没接什么（不许静默假装成功）
 *
 * | 上游能力 | 我们的处置 |
 * | --- | --- |
 * | 账号密码登录 `useLoginMutation` | ✅ 接 `services/identity.ts` 的 `login()`（→ `/api/auth/login` → identity 服务） |
 * | 检查账号 `useCheckAccountMutation` | ⚠️ 我们只有 LDAP 账号，没有「手机号/是否已设密码」这套 ⇒ **恒返回「账号型 + 需密码」**，页面因此走密码分支 |
 * | 短信验证码 / 注册 / 微信扫码 | ❌ 未接入 ⇒ 调用时**抛中文错误**（页面会 toast 出来），并且 `allowedLoginMethods` 只给 account，入口本身也不显示 |
 *
 * ## 与上游字段的差异（照收不用的部分）
 *
 * 上游 `login({ username, password, terminal: 1 })` 里的 `terminal`、`websiteConfig.loginSettings`
 * 的若干开关，我们**收下但不用** —— 保留原文调用形状，换取「页面零改动」。
 *
 * ## 本文件怎么被引用（2026-09-20 查清）
 *
 * 移植脚本只把上游说明符改指到 `kb-shims/{ui,data,console-services}` 三个 barrel，**不认本文件**，
 * 所以本文件的导出靠那两个 barrel 的 `export * from "./login"` 透出 —— 两边都已接好。
 *
 * ⚠️ 曾经的一次误判（记在这里防重犯）：门禁报「`AgreementDialog` 没有导出」，
 * 而它其实一直是通的 —— 红的原因是 t193 只扫 `data.tsx`+`ui.tsx` 的源文本、**不跟 `export *`**。
 * 把探针改成遍历全部 shim 模块并递归解析 `export *` 之后，才露出**真缺口**：
 * `exchangeOAuthCode` 从未实现过（页面 import 到 `undefined`，回调页会一直在转圈）。
 * 教训：探针假红时先修探针的解析力，再动业务代码 —— 否则会把好代码改坏。
 */
import { useState, type ReactNode } from "react";

import { login as identityLogin } from "../services/identity";

/* ------------------------------------------------------------------ *
 * 常量：上游登录方式枚举。取值只用于「入口是否显示」的判断，
 * 所以这里写成字面量联合即可（真源是 kb-port/constants/auth.constants.ts）。
 * ------------------------------------------------------------------ */

/** 登录/注册方式。上游 LOGIN_TYPE 的镜像：我们只开启 ACCOUNT。 */
export const LOGIN_TYPE = { ACCOUNT: "account", PHONE: "phone", WECHAT: "wechat" } as const;

/** 短信场景。我们没接短信通道，保留取值只为让原文的 `SmsScene.LOGIN` 能编译。 */
export const SmsScene = { LOGIN: "login", REGISTER: "register", BIND: "bind" } as const;

export const WEB_HOME_PATH = "/";

/** 未接入能力的统一话术（带「为什么」，不是「操作失败」这种废话） */
function notWired(name: string): never {
  throw new Error(`${name}未接入：Reactor 目前只支持 LDAP 账号密码登录（见 kb-shims/login.tsx 头注）`);
}

/* ------------------------------------------------------------------ *
 * 取数层：5 个 hook + 2 个微信接口
 * ------------------------------------------------------------------ */

/** 同步取数 hook 的最小形状：本仓没有 react-query，页面只用到 `mutateAsync` 与 `isPending`。 */
interface MutationLike<TVars, TData> {
  mutateAsync: (vars: TVars) => Promise<TData>;
  isPending: boolean;
}

function useMutationLike<TVars, TData>(fn: (vars: TVars) => Promise<TData>): MutationLike<TVars, TData> {
  const [isPending, setPending] = useState(false);
  return {
    isPending,
    mutateAsync: async (vars: TVars) => {
      setPending(true);
      try {
        return await fn(vars);
      } finally {
        setPending(false);
      }
    },
  };
}

/** 账号是否存在（决定页面走「密码」还是「注册」分支）。我们只有 LDAP ⇒ 恒「账号型 + 有密码」。 */
export function useCheckAccountMutation() {
  return useMutationLike<{ account: string }, { type: "account" | "mobile"; hasPassword: boolean; account: string }>(
    async ({ account }) => ({ type: "account", hasPassword: true, account }),
  );
}

/**
 * 账号密码登录 —— **唯一真接线**。
 *
 * 上游返回 `{ token }`，页面随后 `setToken(data.token)` 与 `handleRedirect(target, token)`。
 * 我们的 `identityLogin()` 已经把 access/refresh 写进 localStorageTokenStore，
 * 所以这里回一个空 token 就够（只有「扩展页带 _t 参数」那条路径会用到它的值）。
 */
export function useLoginMutation() {
  return useMutationLike<{ username: string; password: string; terminal?: number }, { token: string }>(
    async ({ username, password }) => {
      await identityLogin(username, password);
      return { token: "" };
    },
  );
}

export function useRegisterMutation() {
  return useMutationLike<Record<string, unknown>, never>(async () => notWired("注册"));
}

export function useSendSmsCodeMutation() {
  return useMutationLike<Record<string, unknown>, never>(async () => notWired("短信验证码"));
}

export function useSmsLoginMutation() {
  return useMutationLike<Record<string, unknown>, never>(async () => notWired("短信登录"));
}

export function getWechatQrcode(): Promise<never> {
  return Promise.reject(new Error("微信扫码登录未接入：Reactor 走企业 LDAP，无微信通道"));
}

export function getWechatQrcodeStatus(_key: string): Promise<never> {
  return Promise.reject(new Error("微信扫码登录未接入：Reactor 走企业 LDAP，无微信通道"));
}

/**
 * OAuth 回调换令牌（登录页 `oauth-callback.tsx` 用）。
 *
 * 我们没有任何 OAuth 提供方（只有 LDAP 账号密码），所以这里**必须抛**而不是静默返回。
 *
 * 它曾经压根不存在（2026-09-20 由 t193 放宽扫描后抳出）：页面在 `useEffect` 里**直接**调用它
 *（不在 `try/catch` 内），而 import 到的是 `undefined` ⇒ 同步 TypeError 把整页弄崩
 *（不是卡在 loading：那个 `.catch()` 接不到同步抛错）。
 */
export function exchangeOAuthCode(_code: string): Promise<never> {
  return Promise.reject(new Error("OAuth 回调登录未接入：Reactor 只支持 LDAP 账号密码（见 kb-shims/login.tsx 头注）"));
}

/* ------------------------------------------------------------------ *
 * 两个 store：**不在这里定义** —— 它们是 `kb-shims/ui.tsx` 的单一事实源
 *
 * 原因：登录页与对话侧（permission-guard 等）读的是**同一个** `useAuthStore`/`useConfigStore`，
 * 两处各定义一份会造成 `export *` 同名歧义（谁生效取决于导入路径，是性能陷阱）。
 * 所以此文件不再导出这两个名字，而是在 ui.tsx 里把登录页需要的字段（`authActions`、
 * `config.websiteConfig.loginSettings`）补齐。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * services/shared 的三个工具（页面的跳转判断用）
 * ------------------------------------------------------------------ */

export function hasConsoleAccess(_userInfo: unknown): boolean {
  // 能通过 identity 校验就说明有控制台权限（权限面由服务端 /me/nav 决定，不在这里二次判）
  return true;
}

export function getFirstConsoleMenuPath(_menus: unknown[]): string {
  // 本仓菜单由服务端 /me/nav 驱动，登录后统一落 /（控制台首页）
  return WEB_HOME_PATH;
}

/* ------------------------------------------------------------------ *
 * 协议弹窗：我们关掉了 showPolicyAgreement，所以这里只是个空壳；
 * 保留它是为了「页面零改动」—— 上游源码里它就长这样被引用。
 * ------------------------------------------------------------------ */

export type AgreementType = string;

export function AgreementDialog(_props: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  type?: AgreementType;
  children?: ReactNode;
  [key: string]: unknown;
}): null {
  return null;
}
