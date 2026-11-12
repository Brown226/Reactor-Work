/**
 * 界面模式权限（编程模式受众）——数据域。
 *
 * 只有「编程模式」一个受限档，受众是**组织级单值**，故用单行表（同 `desktop_policy` 的做法）。
 * 可见性口径复用 `common/scope.ts` 的四级并集（all/role/dept/user），dept 为**精确匹配、不做子树**，
 * 与 skills / agents 的可见性口径保持一致（见 common/scope.ts 头注）。
 *
 * 为什么多一个 `off`：产品规则是**白名单默认关闭**（未配置时仅平台管理员可用编程模式），
 * 需要一个显式的「谁都不授权」态，不能拿 `all` 的空数组代替（那样语义含糊）。
 */

import type { IdentityDb } from "../identity/db.js";
import type { Role } from "../identity/users.js";

/** 编程模式受众口径：off 谁都不授权（仅平台管理员例外）；其余与 ResourceScope 同级。 */
export type InterfaceModeScopeKind = "off" | "all" | "role" | "dept" | "user";

export interface InterfaceModePolicy {
  kind: InterfaceModeScopeKind;
  roles: Role[];
  deptIds: number[];
  uids: string[];
}

/**
 * 未配置时的默认受众：**off**（白名单默认关闭）。
 * 判定层对平台管理员恒定放行，故 off ≠ 把管理员也锁出去。
 */
export const DEFAULT_INTERFACE_MODE_POLICY: InterfaceModePolicy = {
  kind: "off",
  roles: [],
  deptIds: [],
  uids: [],
};

/** 三档界面模式的字面量（与端上 `lib/interfaceMode.ts` 同口径）。 */
const ALL_INTERFACE_MODES = ["office", "coding", "review"] as const;
/** 去掉编程档后的收敛集（未授权编程模式时下发它）。 */
const FOCUSED_INTERFACE_MODES = ["office", "review"] as const;

export async function ensureInterfaceModeSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS interface_mode_policy (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      scope_kind TEXT NOT NULL DEFAULT 'off' CHECK (scope_kind IN ('off','all','role','dept','user')),
      scope_roles TEXT[] NOT NULL DEFAULT '{}',
      scope_dept_ids INT[] NOT NULL DEFAULT '{}',
      scope_uids TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    );
  `);
}

interface PolicyRow {
  scope_kind: string;
  scope_roles: string[] | null;
  scope_dept_ids: number[] | null;
  scope_uids: string[] | null;
}

/** 库中 kind 校验：非法值一律按 off 处理（fail-closed，绝不因脏值放大可见性）。 */
function normalizeKind(value: unknown): InterfaceModeScopeKind {
  return value === "all" || value === "role" || value === "dept" || value === "user" ? value : "off";
}

export async function getInterfaceModePolicy(db: IdentityDb): Promise<InterfaceModePolicy> {
  const { rows } = await db.pool.query<PolicyRow>(
    `SELECT scope_kind, scope_roles, scope_dept_ids, scope_uids FROM interface_mode_policy WHERE id = 1`,
  );
  const row = rows[0];
  if (!row) return { ...DEFAULT_INTERFACE_MODE_POLICY };
  return {
    kind: normalizeKind(row.scope_kind),
    roles: (row.scope_roles ?? []) as Role[],
    deptIds: row.scope_dept_ids ?? [],
    uids: row.scope_uids ?? [],
  };
}

/** 写入受众（仅平台管理员，路由层已校验角色）。 */
export async function putInterfaceModePolicy(
  db: IdentityDb,
  policy: InterfaceModePolicy,
  updatedBy: string,
): Promise<InterfaceModePolicy> {
  await db.pool.query(
    `INSERT INTO interface_mode_policy (id, scope_kind, scope_roles, scope_dept_ids, scope_uids, updated_at, updated_by)
     VALUES (1, $1, $2, $3, $4, now(), $5)
     ON CONFLICT (id) DO UPDATE SET
       scope_kind = EXCLUDED.scope_kind,
       scope_roles = EXCLUDED.scope_roles,
       scope_dept_ids = EXCLUDED.scope_dept_ids,
       scope_uids = EXCLUDED.scope_uids,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by`,
    [policy.kind, policy.roles, policy.deptIds, policy.uids, updatedBy],
  );
  return getInterfaceModePolicy(db);
}

/** 判定视角：由令牌解析（与服务端 `viewerOf` 同口径）。 */
export interface InterfaceModeViewer {
  uid: string;
  role: Role;
  deptId: number | null;
}

/**
 * 该 viewer 是否可用编程模式。
 *
 * 平台管理员**恒可用**：否则管理员一旦把受众配错，自己也会被锁在编程模式之外而无法回管理台修正
 * —— 那是把运维锁死的设计缺陷，不是安全收益。
 */
export function codingAllowedFor(policy: InterfaceModePolicy, viewer: InterfaceModeViewer): boolean {
  if (viewer.role === "platform_admin") return true;
  switch (policy.kind) {
    case "off":
      return false;
    case "all":
      return true;
    case "role":
      return policy.roles.includes(viewer.role);
    case "dept":
      return viewer.deptId !== null && policy.deptIds.includes(viewer.deptId);
    case "user":
      return policy.uids.includes(viewer.uid);
    default:
      return false;
  }
}

/**
 * 该 viewer 可用的界面模式列表（下发给端侧，端侧据此过滤切换器并兜底当前档）。
 * 未授权编程模式时不含 `"coding"`。
 */
export function allowedInterfaceModesFor(
  policy: InterfaceModePolicy,
  viewer: InterfaceModeViewer,
): string[] {
  return codingAllowedFor(policy, viewer) ? [...ALL_INTERFACE_MODES] : [...FOCUSED_INTERFACE_MODES];
}
