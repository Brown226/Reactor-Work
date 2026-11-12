/**
 * 批量额度下发（额度分配 §11.7）：一次给多个目标**同值**写规则。
 *
 * 动机（现场原话）："批量给各个用户每月 1 亿 token 的额度或者部门这种"。
 * 逐条 PUT 对几百人的组织是不可用的操作。而批量最大的风险是**无声扩大影响面"——
 * 所以本模块的三条设计约束都围绕"可预览、可解释、可回退"：
 *
 *  1. **先预览后写入**：`planQuotaBatch` 只解析不写库，管理台的「预览」用它，
 *     每条目标都标出是**新建**还是**覆盖已有**（覆盖会连上限/阈值/动作一起改掉）。
 *  2. **跳过的必须说出来**：uid 不存在/已停用、部门不存在、子树下没有在用用户，
 *     全部进 `skipped` 由界面展示 —— 不静默建规则（给已删账号发额度是静默失效），
 *     也不静默丢弃（管理员以为发了 800 条实际只有 700 条）。
 *  3. **请求内去重**：同一 `(scope_type, scope_id)` 只写一次，按 targets 顺序先到先得，
 *     避免同请求内"先给张三 1M 又给张三 5M"自相矛盾。
 *
 * 分层（server/AGENTS.md）：SQL 在 `quota-repo.ts`，评估/告警在 `quota-eval.ts`，
 * 本文件只做编排，不写 SQL。
 */

import type { IdentityDb } from "../identity/db.js";
import {
  deptSubtreeIds,
  existingDeptIds,
  existingRuleScopeKeys,
  listActiveUidsInDepts,
  uidStatusMap,
  upsertQuotaRule,
  type QuotaAction,
  type QuotaRule,
  type QuotaScopeType,
} from "./quota-repo.js";
import { currentPeriod, evaluateRules } from "./quota-eval.js";

/** 单次批量的目标数上限：防误操作（多打一个零就是全库每人一条规则）。 */
export const MAX_BATCH_TARGETS = 500;

/** 批量请求错误（路由层据此回 400；其余异常回 500）。 */
export class QuotaBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaBatchError";
  }
}

export interface QuotaBatchTarget {
  scopeType: QuotaScopeType;
  /** dept/user 必填（org 忽略）。dept 传部门 id，user 传 uid。 */
  scopeIds?: string[];
  /** dept 专用：把该部门**子树下每个在用用户**展开为各自的 user 规则。 */
  expandUsers?: boolean;
}

export interface QuotaBatchInput {
  targets: QuotaBatchTarget[];
  /** 已由路由层换算成 tokens 数（支持单位后缀的解析在 quota-routes.ts）。 */
  limitTokens?: number | null;
  limitCost?: number | null;
  alertThresholds?: number[];
  action?: QuotaAction;
  enabled?: boolean;
}

export interface QuotaBatchResolved {
  scopeType: QuotaScopeType;
  scopeId: string | null;
  /** 库里是否已有同 scope 规则（true = 本次是覆盖，预览里必须让管理员看见）。 */
  existed: boolean;
}

export interface QuotaBatchSkipped {
  scopeType: QuotaScopeType;
  scopeId: string | null;
  reason: string;
}

/** 预览结果：将写入哪些规则、跳过哪些、为什么。 */
export interface QuotaBatchPlan {
  resolved: { org: number; dept: number; user: number };
  rules: QuotaBatchResolved[];
  skipped: QuotaBatchSkipped[];
}

export interface QuotaBatchResult extends QuotaBatchPlan {
  dryRun: boolean;
  /** 实际写入的规则数（dryRun 恒为 0）。 */
  applied: number;
  /** 写入后当场触发的告警数；undefined = 复评失败（不影响已写入的规则）。 */
  triggeredAlerts?: number;
}

const scopeKey = (scopeType: QuotaScopeType, scopeId: string | null): string =>
  `${scopeType}:${scopeId ?? ""}`;

/**
 * 解析目标清单（不写库）。
 *
 * 展开顺序即 `targets` 顺序；去重后超过 `MAX_BATCH_TARGETS` 直接抛错 ——
 * 在写任何东西之前就挡住，避免"写了一半才发现超限"的中间态。
 */
export async function planQuotaBatch(db: IdentityDb, input: QuotaBatchInput): Promise<QuotaBatchPlan> {
  /**
   * 第一道闸（便宜）：按**请求的目标条数**挡。手滑粘了 5000 个 uid 时，
   * 不该等到查完库才发现超限 —— 那时已经付过一轮查询代价了。
   */
  const requested = input.targets.reduce(
    (n, t) => n + (t.scopeType === "org" ? 1 : (t.scopeIds?.length ?? 0)),
    0,
  );
  if (requested > MAX_BATCH_TARGETS) {
    throw new QuotaBatchError(
      `单次最多批量 ${MAX_BATCH_TARGETS} 个目标（本次请求 ${requested} 个），请分批或改按部门下发`,
    );
  }

  const seen = new Set<string>();
  const rules: QuotaBatchResolved[] = [];
  const skipped: QuotaBatchSkipped[] = [];

  const add = (scopeType: QuotaScopeType, scopeId: string | null): void => {
    const key = scopeKey(scopeType, scopeId);
    if (seen.has(key)) return; // 请求内去重：先到先得
    seen.add(key);
    rules.push({ scopeType, scopeId, existed: false });
  };

  for (const target of input.targets) {
    if (target.scopeType === "org") {
      add("org", null);
      continue;
    }
    const ids = (target.scopeIds ?? []).map((s) => String(s).trim()).filter((s) => s.length > 0);
    if (ids.length === 0) {
      skipped.push({ scopeType: target.scopeType, scopeId: null, reason: "未提供 scopeIds" });
      continue;
    }

    if (target.scopeType === "dept") {
      // 形状校验放在解析里（库层 scope_id 是 TEXT，挡掉手滑的字母/负数）
      const bad = ids.filter((s) => !/^\d+$/.test(s) || Number(s) <= 0);
      for (const b of bad) skipped.push({ scopeType: "dept", scopeId: b, reason: "部门 id 需为正整数" });
      const deptIds = [...new Set(ids.filter((s) => /^\d+$/.test(s) && Number(s) > 0).map(Number))];
      const existing = await existingDeptIds(db, deptIds);
      for (const id of deptIds) {
        if (!existing.has(id)) {
          skipped.push({ scopeType: "dept", scopeId: String(id), reason: "部门不存在" });
          continue;
        }
        if (target.expandUsers !== true) {
          // 部门本身一条规则：子树覆盖由解析语义自动完成（§2 Q7），不必展开
          add("dept", String(id));
          continue;
        }
        const subtree = await deptSubtreeIds(db, id);
        const uids = await listActiveUidsInDepts(db, subtree);
        if (uids.length === 0) {
          skipped.push({ scopeType: "dept", scopeId: String(id), reason: "该部门子树下没有在用用户" });
          continue;
        }
        for (const uid of uids) add("user", uid);
      }
      continue;
    }

    // user：显式 uid 列表（区分"不存在"与"已停用"—— 两者管理员要做的动作不同）
    const uids = [...new Set(ids)];
    const status = await uidStatusMap(db, uids);
    for (const uid of uids) {
      const s = status.get(uid);
      if (s === undefined) {
        skipped.push({ scopeType: "user", scopeId: uid, reason: "用户不存在" });
        continue;
      }
      if (s !== "active") {
        skipped.push({ scopeType: "user", scopeId: uid, reason: "用户已停用" });
        continue;
      }
      add("user", uid);
    }
  }

  if (rules.length > MAX_BATCH_TARGETS) {
    throw new QuotaBatchError(
      `单次最多批量 ${MAX_BATCH_TARGETS} 个目标（本次将写入 ${rules.length} 个），请分批或改按部门下发`,
    );
  }
  // 新建/覆盖标注：一次查询拿全库 scope 键（规则数是百级，比逐条查便宜）
  const existingRules = await existingRuleScopeKeys(db);
  for (const r of rules) r.existed = existingRules.has(scopeKey(r.scopeType, r.scopeId));

  return {
    resolved: {
      org: rules.filter((r) => r.scopeType === "org").length,
      dept: rules.filter((r) => r.scopeType === "dept").length,
      user: rules.filter((r) => r.scopeType === "user").length,
    },
    rules,
    skipped,
  };
}

/**
 * 批量写入：先预览（同一解析路径，保证"预览到什么就写什么"）再逐条 upsert。
 *
 * 写完后立即复评告警：把额度**调低**时要当场触发（否则要等下一次模型调用才有人发现
 * 已经超了）。按规则维度一遍过（`evaluateRules`），不是逐用户 N×M；
 * 复评失败只记 warn，不回滚已写入的规则 —— 规则是主效果，告警是衍生效果。
 */
export async function applyQuotaBatch(
  db: IdentityDb,
  input: QuotaBatchInput,
  updatedBy: string,
  webhookUrl?: string,
): Promise<QuotaBatchResult> {
  const plan = await planQuotaBatch(db, input);
  const saved: QuotaRule[] = [];
  for (const r of plan.rules) {
    saved.push(
      await upsertQuotaRule(
        db,
        {
          scopeType: r.scopeType,
          scopeId: r.scopeId,
          limitTokens: input.limitTokens ?? null,
          limitCost: input.limitCost ?? null,
          alertThresholds: input.alertThresholds,
          action: input.action,
          enabled: input.enabled,
        },
        updatedBy,
      ),
    );
  }
  let triggeredAlerts: number | undefined;
  try {
    const { newAlerts } = await evaluateRules(db, saved, currentPeriod(), webhookUrl);
    triggeredAlerts = newAlerts.length;
  } catch (e) {
    console.warn(`[quota] 批量下发后复评失败（不影响已写入的规则）：${e instanceof Error ? e.message : String(e)}`);
  }
  return { ...plan, dryRun: false, applied: saved.length, triggeredAlerts };
}
