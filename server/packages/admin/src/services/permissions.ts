// Reactor 管理台 · 权限点服务（U-2/U-3）
// 契约对齐 packages/server/src/identity/permissions-routes.ts（platform_admin 专用）。

import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "./identity";
import type { Role } from "../types";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

export interface PermissionPoint {
  code: string;
  method: string;
  path: string;
  description: string | null;
  updatedAt: string | null;
}

export interface RolePermissions {
  key: Role;
  label: string;
  scope: string;
  permissions: string[];
}

export interface PermissionsPayload {
  permissions: PermissionPoint[];
  roles: RolePermissions[];
}

export interface ScanResult {
  total: number;
  added: number;
  removed: number;
}

export const permissionsApi = {
  list: () => http.get<PermissionsPayload>("/admin/permissions", AUTH),
  /** 从当前路由表重新扫描权限点（幂等） */
  scan: () => http.post<PermissionsPayload & { result: ScanResult }>("/admin/permissions/scan", {}, AUTH),
};
