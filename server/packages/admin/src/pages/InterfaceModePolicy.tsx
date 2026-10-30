// 组织与权限 · 界面模式权限（编程模式受众）
//
// 维护「哪些部门/人员可以使用桌面端的编程模式」。未授权用户登录后看不到编程档、
// 也会被兜底到办公档（见 docs/未完成-编程模式权限-方案-v1.md）。
//
// 为什么是本页独立维护（而不是塞进「模型与供应商」的策略页）：本项受众是**按 viewer 变化**的
// 组织配置，与审批模式/黑名单这类全组织单值策略不是同一维度；混在一起会让管理员误以为它也是全局开关。
//
// 2026-10-29 改造：授权范围从「手输账号文本」改成**可视化选择**（左部门树 + 右人员列表）。
// 受众是 800+ 员工，让管理员凭记忆敲 uid 既慢又容易错；而且「按部门」原来是一长条
// 全路径复选列表，深层部门几乎没法找。这里复用「组织与用户」页的树形心智。
// 复用边界：只在本页用，技能/套件那两页仍走 ScopePicker（它们不受本次改造影响）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Code, FloppyDisk } from "@phosphor-icons/react";
import { interfaceModeApi, type InterfaceModePolicy, type InterfaceModeScopeKind } from "../services/interface-mode";
import type { SkillScope, SkillScopeKind } from "../services/skills";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";
import { ROLE_LABELS, SCOPE_LABELS, scopeLabel } from "../components/ScopePicker";
import { OrgScopePicker } from "../components/OrgScopePicker";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import type { Role } from "../types";

/** 把服务端策略映射成本页表单：off → 开关关闭；其余 → 开关打开 + 对应 scope。 */
function toForm(policy: InterfaceModePolicy): { open: boolean; scope: SkillScope } {
  if (policy.kind === "off") {
    return { open: false, scope: { kind: "all", roles: [], deptIds: [], uids: [] } };
  }
  return {
    open: true,
    scope: {
      kind: policy.kind,
      roles: [...policy.roles],
      deptIds: [...policy.deptIds],
      uids: [...policy.uids],
    },
  };
}

/** 表单 → 请求体：开关关闭即 off（其余字段清空，避免残留旧受众）。 */
function toPayload(open: boolean, scope: SkillScope): InterfaceModePolicy {
  if (!open) return { kind: "off", roles: [], deptIds: [], uids: [] };
  const kind = scope.kind as InterfaceModeScopeKind;
  return {
    kind,
    roles: kind === "role" ? scope.roles : [],
    deptIds: kind === "dept" ? scope.deptIds : [],
    uids: kind === "user" ? scope.uids : [],
  };
}

export function InterfaceModePolicyPage() {
  const [loaded, setLoaded] = useState<InterfaceModePolicy | null>(null);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<SkillScope>({ kind: "all", roles: [], deptIds: [], uids: [] });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const p = await interfaceModeApi.get();
    setLoaded(p.policy);
    const form = toForm(p.policy);
    setOpen(form.open);
    setScope(form.scope);
  }, []);

  useEffect(() => {
    void load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  const currentLabel = useMemo(() => {
    // ⚠ 必须先判 null：初始 loaded=null 时若直接走 scopeLabel(null) 会读 null.kind 抛错，
    // 而 useMemo 在首次渲染就求值 —— 整棵 React 树会因此卸载、页面白屏。
    if (!loaded) return "加载中…";
    if (loaded.kind === "off") return "未开放（仅平台管理员可用）";
    // 按账号可能选中大量人，全量列出会把「当前生效」撑成一屏，这里只给前 5 个 + 总数
    if (loaded.kind === "user") {
      const preview = loaded.uids.slice(0, 5).join("、");
      const suffix = loaded.uids.length > 5 ? " 等" : "";
      return `${preview}${suffix}（共 ${loaded.uids.length} 人）`;
    }
    return scopeLabel({
      kind: loaded.kind,
      roles: loaded.roles,
      deptIds: loaded.deptIds,
      uids: loaded.uids,
    });
  }, [loaded]);

  const submit = async (): Promise<void> => {
    const payload = toPayload(open, scope);
    if (payload.kind === "role" && payload.roles.length === 0) return void toast.error("按角色开放需至少选一个角色");
    if (payload.kind === "dept" && payload.deptIds.length === 0) return void toast.error("按部门开放需至少勾选一个部门");
    if (payload.kind === "user" && payload.uids.length === 0) return void toast.error("按账号开放需至少勾选一个人员");
    setBusy(true);
    try {
      const r = await interfaceModeApi.put(payload);
      setLoaded(r.policy);
      toast.ok("已保存，端侧下次同步策略后生效");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHead title="界面模式权限" desc="控制哪些部门/人员可以使用桌面端的「编程模式」" />
      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <ToneBadge tone="info">未授权用户登录后看不到编程档，并自动落到办公档</ToneBadge>
        <div className="spacer" />
        <Button size="sm" variant="default" className="gap-1.5" disabled={busy} onClick={() => void submit()}>
          <FloppyDisk size={14} /> {busy ? "保存中…" : "保存"}
        </Button>
      </div>

      {loaded === null ? (
        <SkeletonRows n={3} />
      ) : (
        <div className="form-col" style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 940 }}>
          {/* 同页其余卡片都是白底，这里若留透明会直接透出页面米黄，与 .org-scope-* 一起显得"全同色" */}
          <div
            className="flex items-center justify-between rounded border px-3 py-2"
            style={{ borderColor: "var(--line)", background: "var(--surface)" }}
          >
            <span style={{ fontSize: 13 }}>
              <Code size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              向指定范围开放编程模式
            </span>
            <Switch checked={open} onCheckedChange={setOpen} />
          </div>

          {!open ? (
            <div className="cell-sub">
              当前：<b>不开放</b>（仅平台管理员可用编程模式）。打开上方开关并选择范围后保存即可开放。
            </div>
          ) : (
            <>
              <div className="grid gap-1.5" style={{ maxWidth: 260 }}>
                <Label>授权范围</Label>
                <Select
                  value={scope.kind}
                  onValueChange={(kind) => setScope({ ...scope, kind: kind as SkillScopeKind })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(SCOPE_LABELS) as SkillScopeKind[]).map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {SCOPE_LABELS[kind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {scope.kind === "role" ? (
                <div className="flex flex-wrap gap-4">
                  {(Object.keys(ROLE_LABELS) as Role[]).map((role) => (
                    <label key={role} className="flex items-center gap-2" style={{ fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={scope.roles.includes(role)}
                        onChange={(e) =>
                          setScope({
                            ...scope,
                            roles: e.target.checked ? [...scope.roles, role] : scope.roles.filter((r) => r !== role),
                          })
                        }
                      />
                      {ROLE_LABELS[role]}
                    </label>
                  ))}
                </div>
              ) : null}

              {scope.kind === "dept" || scope.kind === "user" ? (
                <OrgScopePicker
                  mode={scope.kind}
                  deptIds={scope.deptIds}
                  uids={scope.uids}
                  onDeptIdsChange={(deptIds) => setScope({ ...scope, deptIds })}
                  onUidsChange={(uids) => setScope({ ...scope, uids })}
                />
              ) : null}

              {scope.kind === "all" ? (
                <div className="cell-sub">全公司开放：所有员工登录后都能看到编程档。</div>
              ) : null}
            </>
          )}

          <div className="cell-sub">
            当前生效：<b>{currentLabel}</b>
            <br />
            说明：平台管理员始终可用编程模式（避免把运维锁死）；改动保存后，已登录用户下次同步组织策略时生效。
          </div>
        </div>
      )}
    </div>
  );
}
