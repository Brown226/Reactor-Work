// Reactor 管理台 · 认证状态（T1-2）：zustand slice
// 形态来源：BuildingAI web/stores（Apache-2.0，zustand 分 slice）；
// 行为对齐旧 auth.tsx（启动水合 /me → 401 自动 refresh → 重试；登录写态；登出清态）。

import { create } from "zustand";
import { me as fetchMe, login as svcLogin, refreshAccess } from "../services/identity";
import { localStorageTokenStore } from "../http/client";
import type { AdminUser, Scope } from "../types";

interface AuthState {
  user: AdminUser | null;
  scope: Scope | null;
  /** 启动水合进行中（决定显示加载屏还是登录页） */
  loading: boolean;
  login: (username: string, password: string) => Promise<AdminUser>;
  logout: () => void;
  reload: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  scope: null,
  loading: true,

  login: async (username, password) => {
    const res = await svcLogin(username, password);
    set({ user: res.user, scope: res.scope });
    return res.user;
  },

  logout: () => {
    localStorageTokenStore.clearTokens();
    set({ user: null, scope: null });
  },

  reload: async () => {
    if (!localStorageTokenStore.getAccess()) {
      set({ loading: false });
      return;
    }
    let res = await fetchMe().catch(() => null);
    if (!res && (await refreshAccess())) res = await fetchMe().catch(() => null);
    if (res) {
      set({ user: res.user, scope: res.scope, loading: false });
    } else {
      localStorageTokenStore.clearTokens();
      set({ user: null, scope: null, loading: false });
    }
  },
}));

/** 兼容旧组件的选择器习惯（返回稳定引用由 zustand 保证） */
export function useAuth(): Pick<AuthState, "user" | "scope" | "loading" | "login" | "logout" | "reload"> {
  return useAuthStore((s) => s);
}

export function scopeLabel(scope: Scope | null, deptPath: string | null): string {
  if (!scope) return "—";
  if (scope.kind === "all") return "全公司";
  if (scope.kind === "dept") return scope.path ?? deptPath ?? "本部门";
  return "仅本人";
}
