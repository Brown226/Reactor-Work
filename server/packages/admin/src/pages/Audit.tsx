// 审计与报表（M8 / 管理台「系统」组）：实时审计流（只增不改）+ 过滤 + 报表统计 + CSV 导出。
// 数据真源：服务端 GET /desktop/audit（按角色收敛：平台管理员全量 / 部门负责人本部门子树 / 普通用户仅本人）。
// 说明：审计流**不含会话正文**（NFR-P-01），只呈现结构化元数据与用量计数。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, DownloadSimple, MagnifyingGlass, ShieldCheck } from "@phosphor-icons/react";
import {
  auditApi,
  type AuditActionKind,
  type AuditEventRow,
  type AuditQueryResult,
} from "../services/audit";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge, type Tone } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

const ACTIONS: Array<{ key: AuditActionKind; label: string; tone: Tone }> = [
  { key: "model_call", label: "模型调用", tone: "info" },
  { key: "tool_call", label: "工具执行", tone: "accent" },
  { key: "approval", label: "审批结论", tone: "warn" },
  { key: "policy_block", label: "策略拦截", tone: "danger" },
  { key: "admin_action", label: "管理操作", tone: "warn" },
  { key: "session", label: "会话事件", tone: "neutral" },
  { key: "auth", label: "登录认证", tone: "success" },
];

const actionMeta = (a: string): { label: string; tone: Tone } =>
  ACTIONS.find((x) => x.key === a) ?? { label: a, tone: "neutral" };

const OUTCOMES: Array<{ key: string; label: string; tone: Tone }> = [
  { key: "ok", label: "成功", tone: "success" },
  { key: "error", label: "失败", tone: "danger" },
  { key: "denied", label: "被拒", tone: "warn" },
  { key: "cancelled", label: "已取消", tone: "neutral" },
];
const outcomeMeta = (o?: string) =>
  o ? (OUTCOMES.find((x) => x.key === o) ?? { label: o, tone: "neutral" as Tone }) : { label: "—", tone: "neutral" as Tone };

type RangeKey = "today" | "7d" | "30d";
const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "today", label: "今日" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
];

function rangeOf(key: RangeKey): { from: Date; to: Date } {
  const to = new Date();
  if (key === "today") {
    const from = new Date(to);
    from.setHours(0, 0, 0, 0);
    return { from, to };
  }
  const days = key === "30d" ? 30 : 7;
  return { from: new Date(to.getTime() - days * 24 * 3600 * 1000), to };
}

const PAGE_SIZE = 50;

const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function MiniBars({ items }: { items: Array<{ key: string; count: number }> }) {
  const max = items.reduce((m, i) => Math.max(m, i.count), 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.length === 0 ? <span className="cell-sub">—</span> : null}
      {items.map((i) => (
        <div key={i.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="cell-sub mono" style={{ minWidth: 96 }}>{actionMeta(i.key).label === i.key ? i.key : actionMeta(i.key).label}</span>
          <div style={{ flex: 1, height: 6, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ width: `${max > 0 ? Math.max(2, Math.round((i.count / max) * 100)) : 0}%`, height: "100%", background: "var(--accent)" }} />
          </div>
          <span className="cell-sub mono" style={{ minWidth: 40, textAlign: "right" }}>{i.count}</span>
        </div>
      ))}
    </div>
  );
}

export function Audit() {
  const [range, setRange] = useState<RangeKey>("7d");
  const [action, setAction] = useState<string>("all");
  const [outcome, setOutcome] = useState<string>("all");
  const [uid, setUid] = useState("");
  const [toolName, setToolName] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<AuditQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const params = useMemo(() => {
    const { from, to } = rangeOf(range);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      ...(action !== "all" ? { action } : {}),
      ...(outcome !== "all" ? { outcome } : {}),
      ...(uid.trim() ? { uid: uid.trim() } : {}),
      ...(toolName.trim() ? { toolName: toolName.trim() } : {}),
    };
  }, [range, action, outcome, uid, toolName]);

  const load = useCallback(
    async (nextOffset = offset) => {
      setLoading(true);
      try {
        const res = await auditApi.query({ ...params, limit: PAGE_SIZE, offset: nextOffset, stats: true });
        setData(res);
        setOffset(nextOffset);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [params, offset],
  );

  useEffect(() => {
    void load(0);
    // 过滤条件变化时回到第一页重新查询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const exportCsv = async (): Promise<void> => {
    setExporting(true);
    try {
      const blob = await auditApi.downloadCsv(params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.ok("已导出 CSV（最多 1000 行，UTF-8 BOM）");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const rows = data?.events ?? [];
  const total = data?.total ?? 0;
  const stats = data?.stats;

  return (
    <div>
      <PageHead
        title="审计与报表"
        desc="只增不改的操作审计流：谁在何时让 Agent 做了什么、审批结论与策略拦截；不含会话正文（NFR-P-01）。"
        /* 数据范围徒标（枚举）：平台管理员是全量默认态 ⇒ all（不渲染） */
        scope={data?.scope === "platform_admin" ? "all" : data?.scope === "dept_head" ? "dept" : data ? "self" : undefined}
      />

      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r.key} className={range === r.key ? "on" : ""} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部动作</SelectItem>
            {ACTIONS.map((a) => (
              <SelectItem key={a.key} value={a.key}>{a.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部结果</SelectItem>
            {OUTCOMES.map((o) => (
              <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input className="w-36" placeholder="账号 uid" value={uid} onChange={(e) => setUid(e.target.value)} />
        <Input className="w-36" placeholder="工具名" value={toolName} onChange={(e) => setToolName(e.target.value)} />
        <Button size="sm" variant="default" className="gap-1.5" onClick={() => void load(0)}>
          <MagnifyingGlass size={14} /> 查询
        </Button>
        <div className="spacer" />
        <Button size="sm" variant="outline" className="gap-1.5" disabled={exporting} onClick={() => void exportCsv()}>
          <DownloadSimple size={14} /> {exporting ? "导出中…" : "导出 CSV"}
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void load(offset)}>
          <ArrowsClockwise size={14} /> 刷新
        </Button>
      </div>

      <div className="metrics" style={{ marginBottom: 16 }}>
        <div className="metric">
          <div className="k"><ShieldCheck size={13} /> 命中事件</div>
          <div className="v num">{total}</div>
          <div className="d">当前过滤条件（含时间区间）</div>
        </div>
        <div className="metric" style={{ gridColumn: "span 2" }}>
          <div className="k">动作分布</div>
          <div style={{ marginTop: 6 }}><MiniBars items={stats?.byAction ?? []} /></div>
        </div>
        <div className="metric">
          <div className="k">结果分布</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {(stats?.byOutcome ?? []).length === 0 ? <span className="cell-sub">—</span> : null}
            {(stats?.byOutcome ?? []).map((o) => (
              <ToneBadge key={o.key} tone={outcomeMeta(o.key).tone}>
                {outcomeMeta(o.key).label} {o.count}
              </ToneBadge>
            ))}
          </div>
        </div>
      </div>

      <div className="tablewrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>用户 / 部门</TableHead>
              <TableHead>动作</TableHead>
              <TableHead>工具 / 模型</TableHead>
              <TableHead>结果</TableHead>
              <TableHead className="num-cell">tokens</TableHead>
              <TableHead className="num-cell">耗时</TableHead>
              <TableHead>摘要</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              <TableRow><TableCell colSpan={8}><SkeletonRows /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <div className="empty">
                    <ShieldCheck size={20} />
                    <div className="t">该条件暂无审计事件</div>
                    <div className="s">事件由桌面端上报（G0 数据面）；端侧接入前为空是预期行为</div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((e: AuditEventRow) => (
                <TableRow key={e.id}>
                  <TableCell className="mono cell-sub">{fmtTime(e.ts)}</TableCell>
                  <TableCell>
                    <div className="cell-title mono">{e.uid}</div>
                    <div className="cell-sub">{e.deptPath ?? "—"}</div>
                  </TableCell>
                  <TableCell>
                    <ToneBadge tone={actionMeta(e.action).tone}>{actionMeta(e.action).label}</ToneBadge>
                    {e.policyMode ? <div className="cell-sub">模式 {e.policyMode}</div> : null}
                  </TableCell>
                  <TableCell>
                    <div className="cell-sub mono">{e.toolName ?? e.usage?.model ?? "—"}</div>
                    {e.toolName && e.usage?.model ? <div className="cell-sub mono">{e.usage.model}</div> : null}
                  </TableCell>
                  <TableCell>
                    <ToneBadge tone={outcomeMeta(e.outcome).tone}>{outcomeMeta(e.outcome).label}</ToneBadge>
                    {e.approvalDecision ? <div className="cell-sub">审批 {e.approvalDecision}</div> : null}
                  </TableCell>
                  <TableCell className="num-cell mono">
                    {e.usage?.totalTokens ?? "—"}
                    {e.cost != null ? (
                      <div className="cell-sub">
                        ¥{e.cost}
                        {e.costSource === "client" ? <span title="无量价配置，回落端侧上报值"> ·端侧</span> : null}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="num-cell mono">{e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)}s` : "—"}</TableCell>
                  <TableCell><div className="cell-sub">{e.summary ?? "—"}</div></TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="toolbar" style={{ marginTop: 12 }}>
        <span className="cell-sub">
          共 {total} 条 · 第 {total === 0 ? 0 : Math.floor(offset / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页
        </span>
        <div className="spacer" />
        <Button size="sm" variant="outline" disabled={offset === 0 || loading} onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}>
          上一页
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={loading || offset + PAGE_SIZE >= total}
          onClick={() => void load(offset + PAGE_SIZE)}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
