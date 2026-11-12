// 内容与能力 · Skills 套件（技能包）
//
// 为什么套件是一等实体（而不是客户端分组）：一次「装套件」要装 N 个技能，
// 且成员会随运营调整（新增/移出）。若只在客户端按 category 分组，运营调整就要发版；
// 服务端建表后，管理台改成员即刻生效，用户端「一键安装」按钮的态（全装/部分装）也能算准。
//
// 授权语义与单个技能**完全一致**（可见性取交集）：套件可见 ≠ 成员可见 ——
// 用户装套件时，服务端只装他可见的成员（见 repo.installBundle），这里不做额外假设。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Package, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { deptsApi } from "../services/identity-resources";
import { bundlesApi, skillsApi, type AdminBundle, type AdminSkill, type SkillScope } from "../services/skills";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";
import { ScopePicker, scopeLabel } from "../components/ScopePicker";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import type { DeptNode } from "../types";

interface BundleForm {
  name: string;
  title: string;
  description: string;
  icon: string;
  enabled: boolean;
  scope: SkillScope;
  uidsText: string;
  /** 成员技能标识 */
  members: string[];
}

const emptyForm = (): BundleForm => ({
  name: "",
  title: "",
  description: "",
  icon: "",
  enabled: true,
  scope: { kind: "all", roles: [], deptIds: [], uids: [] },
  uidsText: "",
  members: [],
});

function flattenDepts(nodes: DeptNode[], out: Array<{ id: number; path: string }> = []): Array<{ id: number; path: string }> {
  for (const node of nodes) {
    out.push({ id: node.id, path: node.path });
    if (node.children?.length) flattenDepts(node.children, out);
  }
  return out;
}

export function SkillBundles() {
  const [rows, setRows] = useState<AdminBundle[] | null>(null);
  const [skills, setSkills] = useState<AdminSkill[]>([]);
  const [depts, setDepts] = useState<Array<{ id: number; path: string }>>([]);
  const [sheet, setSheet] = useState<null | "new" | AdminBundle>(null);
  const [form, setForm] = useState<BundleForm>(emptyForm());
  const [busy, setBusy] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");

  const load = useCallback(async () => {
    const [b, s, d] = await Promise.all([bundlesApi.list(), skillsApi.list(), deptsApi.tree()]);
    setRows(b.bundles);
    setSkills(s.skills);
    setDepts(flattenDepts(d.tree));
  }, []);

  useEffect(() => {
    void load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  const skillTitle = useMemo(() => new Map(skills.map((s) => [s.name, s.title])), [skills]);
  /** 成员候选：按关键词过滤（技能多了以后，纯 checkbox 列表没法用） */
  const memberOptions = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    const list = q
      ? skills.filter((s) => s.name.includes(q) || s.title.toLowerCase().includes(q))
      : skills;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [skills, memberQuery]);

  const openNew = (): void => {
    setForm(emptyForm());
    setMemberQuery("");
    setSheet("new");
  };

  const openEdit = (bundle: AdminBundle): void => {
    setForm({
      name: bundle.name,
      title: bundle.title,
      description: bundle.description ?? "",
      icon: bundle.icon ?? "",
      enabled: bundle.enabled,
      scope: {
        kind: bundle.scope.kind,
        roles: [...bundle.scope.roles],
        deptIds: [...bundle.scope.deptIds],
        uids: [...bundle.scope.uids],
      },
      uidsText: bundle.scope.uids.join(", "),
      members: [...(bundle.members ?? [])],
    });
    setMemberQuery("");
    setSheet(bundle);
  };

  const submit = async (): Promise<void> => {
    if (!form.name.trim() || !form.title.trim()) {
      toast.error("标识 / 名称必填");
      return;
    }
    if (form.members.length === 0) {
      toast.error("套件至少需要 1 个成员技能");
      return;
    }
    const scope: SkillScope = {
      kind: form.scope.kind,
      roles: form.scope.kind === "role" ? form.scope.roles : [],
      deptIds: form.scope.kind === "dept" ? form.scope.deptIds : [],
      uids: form.scope.kind === "user" ? form.uidsText.split(/[,，\s]+/).map((u) => u.trim()).filter(Boolean) : [],
    };
    if (scope.kind === "role" && scope.roles.length === 0) return void toast.error("按角色下发需至少选一个角色");
    if (scope.kind === "dept" && scope.deptIds.length === 0) return void toast.error("按部门下发需至少选一个部门");
    if (scope.kind === "user" && scope.uids.length === 0) return void toast.error("按账号下发需至少填一个账号");

    setBusy(true);
    try {
      const base = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        icon: form.icon.trim() || null,
        enabled: form.enabled,
        scope,
        members: form.members,
      };
      // 上层表单故意拦过空作者/空图标。注意这里 description 允许显式传 null（清空描述）
      if (sheet === "new") await bundlesApi.create({ name: form.name.trim().toLowerCase(), ...base });
      else if (sheet) await bundlesApi.patch(sheet.id, base);
      toast.ok("已保存");
      setSheet(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (bundle: AdminBundle): Promise<void> => {
    try {
      await bundlesApi.patch(bundle.id, { enabled: !bundle.enabled });
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async (bundle: AdminBundle): Promise<void> => {
    if (!window.confirm(`删除套件「${bundle.title}」？\n（已安装的成员技能不会因此卸载）`)) return;
    try {
      await bundlesApi.remove(bundle.id);
      toast.ok(`已删除 ${bundle.name}`);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div>
      <PageHead
        title="Skills 套件"
        desc="把一组技能打包成「套件」，用户端一次点击装全部成员；成员与授权在服务端调整，无需客户端发版"
      />
      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <ToneBadge tone="info">套件不改变成员可见性 · 安装时按各自授权取交集</ToneBadge>
        <div className="spacer" />
        <Button size="sm" variant="default" className="gap-1.5" onClick={openNew}>
          <Plus size={14} /> 新增套件
        </Button>
      </div>

      <div className="tablewrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>套件</TableHead>
              <TableHead>成员</TableHead>
              <TableHead>授权范围</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-[170px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null ? (
              <TableRow><TableCell colSpan={5}><SkeletonRows /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <div className="empty">
                    <Package size={22} />
                    <div className="t">还没有套件</div>
                    <div className="s">把常用技能打包，用户端就能一次装齐</div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((bundle) => (
                <TableRow key={bundle.id}>
                  <TableCell>
                    <div style={{ fontWeight: 600 }}>
                      {bundle.icon ? <span style={{ marginRight: 6 }}>{bundle.icon}</span> : null}
                      {bundle.title}
                    </div>
                    <div className="cell-sub">
                      <span className="mono">{bundle.name}</span>
                      {bundle.description ? ` · ${bundle.description}` : ""}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{bundle.members?.length ?? 0} 个技能</div>
                    <div className="cell-sub" title={(bundle.members ?? []).join("、")}>
                      {(bundle.members ?? []).slice(0, 3).map((m) => skillTitle.get(m) ?? m).join("、")}
                      {(bundle.members?.length ?? 0) > 3 ? " …" : ""}
                    </div>
                  </TableCell>
                  <TableCell>{scopeLabel(bundle.scope)}</TableCell>
                  <TableCell>
                    {bundle.enabled ? <ToneBadge tone="accent">上架</ToneBadge> : <ToneBadge tone="danger">已下架</ToneBadge>}
                  </TableCell>
                  <TableCell>
                    <div className="row-actions">
                      <Button size="sm" variant="ghost" className="gap-1" onClick={() => openEdit(bundle)}>
                        <PencilSimple size={14} /> 编辑
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void toggle(bundle)}>
                        {bundle.enabled ? "下架" : "上架"}
                      </Button>
                      <Button size="sm" variant="ghost" className="gap-1" onClick={() => void remove(bundle)}>
                        <Trash size={14} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={sheet !== null} onOpenChange={(open) => { if (!open) setSheet(null); }}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>{sheet === "new" ? "新增套件" : "编辑套件"}</DialogTitle>
          </DialogHeader>
          <div className="form-col modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="grid gap-1.5">
              <Label htmlFor="bundle-name">标识（小写字母/数字/连字符）</Label>
              <Input
                id="bundle-name"
                value={form.name}
                disabled={sheet !== "new"}
                placeholder="office-starter"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="bundle-title">名称</Label>
                <Input
                  id="bundle-title"
                  value={form.title}
                  placeholder="办公入门包"
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="bundle-icon">图标（emoji）</Label>
                <Input
                  id="bundle-icon"
                  value={form.icon}
                  placeholder="🧰"
                  onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bundle-desc">描述</Label>
              <Textarea
                id="bundle-desc"
                rows={2}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            <div className="grid gap-1.5">
              <Label>成员技能（{form.members.length} 个已选）</Label>
              <Input
                value={memberQuery}
                placeholder="搜索技能标识或名称…"
                onChange={(e) => setMemberQuery(e.target.value)}
              />
              <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 8 }}>
                {memberOptions.length === 0 ? (
                  <div className="cell-sub">没有匹配的技能</div>
                ) : (
                  memberOptions.map((skill) => (
                    <label key={skill.id} className="flex items-center gap-2" style={{ fontSize: 12.5, padding: "2px 0" }}>
                      <input
                        type="checkbox"
                        checked={form.members.includes(skill.name)}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            members: e.target.checked
                              ? [...f.members, skill.name]
                              : f.members.filter((m) => m !== skill.name),
                          }))
                        }
                      />
                      <span style={{ fontWeight: 500 }}>{skill.title}</span>
                      <span className="mono cell-sub">{skill.name}</span>
                      {skill.enabled ? null : <ToneBadge tone="danger">已下架</ToneBadge>}
                    </label>
                  ))
                )}
              </div>
              {form.members.length > 0 ? (
                <div className="cell-sub">已选：{form.members.map((m) => skillTitle.get(m) ?? m).join("、")}</div>
              ) : null}
            </div>

            <div className="flex items-center justify-between rounded border px-3" style={{ borderColor: "var(--line)" }}>
              <span style={{ fontSize: 13 }}>上架（用户端可见）</span>
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
            </div>

            <ScopePicker
              value={form.scope}
              onChange={(next) => setForm((f) => ({ ...f, scope: next }))}
              depts={depts}
              uidsText={form.uidsText}
              onUidsChange={(raw) => setForm((f) => ({ ...f, uidsText: raw }))}
            />
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setSheet(null)}>取消</Button>
            <Button disabled={busy} onClick={() => void submit()}>{busy ? "保存中…" : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
