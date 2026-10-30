// 会话明细面板：uid / 部门 / 平台 / 客户端版本 / UA / 首末时间 + 筛选 + 游标分页。
// 自己持有筛选与分页状态（页面只负责全局刷新与错误汇总），因为这里的状态不参与其它区块。

import { useCallback, useEffect, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { platformOpsApi, type PlatformSessionRow, type PlatformSessionsPage } from "../services/platform-ops";
import { ToneBadge, type Tone } from "./reactor";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { SkeletonRows } from "../ui";
import { SectionEmpty, Unavailable } from "./PlatformSectionState";
import { fmtDateTime, sinceLabel } from "../lib/platform-format";

/** 会话行里的平台标签：legacy/guess 单独显示，不并入主口径（方案 §3）。 */
function sessionPlatformMeta(p: string): { label: string; tone: Tone } {
  switch (p) {
    case "desktop":
      return { label: "桌面端", tone: "accent" };
    case "web":
      return { label: "Web 端", tone: "info" };
    case "desktop_legacy":
      return { label: "桌面端（旧版推断）", tone: "accent" };
    case "web_guess":
      return { label: "Web（UA 推断）", tone: "info" };
    default:
      return { label: "未打标", tone: "neutral" };
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function PlatformSessionsPanel({
  refreshKey,
  onEnvelope,
  onError,
}: {
  /** 页面「刷新」时递增，用来重新拉第一页 */
  refreshKey: number;
  onEnvelope: (page: PlatformSessionsPage | null) => void;
  onError: (message: string) => void;
}) {
  const [uidInput, setUidInput] = useState("");
  const [platformInput, setPlatformInput] = useState("all");
  const [applied, setApplied] = useState<{ uid: string; platform: string }>({ uid: "", platform: "all" });
  const [page, setPage] = useState<PlatformSessionsPage | null>(null);
  const [rows, setRows] = useState<PlatformSessionRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    // 先清空再拉：筛选条件已变时，不能继续显示上一批行（会被读成「新条件下还有这些数据」）
    setRows([]);
    setNextCursor(null);
    try {
      const res = await platformOpsApi.sessions({
        uid: applied.uid || undefined,
        platform: applied.platform === "all" ? undefined : applied.platform,
        limit: 50,
      });
      setPage(res);
      setRows(res?.rows ?? []);
      setNextCursor(res?.nextCursor ?? null);
      onEnvelope(res);
    } catch (e) {
      onError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [applied, onEnvelope, onError]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await platformOpsApi.sessions({
        uid: applied.uid || undefined,
        platform: applied.platform === "all" ? undefined : applied.platform,
        cursor: nextCursor,
        limit: 50,
      });
      if (res) {
        setRows((prev) => [...prev, ...res.rows]);
        setNextCursor(res.nextCursor);
        setPage(res);
      }
    } catch (e) {
      onError(errText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const applyFilters = (): void => setApplied({ uid: uidInput.trim(), platform: platformInput });
  const sinceText = sinceLabel(page?.coverage.since ?? null);

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <div>
          <h3>会话明细</h3>
          <div className="sub">uid、部门、平台、客户端版本、UA 与首末时间；legacy/guess 单独标注，不混入主口径。</div>
        </div>
      </div>
      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <Input
          className="w-40"
          placeholder="账号 uid"
          value={uidInput}
          onChange={(e) => setUidInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") applyFilters();
          }}
        />
        <Select value={platformInput} onValueChange={setPlatformInput}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部平台</SelectItem>
            <SelectItem value="desktop">桌面端</SelectItem>
            <SelectItem value="web">Web 端</SelectItem>
            <SelectItem value="untagged">未打标</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="default" className="gap-1.5" onClick={applyFilters}>
          <MagnifyingGlass size={14} /> 查询
        </Button>
      </div>
      <div className="tablewrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead>部门</TableHead>
              <TableHead>平台</TableHead>
              <TableHead>客户端版本</TableHead>
              <TableHead>User-Agent</TableHead>
              <TableHead>首次</TableHead>
              <TableHead>最近</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              <TableRow><TableCell colSpan={7}><SkeletonRows /></TableCell></TableRow>
            ) : page === null ? (
              <TableRow><TableCell colSpan={7}><Unavailable section="会话明细" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <SectionEmpty
                    title={`${sinceText}，暂无会话明细`}
                    desc="当前筛选条件下没有记录；清空 uid 或切换平台可放宽范围。"
                  />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r, i) => {
                const meta = sessionPlatformMeta(r.platform);
                return (
                  <TableRow key={r.sessionId ?? `${r.uid}-${r.lastSeenAt ?? ""}-${i}`}>
                    <TableCell><div className="cell-title mono max-w-[160px] truncate" title={r.uid}>{r.uid}</div></TableCell>
                    <TableCell><div className="cell-sub max-w-[180px] truncate" title={r.deptPath ?? undefined}>{r.deptPath ?? "—"}</div></TableCell>
                    <TableCell><ToneBadge tone={meta.tone}>{meta.label}</ToneBadge></TableCell>
                    <TableCell className="mono cell-sub">{r.clientVersion ?? "—"}</TableCell>
                    <TableCell>
                      <div className="cell-sub max-w-[280px] truncate" title={r.userAgent ?? undefined}>
                        {r.userAgent ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell className="mono cell-sub">{fmtDateTime(r.firstSeenAt)}</TableCell>
                    <TableCell className="mono cell-sub">{fmtDateTime(r.lastSeenAt)}</TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {nextCursor ? (
        <div style={{ textAlign: "center", marginTop: 10 }}>
          <Button size="sm" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "加载中…" : "加载更多"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
