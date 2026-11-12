/**
 * 内置本地测试号 seed（admin=平台管理员 / head=部门负责人(设计管理部子树演示数据范围) / user=普通）。
 * 仅在 authMode local/mixed 时生效（ldap 模式不建本地号）；口令来自 config.test（测试专用）。
 */

import type { IdentityConfig } from "./config.js";
import type { IdentityDb } from "./db.js";
import { ensureDeptPath } from "./depts.js";
import { hashPassword } from "./passwords.js";
import { createLocalUser, findUserByUid } from "./users.js";

export async function ensureBuiltinLocalAccounts(db: IdentityDb, cfg: IdentityConfig): Promise<void> {
  if (cfg.authMode === "ldap") return;

  const adminExists = await findUserByUid(db, "admin");
  if (!adminExists) {
    await createLocalUser(db, {
      uid: "admin",
      name: "平台管理员",
      role: "platform_admin",
      departmentId: null,
      passwordHash: hashPassword(cfg.test.adminPwd),
    });
  }

  const headExists = await findUserByUid(db, "head");
  if (!headExists) {
    const headDeptId = cfg.headDeptPath.length ? await ensureDeptPath(db, cfg.headDeptPath) : null;
    await createLocalUser(db, {
      uid: "head",
      name: "部门负责人",
      role: "dept_head",
      departmentId: headDeptId,
      passwordHash: hashPassword(cfg.test.headPwd),
    });
  }

  const userExists = await findUserByUid(db, "user");
  if (!userExists) {
    await createLocalUser(db, {
      uid: "user",
      name: "普通员工",
      role: "user",
      departmentId: null,
      passwordHash: hashPassword(cfg.test.userPwd),
    });
  }
}
