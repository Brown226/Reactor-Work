// 组织与权限 · 角色与权限（U-3）
// 真实数据：GET /admin/permissions（权限点清单 + 三角色矩阵）· POST /admin/permissions/scan（重新扫描）
// 权限模型保持固定三角色 + 三级数据范围（不开放自由角色，见细化设计护栏）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, Buildings, ShieldCheck, User } from "@phosphor-icons/react";
import { permissionsApi, type PermissionPoint, type RolePermissions } from "../services/permissions";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

const ROLE_ICON: Record<string, { icon: typeof ShieldCheck; color: string; bg: string }> = {
  platform_admin: { icon: ShieldCheck, color: "var(--accent)", bg: "var(--accent-soft)" },
  dept_head: { icon: Buildings, color: "var(--info)", bg: "var(--info-soft)" },
  user: { icon: User, color: "var(--ink-2)", bg: "var(--surface-2)" },
};

const ROLE_POINTS: Record<string, string[]> = {
  platform_admin: ["用户 / 组织 / 角色 全量管理", "模型、供应商、技能、Agent 等全部模块", "AD 同步触发、权限点扫描", "审计与报表全量"],
  dept_head: ["本部门成员管理（调岗/停用/资料）", "本部门报表与用量（后续批次）", "不可改角色 / 部门边界之外", "不可处理平台管理员"],
  user: ["个人中心（本人账号）", "桌面端会话与工具能力（受策略约束）", "个人用量查看（后续批次）", "不可进入管理面"],
};

export function Roles() {
  const [points, setPoints] = useState<PermissionPoint[] | null>(null);
  const [roles, setRoles] = useState<RolePermissions[]>([]);
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    const payload = await permissionsApi.list();
    setPoints(payload.permissions);
    setRoles(payload.roles);
  }, []);

  useEffect(() => {
    void load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  const scan = async (): Promise<void> => {
    setScanning(true);
    try {
      const payload = await permissionsApi.scan();
      setPoints(payload.permissions);
      setRoles(payload.roles);
      toast.ok(`扫描完成：共 ${payload.result.total} 个权限点（新增 ${payload.result.added} / 清理 ${payload.result.removed}）`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const roleSet = useMemo(() => new Map(roles.map((role) => [role.key, new Set(role.permissions)])), [roles]);

  const filtered = useMemo(() => {
    const list = points ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (point) =>
        point.code.toLowerCase().includes(q) ||
        point.path.toLowerCase().includes(q) ||
        (point.description ?? "").toLowerCase().includes(q),
    );
  }, [points, query]);

  return (
    <div>
      <PageHead
        title="角色与权限"
        desc="固定三角色 + 按部门数据隔离；权限点由服务端从实际路由表扫描生成，新增受保护路由后跑一次扫描即可出现"
        right={
          <Button variant="default" className="gap-1.5" disabled={scanning} onClick={() => void scan()}>
            <ArrowsClockwise size={15} /> {scanning ? "扫描中…" : "重新扫描权限点"}
          </Button>
        }
      />

      <div className="grid-cards" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", marginBottom: 16 }}>
        {roles.map((role) => {
          const meta = ROLE_ICON[role.key] ?? ROLE_ICON.user!;
          const Icon = meta.icon;
          return (
            <div key={role.key} className="panel">
              <div style={{ width: 36, height: 36, borderRadius: 8, background: meta.bg, color: meta.color, display: "grid", placeItems: "center", marginBottom: 12 }}>
                <Icon size={18} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 650 }}>{role.label}</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", margin: "4px 0 12px" }}>
                数据范围：{role.scope} · 权限点 {role.permissions.length} 个
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, color: "var(--ink-2)", fontSize: 13, display: "flex", flexDirection: "column", gap: 6 }}>
                {(ROLE_POINTS[role.key] ?? []).map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h3>权限点清单</h3>
            <div className="sub">
              共 {points?.length ?? 0} 个 · 来源：服务端路由表扫描
              {points && points.length === 0 ? "（尚未扫描，点右上「重新扫描权限点」）" : ""}
            </div>
          </div>
          <input
            className="input"
            style={{ maxWidth: 240 }}
            placeholder="搜索权限码 / 路径"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="tablewrap">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>权限码</TableHead>
                <TableHead>方法</TableHead>
                <TableHead>路径</TableHead>
                <TableHead>说明</TableHead>
                <TableHead>角色可见性</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {points === null ? (
                <TableRow><TableCell colSpan={5}><SkeletonRows n={6} /></TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>
                    <div className="empty">
                      <ShieldCheck size={22} />
                      <div className="t">{points.length === 0 ? "尚未生成权限点" : "没有匹配的权限点"}</div>
                      <div className="s">
                        {points.length === 0 ? "点击右上角「重新扫描权限点」从服务端路由表生成" : "换个关键词试试"}
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((point) => (
                  <TableRow key={point.code}>
                    <TableCell className="mono">{point.code}</TableCell>
                    <TableCell>
                      <ToneBadge tone={point.method === "GET" ? "info" : point.method === "DELETE" ? "danger" : "warn"}>
                        {point.method}
                      </ToneBadge>
                    </TableCell>
                    <TableCell className="mono" style={{ fontSize: 12 }}>{point.path}</TableCell>
                    <TableCell className="cell-sub">{point.description}</TableCell>
                    <TableCell>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {roles
                          .filter((role) => roleSet.get(role.key)?.has(point.code))
                          .map((role) => (
                            <ToneBadge
                              key={role.key}
                              tone={role.key === "platform_admin" ? "accent" : role.key === "dept_head" ? "info" : "success"}
                            >
                              {role.label}
                            </ToneBadge>
                          ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
