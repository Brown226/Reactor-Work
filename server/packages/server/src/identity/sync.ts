/**
 * AD/LDAP 组织用户同步（第 1 批，手动触发——对齐细化 G3）：
 *  - preview：只读差异（不改库）
 *  - run：按 DN OU 段落部门树（ensureDeptPath）+ 用户 upsert + AD 源缺失者停用
 * source=local 用户永不参与（平台本地号）。
 */

import type { IdentityConfig } from "./config.js";
import type { IdentityDb } from "./db.js";
import { ensureDeptPath } from "./depts.js";
import { listLdapUsers, type LdapUser } from "./ldap.js";
import {
  disableMissingAdUsers,
  listUsers,
  upsertAdUser,
  type UserRow,
} from "./users.js";

export interface SyncDiff {
  total: number;
  added: LdapUser[];
  changed: LdapUser[];
  disabled: string[]; // 平台 ad 用户里已不在 LDAP 的 uid
  unchanged: number;
  activeUids: string[]; // 当前 LDAP 在册全部 uid
}

function expectedPath(u: LdapUser): string | null {
  return u.ouPath.length ? u.ouPath.join("/") : null;
}

function changed(a: UserRow, b: LdapUser): boolean {
  return (
    a.name !== b.name ||
    (a.email ?? null) !== (b.email ?? null) ||
    a.deptPath !== expectedPath(b) ||
    a.status !== "active"
  );
}

export async function computeSyncDiff(db: IdentityDb, cfg: IdentityConfig): Promise<SyncDiff> {
  const adUsers = await listLdapUsers(cfg.ldap);
  const dbUsers = await listUsers(db, {});
  const byUid = new Map(dbUsers.map((u) => [u.uid, u]));
  const adSet = new Set(adUsers.map((u) => u.uid));

  const added: LdapUser[] = [];
  const changedList: LdapUser[] = [];
  let unchanged = 0;
  for (const ad of adUsers) {
    const existing = byUid.get(ad.uid);
    if (!existing) {
      added.push(ad);
    } else if (existing.source === "local") {
      continue; // 平台本地号（uid 撞名），跳过
    } else if (changed(existing, ad)) {
      changedList.push(ad);
    } else {
      unchanged += 1;
    }
  }

  const disabled: string[] = [];
  for (const dbU of dbUsers) {
    if (dbU.source === "ad" && !adSet.has(dbU.uid) && dbU.status === "active") {
      disabled.push(dbU.uid);
    }
  }

  return {
    total: adUsers.length,
    added,
    changed: changedList,
    disabled,
    unchanged,
    activeUids: [...adSet],
  };
}

export interface SyncRunResult {
  total: number;
  added: number;
  changed: number;
  disabled: number;
  unchanged: number;
}

export async function runSync(db: IdentityDb, cfg: IdentityConfig): Promise<SyncRunResult> {
  const diff = await computeSyncDiff(db, cfg);
  for (const ad of [...diff.added, ...diff.changed]) {
    const deptId = ad.ouPath.length ? await ensureDeptPath(db, ad.ouPath) : null;
    await upsertAdUser(db, { uid: ad.uid, name: ad.name, email: ad.email, adDn: ad.dn, departmentId: deptId });
  }
  await disableMissingAdUsers(db, new Set(diff.activeUids));
  const result = {
    total: diff.total,
    added: diff.added.length,
    changed: diff.changed.length,
    disabled: diff.disabled.length,
    unchanged: diff.unchanged,
  };
  await db.pool.query(
    `INSERT INTO ad_sync_logs (run_at, mode, total, added, changed, disabled, unchanged, diff_json)
     VALUES (now(), 'run', $1, $2, $3, $4, $5, $6)`,
    [result.total, result.added, result.changed, result.disabled, result.unchanged,
     JSON.stringify({ addedSample: diff.added.slice(0, 5).map((u) => u.uid), disabled: diff.disabled })],
  );
  return result;
}

export async function previewSync(db: IdentityDb, cfg: IdentityConfig): Promise<{
  total: number;
  addedCount: number;
  changedCount: number;
  disabledCount: number;
  unchangedCount: number;
  addedSample: string[];
  changedSample: string[];
  disabled: string[];
}> {
  const diff = await computeSyncDiff(db, cfg);
  const sample = (list: LdapUser[], n: number): string[] => list.slice(0, n).map((u) => `${u.uid}(${u.name})`);
  return {
    total: diff.total,
    addedCount: diff.added.length,
    changedCount: diff.changed.length,
    disabledCount: diff.disabled.length,
    unchangedCount: diff.unchanged,
    addedSample: sample(diff.added, 5),
    changedSample: sample(diff.changed, 5),
    disabled: diff.disabled,
  };
}

export async function listSyncLogs(db: IdentityDb, limit = 20): Promise<
  Array<{ id: number; runAt: string; mode: string; total: number; added: number; changed: number; disabled: number; unchanged: number }>
> {
  const { rows } = await db.pool.query<{
    id: number;
    run_at: Date;
    mode: string;
    total: number;
    added: number;
    changed: number;
    disabled: number;
    unchanged: number;
  }>("SELECT id, run_at, mode, total, added, changed, disabled, unchanged FROM ad_sync_logs ORDER BY id DESC LIMIT $1", [limit]);
  return rows.map((r) => ({
    id: r.id,
    runAt: r.run_at.toISOString(),
    mode: r.mode,
    total: r.total,
    added: r.added,
    changed: r.changed,
    disabled: r.disabled,
    unchanged: r.unchanged,
  }));
}
