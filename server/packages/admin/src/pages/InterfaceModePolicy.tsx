// 组织与权限 · 界面模式权限（编程模式受众）
//
// 维护「哪些部门/人员可以使用桌面端的编程模式」。未授权用户登录后看不到编程档、
// 也会被兜底到办公档（见 docs/未完成-编程模式权限-方案-v1.md）。
//
// 为什么是本页独立维护（而不是塞进「模型与供应商」的策略页）：本项受众是**按 viewer 变化**的
// 组织配置，与审批模式/黑名单这类全组织单值策略不是同一维度；混在一起会让管理员误以为它也是全局开关。
// 授权口径复用 ScopePicker（与技能/专家同一套 all/role/dept/user 四选一），只在最外层多一个
// 「是否开放」总开关 —— 关闭即 `off`（仅平台管理员可用）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Code, FloppyDisk } from "@phosphor-icons/react";
import { deptsApi } from "../services/identity-resources";
import { interfaceModeApi, type InterfaceModePolicy, type InterfaceModeScopeKind } from "../services/interface-mode";
import type { SkillScope } from "../services/skills";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";
import { ScopePicker, scopeLabel } from "../components/ScopePicker";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import type { DeptNode } from "../types";

function flattenDepts(nodes: DeptNode[], out: Array<{ id: number; path: string }> = []): Array<{ id: number; path: string }> {
  for (const node of nodes) {
    out.push({ id: node.id, path: node.path });
    if (node.children?.length) flattenDepts(node.children, out);
  }
  return out;
}

/** 把服务端策略映射成本页表单：off → 开关关闭；其余 → 开关打开 + 对应 scope。 */
function toForm(policy: InterfaceModePolicy): { open: boolean; scope: SkillScope; uidsText: string } {
  if (policy.kind === "off") {
    return { open: false, scope: { kind: "all", roles: [], deptIds: [], uids: [] }, uidsText: "" };
  }
  return {
    open: true,
    scope: {
      kind: policy.kind,
      roles: [...policy.roles],
      deptIds: [...policy.deptIds],
      uids: [...policy.uids],
    },
    uidsText: policy.uids.join(", "),
  };
}

/** 表单 → 请求体：开关关闭即 off（其余字段清空，避免残留旧受众）。 */
function toPayload(open: boolean, scope: SkillScope, uidsText: string): InterfaceModePolicy {
  if (!open) return { kind: "off", roles: [], deptIds: [], uids: [] };
  const kind = scope.kind as InterfaceModeScopeKind;
  return {
    kind,
    roles: kind === "role" ? scope.roles : [],
    deptIds: kind === "dept" ? scope.deptIds : [],
    uids: kind === "user" ? uidsText.split(/[,，\s]+/).map((u) => u.trim()).filter(Boolean) : [],
  };
}

export function InterfaceModePolicyPage() {
  const [loaded, setLoaded] = useState<InterfaceModePolicy | null>(null);
  const [depts, setDepts] = useState<Array<{ id: number; path: string }>>([]);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<SkillScope>({ kind: "all", roles: [], deptIds: [], uids: [] });
  const [uidsText, setUidsText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [p, d] = await Promise.all([interfaceModeApi.get(), deptsApi.tree()]);
    setLoaded(p.policy);
    setDepts(flattenDepts(d.tree));
    const form = toForm(p.policy);
    setOpen(form.open);
    setScope(form.scope);
    setUidsText(form.uidsText);
  }, []);

  useEffect(() => {
    void load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  const currentLabel = useMemo(() => {
    // ⚠ 必须先判 null：初始 loaded=null 时若直接走 scopeLabel(null) 会读 null.kind 抛错，
    // 而 useMemo 在首次渲染就求值 —— 整棵 React 树会因此卸载、页面白屏。
    if (!loaded) return "加载中…";
    if (loaded.kind === "off") return "未开放（仅平台管理员可用）";
    // kind 此时必为 all/role/dept/user，映射成 SkillScope 形状交给 scopeLabel 渲染。
    return scopeLabel({
      kind: loaded.kind,
      roles: loaded.roles,
      deptIds: loaded.deptIds,
      uids: loaded.uids,
    });
  }, [loaded]);

  const submit = async (): Promise<void> => {
    const payload = toPayload(open, scope, uidsText);
    if (payload.kind === "role" && payload.roles.length === 0) return void toast.error("按角色开放需至少选一个角色");
    if (payload.kind === "dept" && payload.deptIds.length === 0) return void toast.error("按部门开放需至少选一个部门");
    if (payload.kind === "user" && payload.uids.length === 0) return void toast.error("按账号开放需至少填一个账号");
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
        <div className="form-col" style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
          <div className="flex items-center justify-between rounded border px-3 py-2" style={{ borderColor: "var(--line)" }}>
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
            <ScopePicker
              value={scope}
              onChange={setScope}
              depts={depts}
              uidsText={uidsText}
              onUidsChange={setUidsText}
            />
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
