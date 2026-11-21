// 扩展与接入 · 托管 MCP 服务（治理平面 P0）
//
// 为什么这页要存在：企业托管的 MCP 是「企业为准」的能力接入 —— 平台管理员在这里登记
// HTTP/SSE 型 MCP 服务、托管共享凭据（只存服务端，端侧经 relay 调用）、为每个工具定
// 允许/需确认/禁用三档；策略随 /desktop/policy 下发，端侧两级强制（注册期过滤 + 执行期闸）。
// spec 见 docs/未完成-MCP治理平面-spec-v1.md。
//
// 交互纪律（沿用全管理台惯例）：
//  - 登记走服务端 fail-fast：探测失败直接 422，本页不保存半成品；
//  - 手动同步失败 = ok:false + 保留旧快照，行上显示「同步异常」并给原因；
//  - headers 只写不读：编辑时既有头以「********」掩码预填，回传掩码即保持原值；
//  - 删除确认写明后果（端侧下次策略刷新即失去该服务）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, LockSimple, PencilSimple, Play, Plus, Trash } from "@phosphor-icons/react";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import {
  groupTools,
  mcpApi,
  pendingNewCount,
  policyOf,
  problemCount,
  serverLabel,
  serverStatus,
  type AdminMcpServer,
  type McpServerInput,
  type McpToolPolicy,
  type McpToolSnapshotEntry,
} from "../services/mcp";

const STATUS_TONE = {
  disabled: "neutral",
  "sync-error": "danger",
  ok: "success",
} as const;
const STATUS_TEXT = {
  disabled: "已停用",
  "sync-error": "同步异常",
  ok: "正常",
} as const;

/** 编辑表单里的动态 header 行：value 允许 "********"（= 保持原值）。 */
interface HeaderRow {
  name: string;
  value: string;
}

interface EditForm {
  id: string | null;
  name: string;
  displayName: string;
  type: "http" | "sse";
  url: string;
  auth: "none" | "shared";
  headers: HeaderRow[];
  enabled: boolean;
}

function formFromRow(row: AdminMcpServer | null): EditForm {
  if (!row) {
    return { id: null, name: "", displayName: "", type: "http", url: "", auth: "none", headers: [], enabled: true };
  }
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    type: row.type,
    url: row.url,
    auth: row.auth,
    // 既有头以掩码预填：回传 "********" 服务端即保持原值（绝不把掩码当新值写库）
    headers: row.headerNames.map((header) => ({ name: header.name, value: "********" })),
    enabled: row.enabled,
  };
}

export function McpServers() {
  const [rows, setRows] = useState<AdminMcpServer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  /** 策略抽屉当前服务与草稿（工具名 → 三档）。 */
  const [policyRow, setPolicyRow] = useState<AdminMcpServer | null>(null);
  const [policyDraft, setPolicyDraft] = useState<Record<string, McpToolPolicy>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await mcpApi.list();
      setRows(result.servers);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleOpenCreate = useCallback(() => setEditForm(formFromRow(null)), []);
  const handleOpenEdit = useCallback((row: AdminMcpServer) => setEditForm(formFromRow(row)), []);

  const handleSave = useCallback(async () => {
    if (!editForm) return;
    const name = editForm.name.trim();
    if (!name) return toast.error("请输入服务名（工具名前缀 mcp__服务名__*）");
    if (!editForm.url.trim()) return toast.error("请输入上游地址");
    if (editForm.auth === "shared" && editForm.headers.every((header) => !header.name.trim())) {
      return toast.error("共享凭据至少配置一个请求头");
    }
    const headers: Record<string, string> = {};
    for (const header of editForm.headers) {
      if (!header.name.trim()) continue;
      headers[header.name.trim()] = header.value;
    }
    const payload: McpServerInput = {
      name,
      displayName: editForm.displayName.trim(),
      type: editForm.type,
      url: editForm.url.trim(),
      auth: editForm.auth,
      ...(editForm.auth === "shared" ? { headers } : {}),
      enabled: editForm.enabled,
    };
    setBusy(true);
    try {
      if (editForm.id) {
        const { server } = await mcpApi.patch(editForm.id, payload);
        toast.ok(`已保存「${serverLabel(server)}」（连接字段有变化时会自动重探）`);
      } else {
        const { server } = await mcpApi.create(payload);
        toast.ok(`登记成功：${server.toolsSnapshot.length} 个工具已入快照`);
      }
      setEditForm(null);
      void load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [editForm, load]);

  const handleDelete = useCallback(
    async (row: AdminMcpServer) => {
      const count = row.toolsSnapshot.length;
      if (
        !window.confirm(
          `确定删除托管 MCP「${serverLabel(row)}」吗？端侧在下次策略刷新后立即失去该服务的全部${count}个工具，此操作不可恢复。`,
        )
      ) {
        return;
      }
      try {
        await mcpApi.remove(row.id);
        toast.ok("删除成功");
        void load();
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [load],
  );

  const handleProbe = useCallback(async (row: AdminMcpServer) => {
    setTestingId(row.id);
    try {
      const result = await mcpApi.probe(row.id);
      if (result.ok) {
        toast.ok(`连通正常：${result.toolCount ?? 0} 个工具 · ${result.latencyMs ?? 0}ms`);
      } else {
        toast.error(result.error ?? "探测失败");
      }
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setTestingId(null);
    }
  }, []);

  const handleSync = useCallback(
    async (row: AdminMcpServer) => {
      setSyncingId(row.id);
      try {
        const result = await mcpApi.sync(row.id);
        if (result.ok) {
          toast.ok(`同步成功：${result.toolCount ?? 0} 个工具（新增未固化 ${result.newCount ?? 0}，不合格 ${result.problemCount ?? 0}）`);
          setEditForm(null);
          void load();
        } else {
          toast.error(result.error ?? "同步失败（已保留旧快照）");
          void load();
        }
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        setSyncingId(null);
      }
    },
    [load],
  );

  const handleToggle = useCallback(
    async (row: AdminMcpServer, enabled: boolean) => {
      try {
        await mcpApi.patch(row.id, { enabled });
        toast.ok(enabled ? "已启用（端侧下次策略刷新生效）" : "已停用（端侧立即失去该服务）");
        void load();
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [load],
  );

  const openPolicy = useCallback((row: AdminMcpServer) => {
    setPolicyRow(row);
    setPolicyDraft({ ...row.toolPolicy });
  }, []);

  const savePolicy = useCallback(async () => {
    if (!policyRow) return;
    setBusy(true);
    try {
      await mcpApi.setToolPolicy(policyRow.id, policyDraft);
      toast.ok("策略已保存（随 /desktop/policy 下发端侧）");
      setPolicyRow(null);
      void load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [policyDraft, policyRow, load]);

  const grouped = useMemo(() => (policyRow ? groupTools(policyRow.toolsSnapshot) : { readOnly: [], writing: [] }), [policyRow]);

  return (
    <div>
      <PageHead
        title="MCP 服务"
        desc="登记企业托管的 MCP 服务；凭据只存服务端，端侧经 relay 调用；逐工具三档策略随 /desktop/policy 下发"
      />

      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <Button size="sm" variant="outline" className="gap-1.5" disabled={loading} onClick={() => void load()}>
          <ArrowClockwise size={14} /> 刷新
        </Button>
        <div className="spacer" />
        {rows ? <ToneBadge tone="info">共 {rows.length} 个服务</ToneBadge> : null}
        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={handleOpenCreate}>
          <Plus size={14} /> 登记服务
        </Button>
      </div>

      <div className="tablewrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[220px]">服务（工具名前缀）</TableHead>
              <TableHead>地址</TableHead>
              <TableHead className="w-[150px]">凭据</TableHead>
              <TableHead className="w-[170px]">状态</TableHead>
              <TableHead className="w-[120px]">工具</TableHead>
              <TableHead className="w-[220px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <SkeletonRows />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-foreground-subtle">
                  还没有托管 MCP 服务；点「登记服务」接入第一个（需可从服务端访问的 http/https 地址）
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const status = serverStatus(row);
                const newCount = pendingNewCount(row);
                const badCount = problemCount(row);
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="font-medium">{serverLabel(row)}</div>
                      <div className="text-[11px] text-foreground-subtle">mcp__{row.name}__*</div>
                    </TableCell>
                    <TableCell className="mono text-[12px]">{row.url}</TableCell>
                    <TableCell>
                      {row.auth === "shared" ? (
                        <div className="flex flex-wrap gap-1">
                          {row.headerNames.map((header) => (
                            <span
                              key={header.name}
                              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground-subtle"
                              title="值末四位；明文只存服务端"
                            >
                              {header.name} ····{header.last4}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-foreground-subtle">无需认证</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <ToneBadge tone={STATUS_TONE[status]} dot>
                          {STATUS_TEXT[status]}
                        </ToneBadge>
                        {row.syncError ? (
                          <span className="text-[11px] text-foreground-subtle" title={row.syncError}>
                            {row.syncError.length > 24 ? `${row.syncError.slice(0, 24)}…` : row.syncError}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span>{row.toolsSnapshot.length}</span>
                      {newCount > 0 ? (
                        <ToneBadge tone="warn">新 {newCount}</ToneBadge>
                      ) : null}
                      {badCount > 0 ? <ToneBadge tone="danger">不可用 {badCount}</ToneBadge> : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" disabled={syncingId === row.id} onClick={() => void handleSync(row)}>
                          <ArrowClockwise size={13} /> {syncingId === row.id ? "同步中…" : "同步"}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={testingId === row.id} onClick={() => void handleProbe(row)}>
                          <Play size={13} /> {testingId === row.id ? "测试中…" : "测试"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openPolicy(row)}>
                          策略
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleOpenEdit(row)}>
                          <PencilSimple size={13} /> 修改
                        </Button>
                        <Switch
                          checked={row.enabled}
                          onCheckedChange={(checked) => void handleToggle(row, checked)}
                          aria-label={row.enabled ? "停用" : "启用"}
                        />
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void handleDelete(row)}>
                          <Trash size={13} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* 登记 / 修改 */}
      <Dialog open={editForm !== null} onOpenChange={(open) => (!open ? setEditForm(null) : undefined)}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{editForm?.id ? "修改托管 MCP 服务" : "登记托管 MCP 服务"}</DialogTitle>
          </DialogHeader>
          {editForm ? (
            <div className="space-y-3">
              <div className="field">
                <Label>服务名（工具名前缀，建后不可修改）</Label>
                <Input
                  value={editForm.name}
                  disabled={editForm.id !== null}
                  placeholder="crm-tools"
                  onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
                />
                <span className="hint">小写字母开头，仅小写字母/数字/短横线；端侧工具名即 mcp__服务名__工具名</span>
              </div>
              <div className="field">
                <Label>展示名（可选）</Label>
                <Input
                  value={editForm.displayName}
                  onChange={(event) => setEditForm({ ...editForm, displayName: event.target.value })}
                />
              </div>
              <div className="field">
                <Label>类型</Label>
                <Select value={editForm.type} onValueChange={(value) => setEditForm({ ...editForm, type: value as "http" | "sse" })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">Streamable HTTP</SelectItem>
                    <SelectItem value="sse">SSE</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="field">
                <Label>上游地址</Label>
                <Input
                  className="mono"
                  value={editForm.url}
                  placeholder="https://mcp.example.com/mcp"
                  onChange={(event) => setEditForm({ ...editForm, url: event.target.value })}
                />
                <span className="hint">http/https，不带查询参数；凭据只放下面的请求头，不写进地址</span>
              </div>
              <div className="field">
                <Label>认证</Label>
                <Select value={editForm.auth} onValueChange={(value) => setEditForm({ ...editForm, auth: value as "none" | "shared" })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">无需认证</SelectItem>
                    <SelectItem value="shared">共享凭据（请求头）</SelectItem>
                  </SelectContent>
                </Select>
                {editForm.auth === "shared" ? (
                  <span className="hint">
                    共享凭据等于把这份凭据的数据权限给了能用的人；值只存服务端（AES 封存），端侧经 relay 调用拿不到明文
                  </span>
                ) : null}
              </div>
              {editForm.auth === "shared" ? (
                <div className="field">
                  <Label>凭据请求头</Label>
                  <div className="space-y-2">
                    {editForm.headers.map((header, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <Input
                          className="mono w-[180px]"
                          placeholder="Authorization"
                          value={header.name}
                          onChange={(event) => {
                            const next = [...editForm.headers];
                            next[index] = { ...header, name: event.target.value };
                            setEditForm({ ...editForm, headers: next });
                          }}
                        />
                        <Input
                          className="mono flex-1"
                          placeholder="Bearer sk-…"
                          value={header.value}
                          onChange={(event) => {
                            const next = [...editForm.headers];
                            next[index] = { ...header, value: event.target.value };
                            setEditForm({ ...editForm, headers: next });
                          }}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          onClick={() =>
                            setEditForm({ ...editForm, headers: editForm.headers.filter((_, i) => i !== index) })
                          }
                        >
                          <Trash size={13} />
                        </Button>
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => setEditForm({ ...editForm, headers: [...editForm.headers, { name: "", value: "" }] })}
                    >
                      <Plus size={13} /> 添加请求头
                    </Button>
                  </div>
                  {editForm.id ? <span className="hint">既有头的值以 ******** 显示：不改就原样保留，改了才覆盖</span> : null}
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <Switch checked={editForm.enabled} onCheckedChange={(checked) => setEditForm({ ...editForm, enabled: checked })} />
                <span className="text-sm">启用（停用后端侧立即失去该服务）</span>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditForm(null)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void handleSave()}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 三档策略 */}
      <Dialog open={policyRow !== null} onOpenChange={(open) => (!open ? setPolicyRow(null) : undefined)}>
        <DialogContent className="max-w-[720px]">
          <DialogHeader>
            <DialogTitle>
              工具策略 · {policyRow ? serverLabel(policyRow) : ""}
              {policyRow ? (
                <span className="ml-2 text-[12px] font-normal text-foreground-subtle">
                  {policyRow.toolsSnapshot.length} 个工具
                  <LockSimple size={12} className="mx-1 inline" />
                  新增未登记的工具一律「需确认」
                </span>
              ) : null}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[420px] space-y-1 overflow-y-auto">
            {groupLabelRow("只读工具", grouped.readOnly)}
            {groupLabelRow("写入 / 其余工具", grouped.writing)}
            {[...grouped.readOnly, ...grouped.writing].map((tool) => (
              <ToolPolicyRow
                key={tool.name}
                tool={tool}
                value={policyRow ? policyOf(policyRow, tool.name) : "ask"}
                draft={policyDraft}
                onChange={(name, value) => setPolicyDraft({ ...policyDraft, [name]: value })}
              />
            ))}
            {policyRow && policyRow.toolsSnapshot.length === 0 ? (
              <div className="py-6 text-center text-sm text-foreground-subtle">
                快照为空（登记时未拉到工具清单）——先点列表里的「同步」
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPolicyRow(null)}>
              取消
            </Button>
            <Button disabled={busy || !policyRow || policyRow.toolsSnapshot.length === 0} onClick={() => void savePolicy()}>
              {busy ? "保存中…" : "保存策略"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function groupLabelRow(label: string, tools: McpToolSnapshotEntry[]) {
  if (tools.length === 0) return null;
  return (
    <div className="mt-2 px-1 text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
      {label}（{tools.length}）
    </div>
  );
}

function ToolPolicyRow({
  tool,
  value,
  draft,
  onChange,
}: {
  tool: McpToolSnapshotEntry;
  value: McpToolPolicy;
  draft: Record<string, McpToolPolicy>;
  onChange: (name: string, value: McpToolPolicy) => void;
}) {
  const effective = draft[tool.name] ?? value;
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/40">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="mono truncate text-[12px]">{tool.name}</span>
          {tool.isNew ? <ToneBadge tone="warn">新</ToneBadge> : null}
          {tool.problem ? <ToneBadge tone="danger">不可用</ToneBadge> : null}
        </div>
        {tool.problem ? (
          <div className="text-[11px] text-foreground-subtle" title={tool.problem}>
            {tool.problem}
          </div>
        ) : tool.description ? (
          <div className="truncate text-[11px] text-foreground-subtle" title={tool.description}>
            {tool.description}
          </div>
        ) : null}
      </div>
      {tool.problem ? (
        <span className="text-[11px] text-foreground-subtle">参数结构不合格 · 已停用</span>
      ) : (
        <Select value={effective} onValueChange={(next) => onChange(tool.name, next as McpToolPolicy)}>
          <SelectTrigger className="w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="allow">允许</SelectItem>
            <SelectItem value="ask">需确认</SelectItem>
            <SelectItem value="block">禁用</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
