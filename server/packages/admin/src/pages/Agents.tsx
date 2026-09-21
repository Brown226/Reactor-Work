// 内容与能力 · Agent 数字人（A-1/A-3）
// 平台级 Agent 定义 = 身份形象 + 模型 + 技能组合 + 发布范围；桌面端新建会话时可选并应用。
// 页面骨架参照 BuildingAI ai/agent 管理页（表格 + 抽屉表单）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { PencilSimple, Plus, Robot, Trash } from "@phosphor-icons/react";
import {
  agentsApi,
  agentTaxonomyApi,
  AGENT_LIMITS,
  AGENT_POLICY_MODE_LABELS,
  AGENT_SESSION_TYPE_LABELS,
  AGENT_THINKING_LEVELS,
  type AdminAgent,
  type AgentCategoryItem,
  type AgentPolicyMode,
  type AgentScope,
  type AgentSessionType,
  type AgentTagItem,
  type AgentThinkingLevel,
} from "../services/agents";
import { AgentTaxonomyDialog } from "../components/AgentTaxonomyDialog";
import { modelsApi, providersApi, type AdminModel } from "../services/gateway-admin";
import { deptsApi } from "../services/identity-resources";
import { skillsApi, type AdminSkill, type SkillScopeKind } from "../services/skills";
import { toast } from "../lib/toast";
import { PageHead } from "../ui";
import { ToneBadge } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import type { DeptNode, Role } from "../types";

const ROLE_LABELS: Record<Role, string> = {
  platform_admin: "平台管理员",
  dept_head: "部门负责人",
  user: "普通用户",
};

const SCOPE_LABELS: Record<SkillScopeKind, string> = {
  all: "全公司",
  role: "按角色",
  dept: "按部门",
  user: "按账号",
};

interface AgentForm {
  name: string;
  title: string;
  description: string;
  emoji: string;
  persona: string;
  modelRef: string; // "provider/modelId" 或空
  skills: string[];
  enabled: boolean;
  scopeKind: SkillScopeKind;
  roles: Role[];
  deptIds: number[];
  uids: string;
  /* v1 市场字段 */
  tags: string[]; // 从标签库多选（受控词表）
  /** 分类 code；"" = 未分类 */
  category: string;
  official: boolean;
  author: string;
  published: boolean;
  /* v1 预设包 */
  sessionType: AgentSessionType | "";
  policyMode: AgentPolicyMode | "";
  thinkingLevel: AgentThinkingLevel | "";
  starters: string; // 每行一条
}

const emptyForm = (): AgentForm => ({
  name: "",
  title: "",
  description: "",
  emoji: "🤖",
  persona: "",
  modelRef: "",
  skills: [],
  enabled: true,
  scopeKind: "all",
  roles: [],
  deptIds: [],
  uids: "",
  tags: [],
  category: "",
  official: false,
  author: "",
  published: false,
  sessionType: "",
  policyMode: "",
  thinkingLevel: "",
  starters: "",
});

/** 每行一条（推荐开场白可含空格，不能用逗号切） */
const splitLines = (raw: string): string[] =>
  [...new Set(raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];

function flattenDepts(nodes: DeptNode[], out: Array<{ id: number; path: string }> = []): Array<{ id: number; path: string }> {
  for (const node of nodes) {
    out.push({ id: node.id, path: node.path });
    if (node.children?.length) flattenDepts(node.children, out);
  }
  return out;
}

function scopeLabel(scope: AgentScope): string {
  if (scope.kind === "all") return "全公司";
  if (scope.kind === "role") return scope.roles.map((r) => ROLE_LABELS[r]).join("、") || "按角色（空）";
  if (scope.kind === "dept") return `${scope.deptIds.length} 个部门`;
  return scope.uids.join("、") || "按账号（空）";
}

export function Agents() {
  const [rows, setRows] = useState<AdminAgent[] | null>(null);
  const [skills, setSkills] = useState<AdminSkill[]>([]);
  // 技能选择器：默认只显示**已选的 chip**，点「添加技能」才展开带搜索的列表。
  // 原来是一长列勾选框（6 个技能就占 150px 高，再多就成弹窗里最长的一块），这是弹窗偏「密」的主因。
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [models, setModels] = useState<AdminModel[]>([]);
  const [providerCodes, setProviderCodes] = useState<Map<number, string>>(new Map());
  const [depts, setDepts] = useState<Array<{ id: number; path: string }>>([]);
  /** 字典（分类 + 标签库）：后台可维护，表单的下拉/多选全部由它驱动 */
  const [taxonomy, setTaxonomy] = useState<{ categories: AgentCategoryItem[]; tags: AgentTagItem[] }>({
    categories: [],
    tags: [],
  });
  const [dictOpen, setDictOpen] = useState(false);
  const [sheet, setSheet] = useState<null | "new" | AdminAgent>(null);
  const [form, setForm] = useState<AgentForm>(emptyForm());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [a, s, m, p, d, t] = await Promise.all([
      agentsApi.list(),
      skillsApi.list(),
      modelsApi.list(),
      providersApi.list(),
      deptsApi.tree(),
      agentTaxonomyApi.list(),
    ]);
    setRows(a.agents);
    setSkills(s.skills);
    setModels(m.models);
    setProviderCodes(new Map(p.providers.map((provider) => [provider.id, provider.code])));
    setDepts(flattenDepts(d.tree));
    setTaxonomy({ categories: t.categories, tags: t.tags });
  }, []);

  useEffect(() => {
    void load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  const modelOptions = useMemo(
    () =>
      models
        .filter((m) => m.enabled)
        .map((m) => ({
          ref: `${providerCodes.get(m.providerId) ?? m.providerId}/${m.model}`,
          label: m.displayName || m.model,
        })),
    [models, providerCodes],
  );

  /**
   * 分类下拉的可选项：**启用的分类** + 「当前值（即便它已被停用）」。
   * 为何要补当前值：否则编辑一个分类已被停用的老专家时，下拉的 value 找不到对应项，
   * 会静默显示成「未分类」——管理员一保存就把分类改没了（典型的隐性数据损坏）。
   */
  const categoryOptions = useMemo(() => {
    const enabled = taxonomy.categories.filter((c) => c.enabled);
    const current = taxonomy.categories.find((c) => c.code === form.category);
    if (current && !current.enabled) return [...enabled, current];
    return enabled;
  }, [taxonomy.categories, form.category]);

  /** 标签库同理：只列启用的 + 该专家已有的（已停用标签不能因此默默丢掉） */
  const tagOptions = useMemo(() => {
    const enabled = taxonomy.tags.filter((t) => t.enabled);
    const keep = taxonomy.tags.filter((t) => !t.enabled && form.tags.includes(t.name));
    return [...enabled, ...keep];
  }, [taxonomy.tags, form.tags]);

  const openNew = (): void => {
    setForm(emptyForm());
    setSheet("new");
  };

  const openEdit = (agent: AdminAgent): void => {
    setForm({
      name: agent.name,
      title: agent.title,
      description: agent.description ?? "",
      emoji: agent.emoji ?? "",
      persona: agent.persona ?? "",
      modelRef: agent.provider && agent.modelId ? `${agent.provider}/${agent.modelId}` : "",
      skills: [...agent.skills],
      enabled: agent.enabled,
      scopeKind: agent.scope.kind,
      roles: [...agent.scope.roles],
      deptIds: [...agent.scope.deptIds],
      uids: agent.scope.uids.join(", "),
      tags: [...agent.tags],
      category: agent.category ?? "",
      official: agent.official,
      author: agent.author ?? "",
      published: agent.publishedAt !== null,
      sessionType: agent.preset.sessionType ?? "",
      policyMode: agent.preset.policyMode ?? "",
      thinkingLevel: agent.preset.thinkingLevel ?? "",
      starters: agent.preset.starters.join("\n"),
    });
    setSheet(agent);
  };

  const submit = async (): Promise<void> => {
    if (!form.name.trim() || !form.title.trim()) {
      toast.error("标识 / 名称必填");
      return;
    }
    const scope: AgentScope = {
      kind: form.scopeKind,
      roles: form.scopeKind === "role" ? form.roles : [],
      deptIds: form.scopeKind === "dept" ? form.deptIds : [],
      uids:
        form.scopeKind === "user"
          ? form.uids.split(/[,，\s]+/).map((u) => u.trim()).filter(Boolean)
          : [],
    };
    if (scope.kind === "role" && scope.roles.length === 0) return void toast.error("按角色下发需至少选一个角色");
    if (scope.kind === "dept" && scope.deptIds.length === 0) return void toast.error("按部门下发需至少选一个部门");
    if (scope.kind === "user" && scope.uids.length === 0) return void toast.error("按账号下发需至少填一个账号");

    const [provider, ...rest] = form.modelRef ? form.modelRef.split("/") : [];
    const modelId = rest.join("/");
    const body = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      emoji: form.emoji.trim() || null,
      persona: form.persona.trim() || null,
      provider: form.modelRef ? provider ?? null : null,
      modelId: form.modelRef ? modelId || null : null,
      skills: form.skills,
      enabled: form.enabled,
      scope,
      tags: form.tags,
      category: form.category || null,
      official: form.official,
      author: form.author.trim() || null,
      published: form.published,
      // 预设包：空串 = 不指定（服务端落 null）
      sessionType: form.sessionType || null,
      policyMode: form.policyMode || null,
      thinkingLevel: form.thinkingLevel || null,
      starters: splitLines(form.starters),
    };
    setBusy(true);
    try {
      if (sheet === "new") await agentsApi.create({ name: form.name.trim().toLowerCase(), ...body });
      else if (sheet) await agentsApi.patch(sheet.id, body);
      toast.ok("已保存");
      setSheet(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (agent: AdminAgent): Promise<void> => {
    try {
      await agentsApi.patch(agent.id, { enabled: !agent.enabled });
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async (agent: AdminAgent): Promise<void> => {
    if (!window.confirm(`删除 Agent「${agent.title}」？桌面端将不再下发。`)) return;
    try {
      await agentsApi.remove(agent.id);
      toast.ok(`已删除 ${agent.name}`);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div>
      <PageHead
        title="Agent 数字人"
        desc="平台级 Agent 定义：人设 + 模型 + 技能组合 + 发布范围；桌面端新建会话时可选并应用"
      />
      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <ToneBadge tone="info">服务端为真源 · 桌面端新建会话时选择</ToneBadge>
        <div className="spacer" />
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDictOpen(true)}>
          分类与标签
        </Button>
        <Button size="sm" variant="default" className="gap-1.5" onClick={openNew}>
          <Plus size={14} /> 新增 Agent
        </Button>
      </div>

      {/* 卡片网格版式（对齐 BuildingAI 智能体工作台）：
          首格是**虚线「创建」卡**，其余是智能体卡 —— 标题+时间 / 描述两行截断 / 标签行 / 页脚（归属+状态）。
          只换呈现层：数据、表单、分类标签对话框全部沿用原有实现，功能面一行未动。 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <button
          type="button"
          onClick={openNew}
          className="rounded-lg border border-dashed border-border bg-card p-4 text-left transition-colors hover:bg-muted/50"
        >
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <Plus size={16} /> 创建 Agent
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            人设 + 模型 + 技能组合 + 发布范围；发布后桌面端新建会话即可选择
          </p>
          <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Robot size={14} /> 从空白开始
            </span>
            <span
              className="inline-flex items-center gap-1 hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                setDictOpen(true);
              }}
            >
              分类与标签
            </span>
          </div>
        </button>

        {rows === null ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-lg border border-border bg-card p-4">
              <div className="h-9 w-9 rounded-md bg-muted" />
              <div className="mt-3 h-4 w-1/2 rounded bg-muted" />
              <div className="mt-2 h-3 w-full rounded bg-muted" />
              <div className="mt-2 h-3 w-2/3 rounded bg-muted" />
            </div>
          ))
        ) : rows.length === 0 ? (
          <div className="col-span-full rounded-lg border border-border bg-card">
            <div className="empty">
              <Robot size={22} />
              <div className="t">还没有 Agent</div>
              <div className="s">新增一个 Agent，桌面端新建会话时即可选择</div>
            </div>
          </div>
        ) : (
          rows.map((agent) => (
            <div key={agent.id} className="flex flex-col rounded-lg border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-base">
                  {agent.emoji ? agent.emoji : <Robot size={16} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold">{agent.title}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {agent.provider && agent.modelId ? `${agent.provider}/${agent.modelId}` : "默认模型"}
                    {" · "}
                    {scopeLabel(agent.scope)}
                  </div>
                </div>
              </div>

              <p className="mt-2.5 line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-muted-foreground">
                {agent.description || "—"}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {agent.skills.length === 0 ? (
                  <span className="rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    不限制技能
                  </span>
                ) : (
                  agent.skills.slice(0, 3).map((s) => (
                    <span
                      key={s}
                      className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {s}
                    </span>
                  ))
                )}
                {agent.skills.length > 3 ? (
                  <span className="text-[11px] text-muted-foreground">+{agent.skills.length - 3}</span>
                ) : null}
              </div>

              <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2.5">
                <span className="mono truncate text-[11px] text-muted-foreground">{agent.name}</span>
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {agent.enabled ? (
                    <ToneBadge tone="accent">启用</ToneBadge>
                  ) : (
                    <ToneBadge tone="danger">停用</ToneBadge>
                  )}
                  {agent.publishedAt ? <ToneBadge tone="info">已上架</ToneBadge> : <ToneBadge tone="warn">草稿</ToneBadge>}
                  {agent.official ? <ToneBadge tone="accent">特邀</ToneBadge> : null}
                </div>
              </div>

              {/* 操作放到卡片底部：三个文字按钮挤在标题行右侧，会把标题压成「代…」
                  （截图里的问题）—— 标题行只留名字与元信息，操作独占一行右对齐。 */}
              <div className="mt-2 flex items-center justify-end gap-1">
                <Button size="sm" variant="ghost" className="gap-1" onClick={() => openEdit(agent)}>
                  <PencilSimple size={14} /> 编辑
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void toggle(agent)}>
                  {agent.enabled ? "停用" : "启用"}
                </Button>
                <Button size="sm" variant="ghost" className="gap-1" onClick={() => void remove(agent)}>
                  <Trash size={14} />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <Dialog open={sheet !== null} onOpenChange={(open) => { if (!open) setSheet(null); }}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>{sheet === "new" ? "新增 Agent" : "编辑 Agent"}</DialogTitle>
          </DialogHeader>
          <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-name">标识（小写字母/数字/连字符）</Label>
              <Input
                id="agent-name"
                value={form.name}
                disabled={sheet !== "new"}
                placeholder="office-helper"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-[80px_1fr] gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="agent-emoji">图标</Label>
                <Input
                  id="agent-emoji"
                  value={form.emoji}
                  onChange={(e) => setForm((f) => ({ ...f, emoji: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="agent-title">名称</Label>
                <Input
                  id="agent-title"
                  value={form.title}
                  placeholder="办公助手"
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-desc">描述</Label>
              <Input
                id="agent-desc"
                value={form.description}
                placeholder="帮你写周报与整理材料"
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-persona">人设（追加到系统提示）</Label>
              <Textarea
                id="agent-persona"
                rows={5}
                value={form.persona}
                placeholder="你是企业内部办公助手，回答简洁、先给结论。"
                onChange={(e) => setForm((f) => ({ ...f, persona: e.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>模型（缺省用会话默认）</Label>
              <Select value={form.modelRef || "__default__"} onValueChange={(v) => setForm((f) => ({ ...f, modelRef: v === "__default__" ? "" : v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">（默认模型）</SelectItem>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.ref} value={option.ref}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>技能组合（不选 = 不限制）</Label>

              {/* 已选技能：chip 形式，× 直接移除。技能再多也只占一行。 */}
              <div className="flex flex-wrap items-center gap-1.5">
                {form.skills.length === 0 ? (
                  <span className="rounded-md border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                    不限制（未选具体技能）
                  </span>
                ) : (
                  form.skills.map((name) => (
                    <span
                      key={name}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px]"
                    >
                      {name}
                      <button
                        type="button"
                        aria-label={`移除技能 ${name}`}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setForm((f) => ({ ...f, skills: f.skills.filter((n) => n !== name) }))}
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 px-2 text-[11px]"
                  disabled={skills.length === 0}
                  onClick={() => setSkillOpen((o) => !o)}
                >
                  <Plus size={12} /> 添加技能
                </Button>
              </div>

              {/* 展开后才出现：搜索框 + 限高滚动列表（点一下即切换选中）。
                  没有技能时按钮直接禁用，并说明去哪里创建。 */}
              {skillOpen ? (
                <div className="mt-1.5 rounded-lg border border-border">
                  <div className="border-b border-border p-2">
                    <Input
                      value={skillFilter}
                      autoFocus
                      placeholder="搜索技能名称 / 标题 / 标识"
                      className="h-7 text-xs"
                      onChange={(e) => setSkillFilter(e.target.value)}
                    />
                  </div>
                  <div className="max-h-[200px] overflow-auto p-1">
                    {skills.length === 0 ? (
                      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        还没有技能（先到 Skills 页创建）
                      </div>
                    ) : (
                      skills
                        .filter((s) => {
                          const q = skillFilter.trim().toLowerCase();
                          if (!q) return true;
                          return s.title.toLowerCase().includes(q) || s.name.toLowerCase().includes(q);
                        })
                        .map((s) => {
                          const on = form.skills.includes(s.name);
                          return (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() =>
                                setForm((f) => ({
                                  ...f,
                                  skills: on ? f.skills.filter((n) => n !== s.name) : [...f.skills, s.name],
                                }))
                              }
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                            >
                              <span className={on ? "text-foreground" : "text-muted-foreground"}>
                                {on ? "✓" : "+"}
                              </span>
                              <span className="font-medium">{s.title}</span>
                              <span className="mono text-[11px] text-muted-foreground">{s.name}</span>
                              {s.enabled ? null : (
                                <span className="text-[11px] text-muted-foreground">（已停用）</span>
                              )}
                            </button>
                          );
                        })
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-between rounded border px-3 py-2" style={{ borderColor: "var(--line)" }}>
              <span style={{ fontSize: 13 }}>启用</span>
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
            </div>

            {/* ===== v1 市场字段（上架后才进桌面端专家市场）===== */}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label>分类</Label>
                <Select
                  value={form.category || "__none__"}
                  onValueChange={(v) => setForm((f) => ({ ...f, category: v === "__none__" ? "" : v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">（未分类）</SelectItem>
                    {categoryOptions.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.label}
                        {c.enabled ? "" : "（已停用）"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="cell-sub">分类在「分类与标签」里维护</span>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="agent-author">作者（卡片展示）</Label>
                <Input
                  id="agent-author"
                  value={form.author}
                  placeholder="平台运营"
                  onChange={(e) => setForm((f) => ({ ...f, author: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>标签（受控词表，最多 {AGENT_LIMITS.tags} 个）</Label>
              <div style={{ maxHeight: 140, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 8 }}>
                {tagOptions.length === 0 ? (
                  <div className="cell-sub">标签库是空的 —— 先到「分类与标签」里新增几个</div>
                ) : (
                  tagOptions.map((tag) => (
                    <label key={tag.name} className="flex items-center gap-2" style={{ fontSize: 12.5, padding: "2px 0" }}>
                      <input
                        type="checkbox"
                        checked={form.tags.includes(tag.name)}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            tags: e.target.checked
                              ? [...f.tags, tag.name].slice(0, AGENT_LIMITS.tags)
                              : f.tags.filter((n) => n !== tag.name),
                          }))
                        }
                      />
                      {tag.name}
                      {tag.enabled ? "" : <span className="cell-sub">（已停用）</span>}
                    </label>
                  ))
                )}
              </div>
            </div>
            <div className="flex items-center justify-between rounded border px-3 py-2" style={{ borderColor: "var(--line)" }}>
              <div>
                <div style={{ fontSize: 13 }}>上架到专家市场</div>
                <div className="cell-sub">未上架 = 草稿，桌面端看不到</div>
              </div>
              <Switch checked={form.published} onCheckedChange={(v) => setForm((f) => ({ ...f, published: v }))} />
            </div>
            <div className="flex items-center justify-between rounded border px-3 py-2" style={{ borderColor: "var(--line)" }}>
              <div>
                <div style={{ fontSize: 13 }}>特邀专家</div>
                <div className="cell-sub">卡片上的特邀徐标（官方 / 认证）</div>
              </div>
              <Switch checked={form.official} onCheckedChange={(v) => setForm((f) => ({ ...f, official: v }))} />
            </div>

            {/* ===== v1 预设包（新建会话时桌面端预置，用户仍可改）===== */}
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-1.5">
                <Label>会话类型</Label>
                <Select value={form.sessionType || "__none__"} onValueChange={(v) => setForm((f) => ({ ...f, sessionType: v === "__none__" ? "" : (v as AgentSessionType) }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">（不指定）</SelectItem>
                    {(Object.keys(AGENT_SESSION_TYPE_LABELS) as AgentSessionType[]).map((t) => (
                      <SelectItem key={t} value={t}>{AGENT_SESSION_TYPE_LABELS[t]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>权限模式</Label>
                <Select value={form.policyMode || "__none__"} onValueChange={(v) => setForm((f) => ({ ...f, policyMode: v === "__none__" ? "" : (v as AgentPolicyMode) }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">（不指定）</SelectItem>
                    {(Object.keys(AGENT_POLICY_MODE_LABELS) as AgentPolicyMode[]).map((m) => (
                      <SelectItem key={m} value={m}>{AGENT_POLICY_MODE_LABELS[m]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>思考级别</Label>
                <Select value={form.thinkingLevel || "__none__"} onValueChange={(v) => setForm((f) => ({ ...f, thinkingLevel: v === "__none__" ? "" : (v as AgentThinkingLevel) }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">（不指定）</SelectItem>
                    {AGENT_THINKING_LEVELS.map((l) => (
                      <SelectItem key={l} value={l}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-starters">推荐开场白（每行一条，最多 6 条）</Label>
              <Textarea
                id="agent-starters"
                rows={3}
                value={form.starters}
                placeholder={"帮我整理这份材料\n写一份本周周报"}
                onChange={(e) => setForm((f) => ({ ...f, starters: e.target.value }))}
              />
            </div>

            <div className="grid gap-1.5">
              <Label>发布范围</Label>
              <Select value={form.scopeKind} onValueChange={(v) => setForm((f) => ({ ...f, scopeKind: v as SkillScopeKind }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SCOPE_LABELS) as SkillScopeKind[]).map((kind) => (
                    <SelectItem key={kind} value={kind}>{SCOPE_LABELS[kind]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {form.scopeKind === "role" ? (
              <div className="flex flex-wrap gap-4">
                {(Object.keys(ROLE_LABELS) as Role[]).map((role) => (
                  <label key={role} className="flex items-center gap-2" style={{ fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={form.roles.includes(role)}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          roles: e.target.checked ? [...f.roles, role] : f.roles.filter((r) => r !== role),
                        }))
                      }
                    />
                    {ROLE_LABELS[role]}
                  </label>
                ))}
              </div>
            ) : null}

            {form.scopeKind === "dept" ? (
              <div className="grid gap-1.5">
                <Label>选择部门</Label>
                <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 8 }}>
                  {depts.length === 0 ? (
                    <div className="cell-sub">暂无部门（先同步 AD 或建部门）</div>
                  ) : (
                    depts.map((dept) => (
                      <label key={dept.id} className="flex items-center gap-2" style={{ fontSize: 12.5, padding: "2px 0" }}>
                        <input
                          type="checkbox"
                          checked={form.deptIds.includes(dept.id)}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              deptIds: e.target.checked ? [...f.deptIds, dept.id] : f.deptIds.filter((id) => id !== dept.id),
                            }))
                          }
                        />
                        {dept.path}
                      </label>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            {form.scopeKind === "user" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="agent-uids">账号（逗号或空格分隔）</Label>
                <Input
                  id="agent-uids"
                  value={form.uids}
                  placeholder="zhangsan, lisi"
                  onChange={(e) => setForm((f) => ({ ...f, uids: e.target.value }))}
                />
              </div>
            ) : null}
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setSheet(null)}>取消</Button>
            <Button disabled={busy} onClick={() => void submit()}>{busy ? "保存中…" : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 字典维护：独立弹层（平台级低频操作，不混进单个专家的表单） */}
      <AgentTaxonomyDialog open={dictOpen} onClose={() => setDictOpen(false)} onChanged={() => void load()} />
    </div>
  );
}
