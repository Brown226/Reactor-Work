/**
 * 额度执行门（额度分配 P3）：调用前检查 → `block` 规则超限则 429 + 写 `policy_block` 审计。
 *
 * ## 开关语义（方案 §2 Q2）
 *
 * `REACTOR_QUOTA_ENFORCE=false`（默认）时本模块**完全不介入**：不查库、不改回执、
 * 不写审计 —— 与改造前逐字节等价（回归可证）。只有显式开启后才对带主体的身份令牌执行。
 *
 * ## 为什么 dev token 不检查
 *
 * 沿用 `proxy.ts` 既有纪律（可见范围、模型白名单都对 dev token 放行）：它是本地/e2e/探针
 * 通道，没有主体概念，拦它会让所有冒烟与本地开发立刻不可用。system 调用**照常计量**
 * （计入组织额度，见 Q5），只是不做阻断判定。
 *
 * ## 性能与并发（方案 §5-P3 已拍板）
 *
 * 每次调用前做一次规则解析 + 各 scope 的账本聚合（本部署量级下是无索引走查的月度求和，
 * 毫秒级；不引入物化计数器）。**不做在途预留**：并发高峰允许少量超发（后置计数），
 * 写在 §7 已知边界里，预留量列 P5。
 *
 * ## 失败语义
 *
 * 检查自身失败（库抖动/规则读不出）**一律放行**并记 error 日志 ——
 * 宁可放行不可误杀（与 fail-open 一致）。
 */

import { randomUUID } from "node:crypto";

import { evaluateQuotaFor, type RuleUsage } from "../metering/quota-eval.js";
import type { IdentityDb } from "../identity/db.js";

export interface QuotaGateDecision {
  blocked: boolean;
  /** 命中的 block 规则（多个时取第一个用于回执，全部写进审计 summary） */
  blocking: RuleUsage[];
}

export interface QuotaGate {
  /**
   * 检查是否应当阻断。`uid` 为 null（dev token）时直接放行。
   * 永远不抛：内部失败按放行处理并记日志。
   */
  check(args: { uid: string | null; deptId: number | null; model: string | null }): Promise<QuotaGateDecision>;
  /** 写一条 policy_block 审计（best-effort，异步，不 await）。 */
  recordBlock(args: {
    uid: string;
    deptId: number | null;
    model: string | null;
    shape: string;
    blocking: RuleUsage[];
  }): void;
}

export function createQuotaGate(opts: {
  db: IdentityDb | null;
  enabled: boolean;
  log?: (level: "info" | "error", message: string) => void;
}): QuotaGate {
  const log =
    opts.log ??
    ((level, message) => {
      if (level === "error") console.error(message);
      else console.log(message);
    });

  return {
    async check(args) {
      // 未接库 / 开关关闭 / 无主体（dev token）→ 直接放行，零查询
      if (!opts.db || !opts.enabled || args.uid === null) return { blocked: false, blocking: [] };
      try {
        const evaluation = await evaluateQuotaFor(opts.db, { uid: args.uid, deptId: args.deptId });
        return { blocked: evaluation.blocking.length > 0, blocking: evaluation.blocking };
      } catch (err) {
        // 放行 + 可见（宁可超发也不能因额度检查故障而全网不可用）
        log("error", `[quota] 额度检查失败，本次放行：${err instanceof Error ? err.message : String(err)}`);
        return { blocked: false, blocking: [] };
      }
    },

    recordBlock(args) {
      if (!opts.db) return;
      const scopes = args.blocking.map((b) => `${b.rule.scopeType}:${b.rule.scopeId ?? "-"}`).join(",");
      const first = args.blocking[0]!;
      const summary = `额度阻断：${scopes}（用量 ${Math.round(first.tokens)} / 上限 ${first.rule.limitTokens ?? "-"}）`;
      /**
       * 直接插 `audit_event`（不经 `insertAuditBatch`）：
       *  · 那条路径绑定在 identity 进程的令牌解析上下文里（AuditActor + 批量校验），
       *    网关侧没有那个上下文；
       *  · 这里只需要一条最小事实行，且 **event_id 由网关生成**（幂等键语义不变）。
       * `action='policy_block'` / `error_code='quota.exceeded'` 与审计域的词表一致。
       */
      void opts.db.pool
        .query(
          `INSERT INTO audit_event (event_id, ts, uid, dept_id, dept_path, action, target, outcome, error_code, summary, model)
           VALUES ($1, now(), $2, $3, NULL, 'policy_block', $4, 'denied', 'quota.exceeded', $5, $6)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            `gw-quota-block-${randomUUID()}`,
            args.uid,
            args.deptId,
            `quota_rule:${first.rule.id}`,
            summary.slice(0, 200), // 与 MAX_AUDIT_SUMMARY_CHARS 对齐（表上还有 500 字 CHECK）
            args.model,
          ],
        )
        .catch((err: unknown) => {
          log("error", `[quota] policy_block 审计写入失败：${err instanceof Error ? err.message : String(err)}`);
        });
    },
  };
}

/** 429 回执（形状见方案 §4.4）。 */
export function quotaExceededResponse(blocking: RuleUsage[]): {
  error: { type: string; message: string; scope: string; scopeId: string | null; limit: number | null; used: number; violations: Array<{ scope: string; scopeId: string | null; limit: number | null; used: number }> };
} {
  const first = blocking[0]!;
  const scopeLabel = first.rule.scopeType === "org" ? "组织" : first.rule.scopeType === "dept" ? "部门" : "个人";
  return {
    error: {
      type: "quota_exceeded",
      message: `已达${scopeLabel}额度上限，请联系管理员调整额度`,
      scope: first.rule.scopeType,
      scopeId: first.rule.scopeId,
      limit: first.rule.limitTokens,
      used: Math.round(first.tokens),
      // 命中的全部规则（多条时调用方/管理员能看到是哪个维度卡住的）
      violations: blocking.map((b) => ({
        scope: b.rule.scopeType,
        scopeId: b.rule.scopeId,
        limit: b.rule.limitTokens,
        used: Math.round(b.tokens),
      })),
    },
  };
}
