/**
 * 认证（M0-E1）：AD/LDAP 域账号 BIND 校验 + 短期令牌。
 * 令牌形态参照 BuildingAI JWT + 滑动续签；桌面/文档/网关唯一凭证（FR-M1-01/02）。
 */

/** 令牌载荷（短期、含部门与角色；M2 补三角色按部门授权） */
export interface TokenPayload {
  sub: string; // 域账号
  displayName?: string;
  /** 部门树节点 id（M1 组织同步后落库） */
  departmentId?: string;
  /** 令牌类型：桌面侧唯一凭证 / 网关调用凭证 */
  audience: "desktop" | "gateway" | "docs";
  exp: number;
  iat: number;
  jti: string;
}
