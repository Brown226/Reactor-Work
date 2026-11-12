// Reactor 管理台 · 界面模式权限（编程模式受众）
// 契约对齐 packages/server/src/interface-mode/routes.ts（/admin/interface-mode-policy，platform_admin 专用）。
//
// 编程模式受众是**组织级单值**，口径复用 all/role/dept/user 四级可见性（与技能/专家授权同源）；
// 另有 `off` 表示「不向任何人开放」（仅平台管理员例外）。见 docs/未完成-编程模式权限-方案-v1.md。

import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "./identity";
import type { Role } from "../types";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

export type InterfaceModeScopeKind = "off" | "all" | "role" | "dept" | "user";

export interface InterfaceModePolicy {
  kind: InterfaceModeScopeKind;
  roles: Role[];
  deptIds: number[];
  uids: string[];
}

export const interfaceModeApi = {
  get: () => http.get<{ policy: InterfaceModePolicy }>("/admin/interface-mode-policy", AUTH),
  put: (policy: InterfaceModePolicy) =>
    http.put<{ policy: InterfaceModePolicy }>("/admin/interface-mode-policy", policy, AUTH),
};
