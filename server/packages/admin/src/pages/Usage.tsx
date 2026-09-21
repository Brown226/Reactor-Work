// 用量与额度（M9 / 管理台「模型与网关」组）：部门×模型×用户×日的用量报表 + 月度额度 + 阈值告警记录。
// 数据真源：GET /desktop/usage/summary（按角色收敛）+ GET/PUT /desktop/policy（额度在策略里）
//          + GET /admin/quota-alerts（已触发的阈值告警，含是否已外发）。
// 图表用纯 CSS 条形（不引入额外运行时依赖；数值来自服务端，不做前端推算）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, BellRinging, CalendarBlank, ChartBar, Coins, Gauge, Lightning, PencilSimple, Users } from "@phosphor-icons/react";
import {
  policyApi,
  quotaAlertsApi,
  usageApi,
  type DesktopPolicy,
  type QuotaAlertsResult,
  type UsageGroupBy,
  type UsageSummaryResult,
} from "../services/audit";
import { useAuthStore } from "../stores/auth";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

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

const nf = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K` : String(n));
const money = (n: number): string => `¥${n.toFixed(n >= 100 ? 0 : 2)}`;

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
  const [policy, setPolicy] = useState<DesktopPolicy | null>(null);
  const [monthUsage, setMonthUsage] = useState<number | null>(null);
  const [alerts, setAlerts] = useState<QuotaAlertsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [editQuota, setEditQuota] = useState(false);
  const [limitInput, setLimitInput] = useState("");
  const [thresholdInput, setThresholdInput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { from, to } = rangeOf(range);
    try {
      const [summary, pol] = await Promise.all([
        usageApi.summary({ groupBy, from: from.toISOString(), to: to.toISOString() }),
        policyApi.get().catch(() => null),
      ]);
      setData(summary);
      if (pol) setPolicy(pol.policy);
      // 额度告警记录（仅管理员可读；普通用户 403 时忽略）
      setAlerts(await quotaAlertsApi.list().catch(() => null));
      // 本月用量（与当前分组无关，用于额度条）
      const m = await usageApi.summary({ groupBy: "day", from: startOfMonth().toISOString(), to: new Date().toISOString() });
      setMonthUsage(m.totals.totalTokens);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [groupBy, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.rows ?? [];
  const maxTokens = useMemo(() => rows.reduce((m, r) => Math.max(m, r.totalTokens), 0), [rows]);
  const totals = data?.totals;
  const quota = policy?.quota;
  const quotaPct =
    quota?.monthlyTokenLimit && monthUsage !== null
      ? Math.min(100, Math.round((monthUsage / quota.monthlyTokenLimit) * 100))
      : null;

  const openQuota = (): void => {
    setLimitInput(quota?.monthlyTokenLimit ? String(quota.monthlyTokenLimit) : "");
    setThresholdInput((quota?.alertThresholds ?? [80, 100]).join(", "));
    setEditQuota(true);
  };

  const saveQuota = async (): Promise<void> => {
    if (!policy) return;
    setBusy(true);
    try {
      const limitNum = limitInput.trim() === "" ? null : Number(limitInput);
      if (limitNum !== null && (!Number.isFinite(limitNum) || limitNum <= 0)) {
        toast.error("月度上限需为正数或留空");
        return;
      }
      const thresholds = thresholdInput
        .split(/[,，\s]+/)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
      const res = await policyApi.put({ ...policy, quota: { monthlyTokenLimit: limitNum, alertThresholds: thresholds } });
      setPolicy(res.policy);
      toast.ok("额度已保存");
      setEditQuota(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHead
        title="用量与额度"
        desc="部门×模型×用户×日 的 token 与费用报表；额度为组织级月度上限，仅告警不阻断。数据来自端侧上报（G0 数据面）。"
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
        {isAdmin ? (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={openQuota}>
            <PencilSimple size={14} /> 编辑额度
          </Button>
        ) : null}
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void load()}>
          <ArrowsClockwise size={14} /> 刷新
        </Button>
      </div>

      <div className="metrics">
        <div className="metric">
          <div className="k"><Lightning size={13} /> 调用次数</div>
          <div className="v num">{totals ? totals.calls : "—"}</div>
          <div className="d">上报了用量的调用（通常为模型调用）</div>
        </div>
        <div className="metric">
          <div className="k"><ChartBar size={13} /> 总 tokens</div>
          <div className="v num">{totals ? nf(totals.totalTokens) : "—"}</div>
          <div className="d">输入 {totals ? nf(totals.inputTokens) : "—"} · 输出 {totals ? nf(totals.outputTokens) : "—"}</div>
        </div>
        <div className="metric">
          <div className="k"><Gauge size={13} /> 缓存 tokens</div>
          <div className="v num">{totals ? nf((totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0)) : "—"}</div>
          <div className="d">读 {totals ? nf(totals.cacheReadTokens) : "—"} · 写 {totals ? nf(totals.cacheWriteTokens) : "—"}</div>
        </div>
        <div className="metric">
          <div className="k"><Coins size={13} /> 费用</div>
          <div className="v num">{totals ? money(totals.cost) : "—"}</div>
          <div className="d">服务端按模型四段价核算（无价目时回落端侧上报值）</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <div>
            <h3>本月额度</h3>            <div className="sub">
              {quota?.monthlyTokenLimit
                ? `上限 ${quota.monthlyTokenLimit.toLocaleString()} tokens · 告警阈值 ${(quota.alertThresholds ?? []).join("% / ")}%`
                : "未设置月度上限（仅告警不阻断）"}
            </div>
          </div>
          <div className="right">
            <ToneBadge tone={quotaPct !== null && quotaPct >= 80 ? "danger" : "info"}>
              {quotaPct === null ? "未限额" : `已用 ${quotaPct}%`}
            </ToneBadge>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
          <div style={{ flex: 1, height: 10, background: "var(--surface-2)", borderRadius: 6, overflow: "hidden", position: "relative" }}>
            <div
              style={{
                width: `${quotaPct ?? 0}%`,
                height: "100%",
                background: quotaPct !== null && quotaPct >= 80 ? "var(--danger)" : "var(--accent)",
              }}
            />
            {(quota?.alertThresholds ?? []).map((t) => (
              <div
                key={t}
                title={`告警阈值 ${t}%`}
                style={{ position: "absolute", left: `${t}%`, top: 0, bottom: 0, width: 1, background: "var(--hairline)" }}
              />
            ))}
          </div>
          <span className="cell-sub mono">
            {monthUsage === null ? "—" : nf(monthUsage)}
            {quota?.monthlyTokenLimit ? ` / ${nf(quota.monthlyTokenLimit)}` : ""}
          </span>
        </div>
      </div>

      {alerts && alerts.alerts.length > 0 ? (
        <div className="panel" style={{ marginBottom: 16, background: "var(--warn-soft)", borderColor: "transparent" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--warn)", fontWeight: 500 }}>
            <BellRinging size={15} /> 本月已触发 {alerts.alerts.length} 条额度告警
            <span className="cell-sub" style={{ marginLeft: 4 }}>
              {alerts.webhookConfigured ? "（已配置外发通道）" : "（未配置外发：设置 REACTOR_QUOTA_WEBHOOK_URL 即可推送）"}
            </span>
          </div>
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8 }}>
            {alerts.alerts.map((a) => (
              <ToneBadge key={a.id} tone={a.level === "critical" ? "danger" : "warn"}>
                {a.period} · 阈值 {a.threshold}%（已达 {a.percent}%）
                {a.notified ? " · 已外发" : alerts.webhookConfigured ? (a.notifyError ? ` · 外发失败：${a.notifyError}` : " · 待外发") : ""}
              </ToneBadge>
            ))}
          </div>
          <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--ink-2)" }}>
            告警<b>只提示不阻断</b>：达到阈值不会中断任何调用；同一周期同一阈值只告警一次。
          </div>
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
                    <div className="s">用量由桌面端上报（G0 数据面）；若端侧尚未接入上报，此页为空是预期行为</div>
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
            <DialogTitle>编辑月度额度</DialogTitle>
          </DialogHeader>
          <div className="modal-body">
            <div className="field">
              <Label htmlFor="q-limit">月度 token 上限</Label>
              <Input id="q-limit" inputMode="numeric" value={limitInput} placeholder="留空 = 不限" onChange={(e) => setLimitInput(e.target.value)} />
              <span className="hint">仅告警不阻断：达到阈值只提示，不会中断用户使用</span>
            </div>
            <div className="field">
              <Label htmlFor="q-th">告警阈值（%）</Label>
              <Input id="q-th" value={thresholdInput} placeholder="80, 100" onChange={(e) => setThresholdInput(e.target.value)} />
              <span className="hint">逗号分隔，1–100</span>
            </div>
            {policy?.updatedAt ? (
              <span className="hint">上次修改：{new Date(policy.updatedAt).toLocaleString()} · {policy.updatedBy ?? "—"}</span>
            ) : null}
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setEditQuota(false)}>取消</Button>
            <Button variant="default" disabled={busy} onClick={() => void saveQuota()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
