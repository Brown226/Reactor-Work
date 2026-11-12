// 系统 · 同步日志（真实数据：GET /auth/sync/logs）

import { useEffect, useState } from "react";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import { syncApi } from "../services/identity-resources";
import { toast } from "../lib/toast";
import type { SyncLog } from "../types";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";

export function SyncLogs() {
  const [logs, setLogs] = useState<SyncLog[] | null>(null);
  useEffect(() => {
    syncApi
      .logs()
      .then((r) => setLogs(r.logs))
      .catch((e) => toast.error((e as Error).message));
  }, []);
  return (
    <div>
      <PageHead title="同步日志" desc="AD/LDAP → 平台 的手动同步记录；来源数据与执行口径见组织管理页" />
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>时间</th>
              <th>LDAP 在册</th>
              <th>新增</th>
              <th>变更</th>
              <th>停用</th>
              <th>无变化</th>
            </tr>
          </thead>
          <tbody>
            {logs === null ? (
              <tr><td colSpan={7}><SkeletonRows n={4} /></td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={7}><div className="empty"><ClockCounterClockwise size={22} /><div className="t">暂无同步记录</div><div className="s">在「组织管理」页触发 AD 同步后在此查看</div></div></td></tr>
            ) : (
              logs.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{l.id}</td>
                  <td className="cell-sub">{new Date(l.runAt).toLocaleString("zh-CN")}</td>
                  <td className="num-cell">{l.total}</td>
<td className="num-cell"><ToneBadge tone="accent">{l.added}</ToneBadge></td>
<td className="num-cell"><ToneBadge tone="warn">{l.changed}</ToneBadge></td>
<td className="num-cell"><ToneBadge tone="danger">{l.disabled}</ToneBadge></td>
                  <td className="num-cell">{l.unchanged}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
