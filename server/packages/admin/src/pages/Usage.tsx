// 用量与额度（M9 / 管理台「模型与网关」组）：部门×模型×用户×日的用量报表 + 月度额度 + 阈值告警记录。
// 数据真源：GET /desktop/usage/summary（按角色收敛）+ GET/PUT /desktop/policy（额度在策略里）
//          + GET /admin/quota-alerts（已触发的阈值告警，含是否已外发）。
// 图表用纯 CSS 条形（不引入额外运行时依赖；数值来自服务端，不做前端推算）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, BellRinging, CalendarBlank, PencilSimple, Users } from "@phosphor-icons/react";
import {
  quotaAlertsApi,
  quotaRulesApi,
  reconciliationApi,
  usageApi,
  type QuotaAlertsResult,
  type QuotaBatchResult,
  type QuotaBatchTarget,
  type QuotaRule,
  type ReconciliationResult,
  type UsageGroupBy,
  type UsageSummaryResult,
  type UsageSummaryRow,
} from "../services/audit";
import { deptsApi } from "../services/identity-resources";
import type { DeptNode } from "../types";

/** 部门树拍平（供额度面板的下拉与 scope 标签查名用）。 */
function flattenDepts(tree: DeptNode[]): Array<{ id: number; path: string }> {
  const out: Array<{ id: number; path: string }> = [];
  const walk = (nodes: DeptNode[], prefix: string): void => {
    for (const n of nodes) {
      const path = prefix ? `${prefix}/${n.name}` : n.name;
      out.push({ id: n.id, path });
      if (n.children?.length) walk(n.children, path);
    }
  };
  walk(tree, "");
  return out;
}
import { useAuthStore } from "../stores/auth";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { UsageTrend } from "../components/UsageTrend";
import { UsageHeatmap } from "../components/UsageHeatmap";
import { nf, money } from "../lib/usage-format";

const GROUPS: Array<{ key: UsageGroupBy; label: string }> = [
  { key: "dept", label: "按部门" },
  { key: "model", label: "按模型" },
  { key: "user", label: "按用户" },
  { key: "day", label: "按日期" },
];

type RangeKey = "today" | "7d" | "30d" | "month";
const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "today", label: "今日" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "month", label: "本月" },
];

const startOfMonth = (): Date => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

function rangeOf(key: RangeKey): { from: Date; to: Date } {
  const to = new Date();
  if (key === "today") {
    const from = new Date(to);
    from.setHours(0, 0, 0, 0);
    return { from, to };
  }
  if (key === "month") return { from: startOfMonth(), to };
  const days = key === "30d" ? 30 : 7;
  return { from: new Date(to.getTime() - days * 24 * 3600 * 1000), to };
}

// nf / money 已抽到 lib/usage-format.ts —— 图表组件与表格共用同一口径，避免数字展示漂移。

/** 纯 CSS 条形：宽度按占当前最大值的比例。 */
function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)" }} />
      </div>
      <span className="cell-sub mono" style={{ minWidth: 46, textAlign: "right" }}>{nf(value)}</span>
    </div>
  );
}

export function Usage() {
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === "platform_admin";

  const [groupBy, setGroupBy] = useState<UsageGroupBy>("dept");
  const [range, setRange] = useState<RangeKey>("7d");
  const [data, setData] = useState<UsageSummaryResult | null>(null);
  /** 热力图固定看近 365 天，与上方时间筛选解耦（时间筛选只作用于趋势图与表格）。 */
  const [heatRows, setHeatRows] = useState<UsageSummaryRow[] | null>(null);
  const [rules, setRules] = useState<QuotaRule[]>([]);
  const [depts, setDepts] = useState<Array<{ id: number; path: string }>>([]);
  const [alerts, setAlerts] = useState<QuotaAlertsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [editQuota, setEditQuota] = useState(false);
  // 编辑中的规则（null = 新建）；维度/上限/阈值/动作
  const [draft, setDraft] = useState<{
    scopeType: "org" | "dept" | "user";
    scopeId: string;
    limitInput: string;
    thresholdInput: string;
    action: "warn" | "block";
  }>({ scopeType: "org", scopeId: "", limitInput: "", thresholdInput: "80, 100", action: "warn" });
  const [busy, setBusy] = useState(false);
  const [recon, setRecon] = useState<ReconciliationResult | null>(null);

  /* ---------------- 批量分配（§11.7） ---------------- */
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchDraft, setBatchDraft] = useState<{
    mode: "org" | "dept" | "deptUsers" | "users";
    deptId: string;
    uidText: string;
    limitInput: string;
    thresholdInput: string;
    action: "warn" | "block";
  }>({ mode: "deptUsers", deptId: "", uidText: "", limitInput: "", thresholdInput: "80, 100", action: "warn" });
  const [batchPreview, setBatchPreview] = useState<QuotaBatchResult | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  /** 对话框草稿 → 批量 targets（uid 按逗号/空白/换行分割，与服务端解析容错一致）。 */
  const batchTargets = (d: typeof batchDraft): QuotaBatchTarget[] => {
    if (d.mode === "org") return [{ scopeType: "org" }];
    if (d.mode === "dept") return d.deptId ? [{ scopeType: "dept", scopeIds: [d.deptId] }] : [];
    if (d.mode === "deptUsers") {
      return d.deptId ? [{ scopeType: "dept", scopeIds: [d.deptId], expandUsers: true }] : [];
    }
    const uids = d.uidText.split(/[,，\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    return uids.length > 0 ? [{ scopeType: "user", scopeIds: uids }] : [];
  };

  const loadReconciliation = async (): Promise<void> => {
    try {
      setRecon(await reconciliationApi.get());
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    const { from, to } = rangeOf(range);
    try {
      const summary = await usageApi.summary({ groupBy, from: from.toISOString(), to: to.toISOString() });
      setData(summary);
      if (isAdmin) {
        // 额度规则（管理面）：失败不阻断报表（例如后端尚未升级）
        const [ruleRes, alertRes, deptRes] = await Promise.all([
          quotaRulesApi.list().catch(() => null),
          quotaAlertsApi.list().catch(() => null),
          deptsApi.tree().catch(() => null),
        ]);
        if (ruleRes) setRules(ruleRes.rules);
        setAlerts(alertRes);
        if (deptRes) setDepts(flattenDepts(deptRes.tree));
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [groupBy, range, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 热力图数据：固定 365 天、groupBy=day，**与时间筛选无关**。
   *
   * 为什么不复用 `data.rows`：上方筛选默认是「近 7 天」，而日历热力图要覆盖一整年；
   * 也不能把筛选改成 365 天——表格会一次铺出几百行。所以单独取一次，只在挂载时拉。
   * 失败不打断主报表（热力图是补充视图），静默留空即可。
   */
  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 3600 * 1000);
    usageApi
      .summary({ groupBy: "day", from: from.toISOString(), to: to.toISOString() })
      .then((r) => setHeatRows(r.rows))
      .catch(() => setHeatRows([]));
  }, []);

  const rows = data?.rows ?? [];
  const maxTokens = useMemo(() => rows.reduce((m, r) => Math.max(m, r.totalTokens), 0), [rows]);
  const totals = data?.totals;

  /** 打开编辑：scopeType=org/dept/user；已有规则时回填。 */
  const openQuota = (rule?: QuotaRule): void => {
    if (rule) {
      setDraft({
        scopeType: rule.scopeType,
        scopeId: rule.scopeId ?? "",
        limitInput: rule.limitTokens ? String(rule.limitTokens) : "",
        thresholdInput: (rule.alertThresholds ?? [80, 100]).join(", "),
        action: rule.action,
      });
    } else {
      setDraft({ scopeType: "org", scopeId: "", limitInput: "", thresholdInput: "80, 100", action: "warn" });
    }
    setEditQuota(true);
  };

  /**
   * 解析 token 上限输入（支持单位后缀）。
   *
   * 为什么支持：额度动辄百万级，`5000000` 难读难打；而规则列表早就在用 K/M 展示，
   * 输入却只认裸数字 —— 用户要么数零要么先心算。接受 `5M` / `500K` / `1.5M` / `500万` / 裸数字。
   *
   * ⚠ 与服务端 `metering/quota-routes.ts` 的 `parseTokenLimit` 同口径（两包不共享代码），
   *   改动时两边同步；**服务端是权威**（保存后回显的是服务端换算值）。
   */
  const TOKEN_UNITS: Record<string, number> = { K: 1_000, M: 1_000_000, B: 1_000_000_000, 万: 10_000 };
  const parseTokenInput = (raw: string): number | null => {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(K|M|B|万)?$/i);
    if (!m) return null;
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const scale = m[2] ? (TOKEN_UNITS[m[2].toUpperCase()] ?? 1) : 1;
    const out = Math.floor(value * scale);
    return out > 0 ? out : null;
  };
  // 输入实时换算预览（让用户在保存前就看到"5M = 5,000,000"，不靠猜）
  const limitPreview = parseTokenInput(draft.limitInput);
  // 批量对话框的同款预览（各自独立：两个对话框的草稿互不影响）
  const batchLimitPreview = parseTokenInput(batchDraft.limitInput);

  const saveQuota = async (): Promise<void> => {
    setBusy(true);
    try {
      const limitNum = parseTokenInput(draft.limitInput);
      if (limitNum === null) {
        toast.error("月度上限需为正数，可带单位：5M / 500K / 500万 / 5000000");
        return;
      }
      if (draft.scopeType !== "org" && draft.scopeId.trim() === "") {
        toast.error("请选择/填写该维度的对象");
        return;
      }
      const thresholds = draft.thresholdInput
        .split(/[,，\s]+/)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
      const res = await quotaRulesApi.put({
        scopeType: draft.scopeType,
        scopeId: draft.scopeType === "org" ? null : draft.scopeId.trim(),
        limitTokens: limitNum,
        alertThresholds: thresholds.length > 0 ? thresholds : [80, 100],
        action: draft.action,
      });
      setRules((prev) => {
        // upsert 语义：同 (scopeType, scopeId) 覆盖
        const rest = prev.filter(
          (r) => !(r.scopeType === res.rule.scopeType && r.scopeId === res.rule.scopeId),
        );
        return [...rest, res.rule].sort((a, b) => a.scopeType.localeCompare(b.scopeType));
      });
      const newAlerts = res.quotaAlerts ?? [];
      toast.ok(newAlerts.length > 0 ? `额度已保存（当场触发 ${newAlerts.length} 条告警）` : "额度已保存");
      setEditQuota(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeRule = async (rule: QuotaRule): Promise<void> => {
    setBusy(true);
    try {
      await quotaRulesApi.del(rule.id);
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      toast.ok("额度已删除");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** scope 标签（管理台展示用）。 */
  const scopeLabel = (r: QuotaRule): string => {
    if (r.scopeType === "org") return "组织";
    if (r.scopeType === "dept") {
      const d = depts.find((x) => String(x.id) === r.scopeId);
      return `部门 · ${d?.path ?? r.scopeId}`;
    }
    return `用户 · ${r.scopeId}`;
  };

  /**
   * 批量预览（dryRun）：把"将写入什么"在应用前亮出来。
   *
   * 为什么必须预览：批量最大的风险是**无声扩大影响面** —— 选错部门就是几百条规则。
   * 预览与写入走同一端点、同一解析路径（服务端保证），所以预览准的就是将写的。
   *
   * 入参显式传草稿（不读 state）：让调用方（effect / 按钮）各自决定何时预览。
   */
  const runBatchPreview = useCallback(async (d: typeof batchDraft): Promise<void> => {
    const targets = batchTargets(d);
    const limitNum = parseTokenInput(d.limitInput);
    if (targets.length === 0 || limitNum === null) {
      setBatchPreview(null);
      return;
    }
    setBatchBusy(true);
    try {
      const thresholds = d.thresholdInput
        .split(/[,，\s]+/)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
      setBatchPreview(
        await quotaRulesApi.batch({
          targets,
          limitTokens: limitNum,
          alertThresholds: thresholds.length > 0 ? thresholds : [80, 100],
          action: d.action,
          dryRun: true,
        }),
      );
    } catch (e) {
      toast.error((e as Error).message);
      setBatchPreview(null);
    } finally {
      setBatchBusy(false);
    }
  }, []);

  // 打开对话框 / 切换分配对象时自动预览；上限与阈值改动后点「预览」手动刷新
  // （依赖只取 mode+deptId：输入上限时每敲一个字符就发一次请求没有意义）。
  const batchPreviewKey = `${batchDraft.mode}|${batchDraft.deptId}`;
  useEffect(() => {
    if (!batchOpen) return;
    void runBatchPreview(batchDraft);
  }, [batchOpen, batchPreviewKey, runBatchPreview]);

  /** 批量应用：写入后整体刷新规则列表（批量后本地合并 N 条规则太容易出错）。 */
  const applyBatch = async (): Promise<void> => {
    const targets = batchTargets(batchDraft);
    const limitNum = parseTokenInput(batchDraft.limitInput);
    if (targets.length === 0) {
      toast.error("请选择分配对象");
      return;
    }
    if (limitNum === null) {
      toast.error("月度上限需为正数，可带单位：5M / 500K / 500万 / 5000000");
      return;
    }
    setBatchBusy(true);
    try {
      const thresholds = batchDraft.thresholdInput
        .split(/[,，\s]+/)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
      const res = await quotaRulesApi.batch({
        targets,
        limitTokens: limitNum,
        alertThresholds: thresholds.length > 0 ? thresholds : [80, 100],
        action: batchDraft.action,
      });
      const parts = [`已写入 ${res.applied} 条规则`];
      if (res.triggeredAlerts) parts.push(`当场触发 ${res.triggeredAlerts} 条告警`);
      if (res.skipped.length > 0) parts.push(`跳过 ${res.skipped.length} 条（见预览）`);
      toast.ok(parts.join("，"));
      setBatchOpen(false);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <div>
      <PageHead
        title="用量与额度"
        desc="按组织/部门/用户分配额度并查看当期用量；报表与告警均取计量账本（网关权威）。"
        /* 数据范围徒标（枚举）：管理员=全量默认态 ⇒ all（不渲染） */
        scope={isAdmin ? "all" : "self"}
      />

      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <div className="seg">
          {GROUPS.map((g) => (
            <button key={g.key} className={groupBy === g.key ? "on" : ""} onClick={() => setGroupBy(g.key)}>
              {g.label}
            </button>
          ))}
        </div>
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r.key} className={range === r.key ? "on" : ""} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void load()}>
          <ArrowsClockwise size={14} /> 刷新
        </Button>
      </div>

      {/* ① 额度分配（本页主任务，置顶）：每条规则带当期用量进度条，快超的一眼可见 */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <div>
            <h3>额度分配</h3>
            <div className="sub">三类规则叠加生效，任一「阻断」规则超限即拒绝调用。</div>
          </div>
          <div className="right">
            {isAdmin ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => {
                    setBatchPreview(null);
                    setBatchOpen(true);
                  }}
                >
                  <Users size={14} /> 批量分配
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openQuota()}>
                  <PencilSimple size={14} /> 新建额度
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {rules.length === 0 ? (
          <div className="empty" style={{ padding: "16px 0" }}>
            <div className="t">未配置任何额度</div>
            <div className="s">当前不限量。新建后达到阈值会告警；「阻断」规则还需服务端开启 REACTOR_QUOTA_ENFORCE 才真正拦截。</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {rules.map((r) => {
              const u = r.usage ?? null;
              const pctValue = u?.tokenPercent ?? null;
              const over = pctValue !== null && pctValue >= Math.max(...(r.alertThresholds.length ? r.alertThresholds : [100]));
              const barPct = pctValue === null ? 0 : Math.min(100, pctValue);
              return (
                <div
                  key={`${r.scopeType}:${r.scopeId ?? "org"}:${r.id}`}
                  style={{ display: "grid", gridTemplateColumns: "minmax(150px, 220px) 1fr auto", gap: 12, alignItems: "center", padding: "10px 0", borderTop: "1px solid var(--hairline)" }}
                >
                  {/* 维度名 */}
                  <span style={{ fontWeight: 500 }}>{scopeLabel(r)}</span>

                  {/* 进度条 + 已用/上限 */}
                  <div style={{ minWidth: 0 }}>
                    {r.limitTokens === null ? (
                      // 未设上限（旧配置合成项的常见形态）：只报已用，不给假进度
                      <span className="cell-sub mono">
                        已用 {u ? nf(u.usedTokens) : "0"} tokens · 未设上限
                      </span>
                    ) : (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ flex: 1, height: 8, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden", position: "relative" }}>
                            <div
                              style={{
                                width: `${barPct}%`,
                                height: "100%",
                                background: over ? "var(--danger)" : "var(--accent)",
                              }}
                            />
                            {/* 阈值刻度线：让"快到线了"可读 */}
                            {r.alertThresholds.map((t) => (
                              <div
                                key={t}
                                title={`告警阈值 ${t}%`}
                                style={{ position: "absolute", left: `${t}%`, top: 0, bottom: 0, width: 1, background: "var(--hairline)" }}
                              />
                            ))}
                          </div>
                          <span className="cell-sub mono" style={{ minWidth: 130, textAlign: "right" }}>
                            {/* usage 缺失时按 0 显示（而不是「—」）：刚保存的规则用量就是 0，
                                「—」会让用户以为没取到数。真取不到时进度条为空、数字 0。 */}
                            {u ? nf(u.usedTokens) : "0"} / {nf(r.limitTokens)}
                            {pctValue !== null ? ` · ${pctValue.toFixed(0)}%` : ""}
                          </span>
                        </div>
                        <div className="cell-sub" style={{ marginTop: 2 }}>
                          阈值 {r.alertThresholds.join("% / ")}%
                          {r.limitCost !== null ? ` · 费用上限 ¥${r.limitCost}` : ""}
                        </div>
                      </>
                    )}
                  </div>

                  {/* 动作徽标 + 操作 */}
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <ToneBadge tone={r.action === "block" ? "danger" : "info"}>{r.action === "block" ? "阻断" : "仅告警"}</ToneBadge>
                    {isAdmin ? (
                      <>
                        <Button size="sm" variant="outline" onClick={() => openQuota(r)} disabled={r.synthesized}>编辑</Button>
                        <Button size="sm" variant="outline" onClick={() => void removeRule(r)} disabled={r.synthesized || busy}>删除</Button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {/* 旧配置迁移提示（替代原来那枚拥挤的徽标） */}
            {rules.some((r) => r.synthesized) ? (
              <div className="cell-sub" style={{ marginTop: 6 }}>
                来自旧配置的组织额度（未设上限）仅作展示；点「新建额度」保存后即迁移为正式规则。
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* 本期告警（有才显示；紧挨额度分配，因为它是"谁快超了"的结论） */}
      {alerts && alerts.alerts.length > 0 ? (
        <div className="panel" style={{ marginBottom: 16, background: "var(--warn-soft)", borderColor: "transparent" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--warn)", fontWeight: 500 }}>
            <BellRinging size={15} /> 本期已触发 {alerts.alerts.length} 条额度告警
            <span className="cell-sub" style={{ marginLeft: 4 }}>
              {alerts.webhookConfigured ? "（已配置外发通道）" : "（未配置外发：设置 REACTOR_QUOTA_WEBHOOK_URL 即可推送）"}
            </span>
          </div>
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8 }}>
            {alerts.alerts.map((a) => (
              <ToneBadge key={a.id} tone={a.level === "critical" ? "danger" : "warn"}>
                {a.period} · {a.scopeType === "org" ? "组织" : a.scopeType === "dept" ? `部门 ${a.scopeId}` : `用户 ${a.scopeId}`} · 阈值 {a.threshold}%（已达 {a.percent}%）
                {a.notified ? " · 已外发" : alerts.webhookConfigured ? (a.notifyError ? ` · 外发失败：${a.notifyError}` : " · 待外发") : ""}
              </ToneBadge>
            ))}
          </div>
          <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--ink-2)" }}>
            告警只提示；是否拦截由规则的「仅告警/阻断」与服务端 REACTOR_QUOTA_ENFORCE 开关共同决定。
          </div>
        </div>
      ) : null}

      {/* ② 本期概览（紧凑一行，替代原来的 4 张大卡片） */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <div>
            <h3>本期概览</h3>
            <div className="sub">统计范围随上方时间筛选；口径为计量账本（网关权威）。</div>
          </div>
        </div>
        {totals && totals.calls > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "baseline", padding: "4px 0 2px" }}>
            <span><span className="cell-sub">调用 </span><b className="mono">{totals.calls}</b></span>
            <span><span className="cell-sub">总 tokens </span><b className="mono">{nf(totals.totalTokens)}</b>
              <span className="cell-sub">（入 {nf(totals.inputTokens)} · 出 {nf(totals.outputTokens)}）</span></span>
            <span><span className="cell-sub">缓存 </span><b className="mono">{nf((totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0))}</b>
              <span className="cell-sub">（读 {nf(totals.cacheReadTokens)} · 写 {nf(totals.cacheWriteTokens)}）</span></span>
            <span><span className="cell-sub">费用 </span><b className="mono">{money(totals.cost)}</b></span>
          </div>
        ) : (
          <div className="cell-sub" style={{ padding: "4px 0 2px" }}>
            {loading ? "加载中…" : "该区间暂无用量数据（企业网关调用经网关后自动计入账本）"}
          </div>
        )}
      </div>

      {/* 日历热力图：固定看近 365 天（不受时间筛选影响），位置在本期概览之后、趋势图之前 ——
          从「一年宏观」到「近 30 天细节」逐层收窄。 */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <div>
            <h3>Token 活动</h3>
            <div className="sub">近 12 个月每日 token 消耗（输入 + 输出），颜色越深用量越高。</div>
          </div>
          <div className="right">
            <ToneBadge tone="neutral">
              {heatRows === null ? "加载中" : `活跃 ${heatRows.length} 天`}
            </ToneBadge>
          </div>
        </div>
        {heatRows === null ? (
          <div className="cell-sub" style={{ padding: "8px 0" }}>加载中…</div>
        ) : heatRows.length === 0 ? (
          <div className="cell-sub" style={{ padding: "8px 0" }}>近 12 个月暂无用量数据</div>
        ) : (
          <UsageHeatmap rows={heatRows} />
        )}
      </div>

      {/* 逐日趋势：只在「按日期」分组显示。
          非时间分组（部门/模型/用户）不再画 Top 排行条 —— 下方表格的「占比」列已经是同口径的
          排序条形，两块并排只是同一数据画两遍（2026-10-19 按大王要求删除）。 */}
      {groupBy === "day" && rows.length > 0 ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <div>
              <h3>逐日趋势</h3>
              <div className="sub">按日聚合的 token 用量；悬停查看当日读数。</div>
            </div>
          </div>
          <UsageTrend rows={rows} />
        </div>
      ) : null}

      <div className="tablewrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{GROUPS.find((g) => g.key === groupBy)?.label.replace("按", "") ?? "分组"}</TableHead>
              <TableHead className="num-cell">调用</TableHead>
              <TableHead>占比（总 tokens）</TableHead>
              <TableHead className="num-cell">输入</TableHead>
              <TableHead className="num-cell">输出</TableHead>
              <TableHead className="num-cell">费用</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              <TableRow><TableCell colSpan={6}><SkeletonRows /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="empty">
                    <CalendarBlank size={20} />
                    <div className="t">该区间暂无用量数据</div>
                    <div className="s">企业网关的模型调用经网关后自动计入账本；此页为空说明该区间确无调用</div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell>
                    <div className="td-main">
                      <span className="ava">{groupBy === "user" ? <Users size={13} /> : (r.key.slice(0, 1) || "?")}</span>
                      <div className="cell-title mono">{r.key}</div>
                    </div>
                  </TableCell>
                  <TableCell className="num-cell mono">{r.calls}</TableCell>
                  <TableCell><Bar value={r.totalTokens} max={maxTokens} /></TableCell>
                  <TableCell className="num-cell mono">{nf(r.inputTokens)}</TableCell>
                  <TableCell className="num-cell mono">{nf(r.outputTokens)}</TableCell>
                  <TableCell className="num-cell mono">{money(r.cost)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editQuota} onOpenChange={(o) => !o && setEditQuota(false)}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>额度规则</DialogTitle>
          </DialogHeader>
          <div className="modal-body">
            <div className="field">
              <Label htmlFor="q-scope">维度</Label>
              <select
                id="q-scope"
                className="input"
                value={draft.scopeType}
                onChange={(e) => setDraft((d) => ({ ...d, scopeType: e.target.value as "org" | "dept" | "user", scopeId: "" }))}
              >
                <option value="org">组织（全体）</option>
                <option value="dept">部门（含其子树）</option>
                <option value="user">用户</option>
              </select>
              <span className="hint">三类规则叠加生效：任一 block 规则超限即拒绝调用；组织额度包含 KB 向量化等系统调用。</span>
            </div>
            {draft.scopeType === "dept" ? (
              <div className="field">
                <Label htmlFor="q-dept">部门</Label>
                <select
                  id="q-dept"
                  className="input"
                  value={draft.scopeId}
                  onChange={(e) => setDraft((d) => ({ ...d, scopeId: e.target.value }))}
                >
                  <option value="">请选择部门</option>
                  {depts.map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      {d.path}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {draft.scopeType === "user" ? (
              <div className="field">
                <Label htmlFor="q-uid">用户 uid</Label>
                <Input
                  id="q-uid"
                  value={draft.scopeId}
                  placeholder="域账号 uid（与「组织与用户」页一致）"
                  onChange={(e) => setDraft((d) => ({ ...d, scopeId: e.target.value }))}
                />
              </div>
            ) : null}
            <div className="field">
              <Label htmlFor="q-limit">月度 token 上限</Label>
              <Input
                id="q-limit"
                value={draft.limitInput}
                placeholder="如 5M 或 5000000"
                onChange={(e) => setDraft((d) => ({ ...d, limitInput: e.target.value }))}
              />
              {/* 实时换算预览：保存前就看到"5M = 5,000,000"，不靠猜；解析失败时给可操作提示 */}
              {draft.limitInput.trim() === "" ? null : limitPreview === null ? (
                <span className="hint" style={{ color: "var(--danger)" }}>
                  无法识别：支持 5M / 500K / 500万 / 5000000（单位不区分大小写，可与数字间留空格）
                </span>
              ) : (
                <span className="hint">
                  = {limitPreview.toLocaleString()} tokens
                </span>
              )}
              <span className="hint">必填。用量口径为计量账本（网关权威，含缓存分项按四段价折算）。</span>
            </div>
            <div className="field">
              <Label htmlFor="q-th">告警阈值（%）</Label>
              <Input
                id="q-th"
                value={draft.thresholdInput}
                placeholder="80, 100"
                onChange={(e) => setDraft((d) => ({ ...d, thresholdInput: e.target.value }))}
              />
              <span className="hint">逗号分隔，1–100。达到阈值发告警（幂等：同周期同 scope 同阈值只发一次）。</span>
            </div>
            <div className="field">
              <Label htmlFor="q-action">超限动作</Label>
              <select
                id="q-action"
                className="input"
                value={draft.action}
                onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value as "warn" | "block" }))}
              >
                <option value="warn">仅告警（不阻断）</option>
                <option value="block">阻断（网关返回 429）</option>
              </select>
              <span className="hint">
                「阻断」需要服务端开启 REACTOR_QUOTA_ENFORCE=true 才会真正生效；关闭时只告警。
              </span>
            </div>
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setEditQuota(false)}>取消</Button>
            <Button variant="default" disabled={busy} onClick={() => void saveQuota()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 批量分配对话框（§11.7）：同值给多个目标下发；先预览后写入 */}
      <Dialog open={batchOpen} onOpenChange={(o) => !o && setBatchOpen(false)}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>批量分配额度</DialogTitle>
          </DialogHeader>
          <div className="modal-body">
            <div className="field">
              <Label htmlFor="b-mode">分配对象</Label>
              <select
                id="b-mode"
                className="input"
                value={batchDraft.mode}
                onChange={(e) => setBatchDraft((d) => ({ ...d, mode: e.target.value as typeof d.mode }))}
              >
                <option value="org">组织（全体，一条规则）</option>
                <option value="dept">部门（含子树，一条部门规则）</option>
                <option value="deptUsers">部门下每个用户（每人一条用户规则）</option>
                <option value="users">指定用户（uid 列表）</option>
              </select>
              <span className="hint">
                三类规则叠加生效。「部门下每个用户」会把该部门子树里每个在用用户各写一条 user 规则；
                部门本身一条规则即可覆盖子树，不必展开。
              </span>
            </div>
            {batchDraft.mode === "dept" || batchDraft.mode === "deptUsers" ? (
              <div className="field">
                <Label htmlFor="b-dept">部门</Label>
                <select
                  id="b-dept"
                  className="input"
                  value={batchDraft.deptId}
                  onChange={(e) => setBatchDraft((d) => ({ ...d, deptId: e.target.value }))}
                >
                  <option value="">请选择部门</option>
                  {depts.map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      {d.path}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {batchDraft.mode === "users" ? (
              <div className="field">
                <Label htmlFor="b-uids">用户 uid 列表</Label>
                <Textarea
                  id="b-uids"
                  rows={4}
                  value={batchDraft.uidText}
                  placeholder="每行一个 uid，或用逗号分隔（与「组织与用户」页一致）"
                  onChange={(e) => setBatchDraft((d) => ({ ...d, uidText: e.target.value }))}
                />
                <span className="hint">不存在或已停用的 uid 会被跳过并在预览里列出，不会静默建规则。</span>
              </div>
            ) : null}
            <div className="field">
              <Label htmlFor="b-limit">月度 token 上限</Label>
              <Input
                id="b-limit"
                value={batchDraft.limitInput}
                placeholder="如 100M 或 100000000"
                onChange={(e) => setBatchDraft((d) => ({ ...d, limitInput: e.target.value }))}
              />
              {batchDraft.limitInput.trim() === "" ? null : batchLimitPreview === null ? (
                <span className="hint" style={{ color: "var(--danger)" }}>
                  无法识别：支持 5M / 500K / 500万 / 5000000（单位不区分大小写，可与数字间留空格）
                </span>
              ) : (
                <span className="hint">= {batchLimitPreview.toLocaleString()} tokens</span>
              )}
              <span className="hint">本次所有目标用同一个上限；单条微调请回规则列表「编辑」。</span>
            </div>
            <div className="field">
              <Label htmlFor="b-th">告警阈值（%）</Label>
              <Input
                id="b-th"
                value={batchDraft.thresholdInput}
                placeholder="80, 100"
                onChange={(e) => setBatchDraft((d) => ({ ...d, thresholdInput: e.target.value }))}
              />
              <span className="hint">逗号分隔，1–100。达到阈值发告警（幂等：同周期同 scope 同阈值只发一次）。</span>
            </div>
            <div className="field">
              <Label htmlFor="b-action">超限动作</Label>
              <select
                id="b-action"
                className="input"
                value={batchDraft.action}
                onChange={(e) => setBatchDraft((d) => ({ ...d, action: e.target.value as "warn" | "block" }))}
              >
                <option value="warn">仅告警（不阻断）</option>
                <option value="block">阻断（网关返回 429）</option>
              </select>
            </div>
            {/* 预览（dryRun）：写入前把影响面说清 —— 新建/覆盖各多少、跳过谁、为什么 */}
            <div className="field">
              <Label>预览</Label>
              {batchPreview === null ? (
                <span className="hint">
                  {batchBusy
                    ? "预览中…"
                    : "切换分配对象后自动预览；改上限/阈值/uid 列表后点下方「预览」手动刷新。"}
                </span>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="hint">
                    将写入 <b className="mono">{batchPreview.rules.length}</b> 条：组织{" "}
                    <b className="mono">{batchPreview.resolved.org}</b> · 部门{" "}
                    <b className="mono">{batchPreview.resolved.dept}</b> · 用户{" "}
                    <b className="mono">{batchPreview.resolved.user}</b>
                    {batchPreview.rules.some((r) => r.existed)
                      ? `（其中覆盖已有 ${batchPreview.rules.filter((r) => r.existed).length} 条）`
                      : ""}
                  </span>
                  {batchPreview.rules.length > 0 ? (
                    <div className="cell-sub mono" style={{ maxHeight: 92, overflow: "auto" }}>
                      {batchPreview.rules
                        .slice(0, 20)
                        .map((r) => `${r.scopeType}:${r.scopeId ?? "org"}${r.existed ? "（覆盖）" : ""}`)
                        .join("  ")}
                      {batchPreview.rules.length > 20 ? `  …等 ${batchPreview.rules.length} 条` : ""}
                    </div>
                  ) : null}
                  {batchPreview.skipped.length > 0 ? (
                    <span className="hint" style={{ color: "var(--warn)" }}>
                      跳过 {batchPreview.skipped.length} 条：
                      {batchPreview.skipped
                        .slice(0, 5)
                        .map((s) => `${s.scopeId ?? s.scopeType}（${s.reason}）`)
                        .join("；")}
                      {batchPreview.skipped.length > 5 ? " …" : ""}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setBatchOpen(false)}>取消</Button>
            <Button variant="outline" disabled={batchBusy} onClick={() => void runBatchPreview(batchDraft)}>
              预览
            </Button>
            <Button variant="default" disabled={batchBusy} onClick={() => void applyBatch()}>
              {batchBusy ? "处理中…" : "应用"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 计量对账（P1c）：诊断工具，折叠在底部 —— 不是日常路径，不该占主流程位置 */}
      {isAdmin ? (
        <details className="panel" style={{ marginBottom: 16, padding: "10px 16px" }}>
          <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 600 }}>计量对账</span>
            <span className="cell-sub">诊断用：账本（网关权威）与端侧上报的差额。应约等于 system 调用（KB 向量化按约定不上报）；明显超出说明有调用绕过了网关。</span>
            <div className="spacer" style={{ flex: 1 }} />
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={(e) => {
                e.preventDefault(); // 不触发 details 展开/收起
                void loadReconciliation();
              }}
            >
              <ArrowsClockwise size={14} /> 拉取
            </Button>
          </summary>
          {recon === null ? (
            <div className="empty" style={{ padding: "12px 0" }}>
              <div className="s">点「拉取」查看近 7 天的账本 vs 上报差额。</div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型</TableHead>
                  <TableHead className="num-cell">账本调用</TableHead>
                  <TableHead className="num-cell">上报调用</TableHead>
                  <TableHead className="num-cell">账本 tokens</TableHead>
                  <TableHead className="num-cell">上报 tokens</TableHead>
                  <TableHead className="num-cell">差额</TableHead>
                  <TableHead className="num-cell">其中 system</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recon.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7}>该区间账本与上报均为空</TableCell>
                  </TableRow>
                ) : (
                  recon.rows.map((r) => (
                    <TableRow key={r.model}>
                      <TableCell>{r.model}</TableCell>
                      <TableCell className="num-cell">{r.ledgerCalls}</TableCell>
                      <TableCell className="num-cell">{r.reportedCalls}</TableCell>
                      <TableCell className="num-cell">{nf(r.ledgerTokens)}</TableCell>
                      <TableCell className="num-cell">{nf(r.reportedTokens)}</TableCell>
                      <TableCell className="num-cell">{nf(r.deltaTokens)}</TableCell>
                      <TableCell className="num-cell">{nf(r.ledgerSystemTokens)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </details>
      ) : null}

    </div>
  );
}
