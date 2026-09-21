// Reactor 管理台 · Identity 服务（T1-2）：登录 / 会话水合 / 续签
// 对齐 server/src/identity/routes.ts 契约；职责单一，供 stores/auth 与各页面调用。

import { ApiError, http, localStorageTokenStore } from "../http/client";
import type { MeResponse } from "../types";

/** 登录：写 token 后拉 /me（一次往返拿到身份 + 数据范围） */
export async function login(username: string, password: string): Promise<MeResponse> {
  const j = await http.post<{ accessToken: string; refreshToken: string }>("/auth/login", { username, password });
  localStorageTokenStore.setTokens(j.accessToken, j.refreshToken);
  return me();
}

/** 当前会话信息；401 原样抛出（由调用方决定是否续签） */
export function me(): Promise<MeResponse> {
  return http.get<MeResponse>("/me");
}

/** 用 refreshToken 续签；成功写新 token，失败清态 */
export async function refreshAccess(): Promise<boolean> {
  const rt = localStorageTokenStore.getRefresh();
  if (!rt) return false;
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!res.ok) {
      localStorageTokenStore.clearTokens();
      return false;
    }
    const j = (await res.json()) as { accessToken: string; refreshToken: string };
    localStorageTokenStore.setTokens(j.accessToken, j.refreshToken);
    return true;
  } catch {
    localStorageTokenStore.clearTokens();
    return false;
  }
}

export { ApiError, http, localStorageTokenStore };
