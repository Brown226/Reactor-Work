// 用户表（右栏）：从 pages/Users.tsx 原样抽出（工具栏 + 表格 + 分页 + 新建/编辑弹窗），
// 供旧「用户管理」页与新的「组织与用户」合并页共用。
//
// 相对旧页只有三处结构性差异，都是为了合并页：
//   1. 新增 `deptIds` 入参（左树选中的部门 / 其子树）；
//   2. 新增 `toolbarExtra` 插槽（放「含下级成员」开关）；
//   3. 「新建用户」按钮从页头挪进工具栏 —— 合并页一行放不下两块页头（§2 版式就是这么排的）。
//
// ⚠ 权限点没变：能不能进这一页由调用方按 `users:*` 决定；组件内的 `isAdmin` 只决定
//   表单里「角色/部门/重置密码」是否可改，与「能不能看列表」是两件事（决策 6）。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowsClockwise, MagnifyingGlass, PencilSimple, UserPlus, WarningCircle } from "@phosphor-icons/react";
import { useAuthStore } from "../stores/auth";
import { deptsApi, usersApi } from "../services/identity-resources";
import { toast } from "../lib/toast";
import type { AdminUser, Role } from "../types";
import { SkeletonRows } from "../ui";
import { ToneBadge, RoleBadge } from "./reactor";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { flattenDepts } from "./DeptTree";

interface UserForm {
  name: string;
  email: string;
  role: Role;
  departmentId: number | null;
  status: "active" | "disabled";
  password: string;
}

const emptyForm = (role: Role): UserForm => ({ name: "", email: "", role, departmentId: null, status: "active", password: "" });

const ROLE_OPTIONS: Array<[Role, string]> = [
  ["user", "普通用户"],
  ["dept_head", "部门负责人"],
  ["platform_admin", "平台管理员"],
];

export interface UsersTableProps {
  /**
   * 部门筛选，三态：
   *   `null`/缺省 = 不按部门收窄（沿用服务端按角色的可见范围）；
   *   `[]`      = **命中空集**（fail-closed，不是"不过滤"）；
   *   非空数组  = 只看这些部门（「含下级成员」由调用方用 `subtreeIdsOf()` 摊平成子树 ids）。
   * 空数组那一条别"顺手修"成不过滤：服务端 `deptIds=`（空值）会被解析成空 `Set`，
   * 一旦当成"全量"就是越权展示（子树为空反而看到全公司）。
   */
  deptIds?: number[] | null;
  /** 工具栏内、状态筛选段之后的附加控件（合并页放「含下级成员」开关） */
  toolbarExtra?: ReactNode;
  /**
   * 行数据被改动后的回调（新建/保存/启停都算）。
   * 合并页用它刷新树上的成员数徽标 —— 那个数从**全量用户**算出来，不是从本表算出来。
   */
  onChanged?: () => void;
}

export function UsersTable({ deptIds = null, toolbarExtra, onChanged }: UsersTableProps) {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === "platform_admin";
  const PAGE = 30;

  /**
   * `onChanged` 走 ref：调用方必然内联 `onChanged={() => ...}`，放进依赖会让每次渲染都重建回调。
   * （数组类的 `deptIds` 用字符串键解决，回调类只能走 ref —— 两者同一个坑。）
   */
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  });

  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "active" | "disabled">("");
  const [depts, setDepts] = useState<Array<{ id: number; path: string }>>([]);

  const [sheet, setSheet] = useState<null | "new" | AdminUser>(null);
  const [form, setForm] = useState<UserForm>(emptyForm("user"));
  const [busy, setBusy] = useState(false);
  const [newUid, setNewUid] = useState("");

  /**
   * ⚠ 依赖项用**字符串键**而不是 `deptIds` 数组本身：调用方（合并页）必然内联
   * `deptIds={[...]}`，数组每次渲染都是新引用 ⇒ useCallback 依赖变化 ⇒ 无限重取。
   * 踩过：这类"刷新风暴"在界面上表现为一直转圈，看不出是依赖问题。
   */
  const deptKey = deptIds == null ? null : deptIds.join(",");

  const load = useCallback(async () => {
    // 键 → 入参（保持三态语义，见 props 注释）
    const filter = deptKey == null ? undefined : deptKey === "" ? [] : deptKey.split(",").map(Number);
    const res = await usersApi.list({ q, status, deptIds: filter });
    setRows(res.users);
  }, [q, status, deptKey]);

  useEffect(() => {
    void load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  useEffect(() => {
    deptsApi
      .tree()
      .then((r) => setDepts(flattenDepts(r.tree)))
      .catch(() => undefined);
  }, []);

  const deptPath = useMemo(() => {
    const m = new Map(depts.map((d) => [d.id, d.path]));
    return (id: number | null) => (id != null ? m.get(id) ?? "—" : "—");
  }, [depts]);

  const openNew = (): void => {
    setForm(emptyForm("user"));
    setNewUid("");
    setSheet("new");
  };

  const openEdit = (u: AdminUser): void => {
    setForm({
      name: u.name,
      email: u.email ?? "",
      role: u.role,
      departmentId: u.dept?.id ?? null,
      status: u.status,
      password: "",
    });
    setSheet(u);
  };

  const submitNew = async (): Promise<void> => {
    if (!newUid || !form.name || !form.password) {
      toast.error("登录账号/姓名/初始密码 必填");
      return;
    }
    setBusy(true);
    try {
      await usersApi.create({
        uid: newUid,
        name: form.name,
        email: form.email || null,
        role: form.role,
        departmentId: form.departmentId,
        password: form.password,
      });
      toast.ok(`已创建本地账号 ${newUid}`);
      setSheet(null);
      setNewUid("");
      void load();
      onChangedRef.current?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patch = async (u: AdminUser): Promise<void> => {
    setBusy(true);
    const body: Record<string, unknown> = { name: form.name, email: form.email || null };
    if (isAdmin) {
      body.role = form.role;
      body.departmentId = form.departmentId;
      if (form.password) body.password = form.password;
    }
    body.status = form.status;
    try {
      await usersApi.patch(u.id, body);
      toast.ok("已保存");
      setSheet(null);
      void load();
      onChangedRef.current?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleState = async (u: AdminUser): Promise<void> => {
    try {
      if (u.status === "active") {
        await usersApi.disable(u.id);
        toast.ok(`已停用 ${u.uid}`);
      } else {
        await usersApi.patch(u.id, { status: "active" });
        toast.ok(`已启用 ${u.uid}`);
      }
      void load();
      onChangedRef.current?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // 换部门/换筛选条件都要回到第 1 页：否则第 3 页的场景下新条件只有 1 页，表格会空白
  useEffect(() => {
    setPage(1);
  }, [q, status, deptKey]);

  const visible = useMemo(() => rows?.slice((page - 1) * PAGE, page * PAGE), [rows, page]);
  const totalPages = rows ? Math.max(1, Math.ceil(rows.length / PAGE)) : 1;

  const segBtn = (v: "" | "active" | "disabled", label: string) => (
    <Button key={v || "all"} size="sm" variant={status === v ? "default" : "ghost"} className="h-7 px-2.5" onClick={() => setStatus(v)}>
      {label}
    </Button>
  );

  return (
    <div className="users-table">
      <div className="toolbar">
        <div className="search">
          <MagnifyingGlass size={15} />
          {/* ⚠ 别再加 border-none/bg-transparent：那会把搜索框的外形也抹掉（与背景融为一体，看不清边界）。
              保留 Input 自带的边框（border-input），只在高度/左内边距上适配图标。 */}
          <Input
            className="h-8 w-64 pl-8"
            placeholder="搜索账号 / 姓名"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="seg">
          {segBtn("", "全部")}
          {segBtn("active", "启用")}
          {segBtn("disabled", "停用")}
        </div>
        {toolbarExtra}
        <div className="spacer" />
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void load()}>
          <ArrowsClockwise size={14} /> 刷新
        </Button>
        {isAdmin && (
          <Button variant="default" className="gap-1.5" onClick={openNew}>
            <UserPlus size={15} /> 新建用户
          </Button>
        )}
      </div>

      <div className="tablewrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead>部门</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-[120px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null ? (
              <TableRow><TableCell colSpan={6}><SkeletonRows /></TableCell></TableRow>
            ) : visible?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="empty"><WarningCircle size={22} /><div className="t">没有匹配的用户</div><div className="s">试试调整搜索或筛选条件</div></div>
                </TableCell>
              </TableRow>
            ) : (
              visible?.map((u) => (
                <TableRow key={u.uid} className="cursor-pointer" onClick={() => openEdit(u)}>
                  <TableCell>
                    <div className="td-main">
                      <span className="ava">{u.name.slice(0, 1)}</span>
                      {/* title：列宽固定后这两行会省略号，鼠标悬停能看到全值 */}
                      <div title={`${u.name}\n${u.uid}${u.email ? `\n${u.email}` : ""}`}>
                        <div className="cell-title">{u.name}</div>
                        <div className="cell-sub mono">{u.uid}{u.email ? ` · ${u.email}` : ""}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><div className="cell-sub" title={deptPath(u.dept?.id ?? null)}>{deptPath(u.dept?.id ?? null)}</div></TableCell>
                  <TableCell><RoleBadge role={u.role} /></TableCell>
                  <TableCell><ToneBadge tone={u.source === "ad" ? "neutral" : "success"}>{u.source === "ad" ? "域账号" : "本地"}</ToneBadge></TableCell>
                  <TableCell>
                    <ToneBadge tone={u.status === "active" ? "success" : "danger"} dot>{u.status === "active" ? "启用" : "停用"}</ToneBadge>
                  </TableCell>
                  <TableCell>
                    <div className="right-actions" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => openEdit(u)}>
                        <PencilSimple size={13} /> 编辑
                      </Button>
                      {isAdmin && u.uid !== "admin" && (
                        <Button size="sm" variant="destructive" onClick={() => void toggleState(u)}>
                          {u.status === "active" ? "停用" : "启用"}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {rows && rows.length > PAGE && (
        <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            共 {rows.length} 人 · 第 {page}/{totalPages} 页
          </span>
          <div className="spacer" />
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
          <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      )}

      {/* 新建（Sheet 抽屉） */}
      <Dialog open={sheet === "new"} onOpenChange={(o) => !o && setSheet(null)}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>新建本地用户</DialogTitle>
          </DialogHeader>
          <div className="modal-body">
            <div className="field">
              <Label htmlFor="nu-uid">登录账号</Label>
              <Input id="nu-uid" value={newUid} onChange={(e) => setNewUid(e.target.value)} />
              <span className="hint">本地账号唯一标识（字母/数字/._-）</span>
            </div>
            <div className="field">
              <Label htmlFor="nu-name">姓名</Label>
              <Input id="nu-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field">
              <Label htmlFor="nu-email">邮箱</Label>
              <Input id="nu-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="field">
              <Label>角色</Label>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as Role })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map(([v, label]) => (
                    <SelectItem key={v} value={v}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="field">
              <Label>所属部门</Label>
              <Select
                value={form.departmentId != null ? String(form.departmentId) : "none"}
                onValueChange={(v) => setForm({ ...form, departmentId: v === "none" ? null : Number(v) })}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">（未指派）</SelectItem>
                  {depts.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>{d.path}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="field">
              <Label htmlFor="nu-pwd">初始密码</Label>
              <Input id="nu-pwd" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              <span className="hint">至少 8 位，仅本地账号使用</span>
            </div>
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setSheet(null)}>取消</Button>
            <Button variant="default" disabled={busy} onClick={() => void submitNew()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑（Sheet 抽屉） */}
      <Dialog open={!!sheet && sheet !== "new"} onOpenChange={(o) => !o && setSheet(null)}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>编辑用户 · {sheet !== "new" && sheet ? sheet.uid : ""}</DialogTitle>
          </DialogHeader>
          {sheet && sheet !== "new" && (
            <>
              <div className="modal-body">
                <div className="kv" style={{ marginBottom: 16 }}>
                  <div className="k">登录账号 / 来源</div>
                  <div className="v mono">{sheet.uid}</div>
                  <div style={{ marginTop: 8 }} className="flex gap-2">
                    <RoleBadge role={sheet.role} />
                    <ToneBadge tone={sheet.source === "ad" ? "neutral" : "success"}>{sheet.source === "ad" ? "域账号（AD 同步）" : "本地账号"}</ToneBadge>
                  </div>
                </div>
                <div className="field">
                  <Label htmlFor="eu-name">姓名</Label>
                  <Input id="eu-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="field">
                  <Label htmlFor="eu-email">邮箱</Label>
                  <Input id="eu-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                {isAdmin ? (
                  <>
                    <div className="field">
                      <Label>角色</Label>
                      <Select
                        value={form.role}
                        onValueChange={(v) => setForm({ ...form, role: v as Role })}
                        disabled={sheet.uid === "admin"}
                      >
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map(([v, label]) => (
                            <SelectItem key={v} value={v}>{label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {sheet.source === "ad" && <span className="hint">域账号角色由平台管理，不写回 AD</span>}
                    </div>
                    <div className="field">
                      <Label>所属部门</Label>
                      <Select
                        value={form.departmentId != null ? String(form.departmentId) : "none"}
                        onValueChange={(v) => setForm({ ...form, departmentId: v === "none" ? null : Number(v) })}
                      >
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">（未指派）</SelectItem>
                          {depts.map((d) => (
                            <SelectItem key={d.id} value={String(d.id)}>{d.path}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="hint">域账号调整仅改平台归属，不写回 AD</span>
                    </div>
                  </>
                ) : (
                  <div className="field">
                    <Label>部门</Label>
                    <Input value={deptPath(sheet.dept?.id ?? null)} disabled />
                  </div>
                )}
                <div className="field">
                  <Label>状态</Label>
                  {form.status === "active" ? (
                    <div className="flex items-center gap-2.5">
                      <ToneBadge tone="success" dot>启用中</ToneBadge>
                    </div>
                  ) : (
                    <Button variant="destructive" size="sm" onClick={() => setForm({ ...form, status: "active" })}>启用账号</Button>
                  )}
                </div>
                {isAdmin && sheet.source === "local" && (
                  <div className="field">
                    <Label htmlFor="eu-pwd">重置密码</Label>
                    <Input id="eu-pwd" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                    <span className="hint">留空则不修改</span>
                  </div>
                )}
              </div>
              <DialogFooter className="modal-foot">
                <Button variant="outline" onClick={() => setSheet(null)}>取消</Button>
                <Button variant="default" disabled={busy} onClick={() => void patch(sheet)}>保存</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
