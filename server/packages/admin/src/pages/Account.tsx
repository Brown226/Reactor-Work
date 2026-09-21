// 个人中心（/me）：本人身份 + 数据范围；域账号信息来自 AD，本地改密后续批次

import { ToneBadge, RoleBadge } from "../components/reactor";
import { scopeLabel, useAuthStore } from "../stores/auth";
import { Initial, PageHead } from "../ui";

export function Account() {
  const user = useAuthStore((s) => s.user);
  const scope = useAuthStore((s) => s.scope);
  const me = user;
  if (!me) return null;
  const rows: Array<[string, React.ReactNode]> = [
    ["登录账号", <span key="u" className="mono">{me.uid}</span>],
    ["真实姓名", me.name],
    ["邮箱", me.email ? <span key="e" className="mono">{me.email}</span> : "—"],
    ["账号来源", me.source === "ad" ? "域账号（LDAP）" : "本地账号"],
    ["状态", me.status === "active" ? <ToneBadge key="s" tone="success" dot>启用</ToneBadge> : <ToneBadge key="s" tone="danger" dot>停用</ToneBadge>],
    ["所属部门", me.dept ? me.dept.path : "—"],
    ["数据范围", scopeLabel(scope, me.dept?.path ?? null)],
    ["最近同步", me.syncedAt ? new Date(me.syncedAt).toLocaleString("zh-CN") : "—"],
  ];
  return (
    <div>
      <PageHead title="个人中心" desc="账号与权限信息；域账号资料由 AD 同步维护，本地账号改密在后续批次开放" />
      <div className="two-col">
        <div className="panel" style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "28px 20px", gap: 10 }}>
          <Initial name={me.name} size={56} />
          <div style={{ fontSize: 17, fontWeight: 650 }}>{me.name}</div>
          <RoleBadge role={me.role} />
          <div style={{ color: "var(--ink-3)", fontSize: 12 }}>{me.dept?.path ?? "未指派部门"}</div>
        </div>
        <div className="panel">
          <div className="panel-head"><h3>账号信息</h3></div>
          <div className="desc-list">
            {rows.map(([k, v]) => (
              <div className="row" key={k}>
                <span className="k">{k}</span>
                <span className="v">{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
