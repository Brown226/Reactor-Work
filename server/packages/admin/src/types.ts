// Reactor 管理台 · 与 identity 服务契约的类型（对齐 server/src/identity/*）

export type Role = "platform_admin" | "dept_head" | "user";
export type Source = "ad" | "local";

export interface DeptRef {
  id: number;
  path: string;
}

export interface AdminUser {
  id: number;
  uid: string;
  name: string;
  email: string | null;
  role: Role;
  source: Source;
  status: "active" | "disabled";
  dept: DeptRef | null;
  syncedAt: string | null;
}

export type Scope = { kind: "all" } | { kind: "dept"; path: string | null } | { kind: "self" };

export interface MeResponse {
  user: AdminUser;
  scope: Scope;
}

export interface DeptNode {
  id: number;
  name: string;
  path: string;
  children: DeptNode[];
}

export interface UserListResponse {
  users: AdminUser[];
  total: number;
}

export interface SyncRunResult {
  total: number;
  added: number;
  changed: number;
  disabled: number;
  unchanged: number;
}

export interface SyncDiffResult {
  total: number;
  addedCount: number;
  changedCount: number;
  disabledCount: number;
  unchangedCount: number;
  addedSample: string[];
  changedSample: string[];
  disabled: string[];
}

export interface SyncLog {
  id: number;
  runAt: string;
  mode: string;
  total: number;
  added: number;
  changed: number;
  disabled: number;
  unchanged: number;
}
