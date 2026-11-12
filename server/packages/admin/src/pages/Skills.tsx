// 内容与能力 · Skills 技能库（S-1/S-3）
// 真实数据：GET/POST/PATCH/DELETE /admin/skills；SKILL.md 内容存服务端，按角色/部门/账号下发到桌面端。
// 页面骨架参照 BuildingAI ai/agent 管理页（表格 + 抽屉表单），授权模型保留我们的三角色 + 部门。

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, PencilSimple, Plus, Trash, ArrowsClockwise, ArrowUUpLeft, Users, UploadSimple, Tag } from "@phosphor-icons/react";
import { deptsApi } from "../services/identity-resources";
import {
  skillsApi,
  skillFilesApi,
  skillCategoriesApi,
  type SkillFileMeta,
  type SkillFileUpload,
  type SkillAudience,
  type SkillCategoryRow,
  SKILL_CATEGORIES,
  SKILL_CATEGORY_LABELS,
  SKILL_LIMITS,
  type AdminSkill,
  type SkillCategory,
  type SkillScope,
} from "../services/skills";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { ScopePicker, scopeLabel } from "../components/ScopePicker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import type { DeptNode } from "../types";

interface SkillForm {
  name: string;
  title: string;
  description: string;
  content: string;
  version: string;
  enabled: boolean;
  /** 授权范围（四选一）+ 账号输入原始串（提交前才切分，允许中途有逗号） */
  scope: SkillScope;
  uidsText: string;
  // —— 技能市场元数据 ——
  icon: string;
  category: SkillCategory;
  tags: string;
  author: string;
  featured: boolean;
  weight: string;
  autoInstall: boolean;
}

const emptyForm = (): SkillForm => ({
  name: "",
  title: "",
  description: "",
  content: "# 技能名称\n\n## 何时使用\n\n## 步骤\n\n1. ",
  version: "1.0.0",
  enabled: true,
  scope: { kind: "all", roles: [], deptIds: [], uids: [] },
  uidsText: "",
  icon: "",
  category: "other",
  tags: "",
  author: "",
  // 默认 false：默认安装会直接推给**所有新用户**，属于“开箱即用”决策，不该是默认值
  autoInstall: false,
  featured: false,
  weight: "0",
});

/** 标签串 → 数组（逗号/顿号/空格分隔，去重，按 shared 的 SKILL_LIMITS 截断） */
function parseTags(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[,，、\s]+/)) {
    const tag = piece.trim().slice(0, SKILL_LIMITS.tagChars);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= SKILL_LIMITS.tags) break;
  }
  return out;
}

function flattenDepts(nodes: DeptNode[], out: Array<{ id: number; path: string }> = []): Array<{ id: number; path: string }> {
  for (const node of nodes) {
    out.push({ id: node.id, path: node.path });
    if (node.children?.length) flattenDepts(node.children, out);
  }
  return out;
}

export function Skills() {
  const [rows, setRows] = useState<AdminSkill[] | null>(null);
  const [depts, setDepts] = useState<Array<{ id: number; path: string }>>([]);
  const [sheet, setSheet] = useState<null | "new" | AdminSkill>(null);
  const [form, setForm] = useState<SkillForm>(emptyForm());
  const [busy, setBusy] = useState(false);
  /** 受众预估弹层（点「发给谁」时拉一次，不做预加载 —— 一百条技能没必要都算一遍） */
  const [audience, setAudience] = useState<{ skill: AdminSkill; data: SkillAudience | null } | null>(null);
  /** 当前编辑技能的附属文件清单（多文件技能；新建时为空，保存后再传） */
  const [files, setFiles] = useState<SkillFileMeta[]>([]);
  const [filesBusy, setFilesBusy] = useState(false);
  /** 新建技能时暂存的附件（技能还没有 id，无法立刻上传） */
  const [pendingFiles, setPendingFiles] = useState<SkillFileUpload[]>([]);
  /** 分类字典（文案/顺序/启用以服务端为准；拉不到时回退到编译期常量，保证表单仍可用） */
  const [categoryRows, setCategoryRows] = useState<SkillCategoryRow[]>([]);
  const [dictOpen, setDictOpen] = useState(false);
  const [dictBusy, setDictBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, d] = await Promise.all([skillsApi.list(), deptsApi.tree()]);
    setRows(s.skills);
    setDepts(flattenDepts(d.tree));
  }, []);

  /** 字典单独加载：它不影响技能列表渲染，失败也不该让整页报错 */
  const loadCategories = useCallback(async (): Promise<void> => {
    try {
      const r = await skillCategoriesApi.list();
      setCategoryRows(r.categories ?? []);
    } catch {
      setCategoryRows([]); // 回退：下拉用 SKILL_CATEGORIES 常量
    }
  }, []);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  /** 下拉选项：字典优先（含文案与顺序），字典为空时回退编译期常量 */
  const categoryOptions = useMemo(
    () =>
      categoryRows.length > 0
        ? categoryRows.filter((c) => c.enabled).sort((a, b) => a.sort - b.sort).map((c) => ({ code: c.code, label: c.label }))
        : SKILL_CATEGORIES.map((code) => ({ code, label: SKILL_CATEGORY_LABELS[code] })),
    [categoryRows],
  );

  /** 改字典（改名 / 排序 / 停用）——改完两侧显示立刻一致（服务端为真源） */
  const patchCategory = async (code: string, body: { label?: string; sort?: number; enabled?: boolean }): Promise<void> => {
    setDictBusy(code);
    try {
      await skillCategoriesApi.patch(code, body);
      await loadCategories();
      toast.ok("分类字典已更新");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDictBusy(null);
    }
  };

  useEffect(() => {
    void load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  const deptPath = useMemo(() => new Map(depts.map((d) => [d.id, d.path])), [depts]);

  const openNew = (): void => {
    setForm(emptyForm());
    setFiles([]);
    setPendingFiles([]);
    setSheet("new");
  };

  const openEdit = (skill: AdminSkill): void => {
    setForm({
      name: skill.name,
      title: skill.title,
      description: skill.description ?? "",
      content: skill.content,
      version: skill.version,
      enabled: skill.enabled,
      scope: {
        kind: skill.scope.kind,
        roles: [...skill.scope.roles],
        deptIds: [...skill.scope.deptIds],
        uids: [...skill.scope.uids],
      },
      uidsText: skill.scope.uids.join(", "),
      icon: skill.icon ?? "",
      category: skill.category,
      tags: (skill.tags ?? []).join(", "),
      author: skill.author ?? "",
      featured: skill.featured === true,
      weight: String(skill.weight ?? 0),
      autoInstall: skill.autoInstall === true,
    });
    setSheet(skill);
    void loadFiles(skill.id);
  };

  /** 拉附件清单（只清单，不含内容） */
  const loadFiles = async (skillId: number): Promise<void> => {
    try {
      const r = await skillFilesApi.list(skillId);
      setFiles(r.files ?? []);
    } catch {
      setFiles([]);
    }
  };

  /**
   * 整目录导入（`webkitdirectory`）—— 这是"把一个真实技能目录搬进市场"的主路径。
   *
   * 规则与 Agent Skills 规范对齐：
   *  - 根级 `SKILL.md` → 作为正文（走 skills.content），**不作为附件**；
   *  - 其余文件 → 附件，路径 = 相对所选目录（保持子目录结构）；
   *  - 文本类按 UTF-8 传，二进制按 base64（`contentB64`）；
   *  - 跳过常见垃圾（.DS_Store / Thumbs.db / __pycache__ / .git）。
   * 客户端这里只做**前置校验**（大小/数量），服务端仍会再校验一次（可信边界在服务端）。
   */
  const importDirectory = async (list: FileList, skillId: number | null): Promise<void> => {
    const BIN_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|xlsx?|docx?|pptx?|bin|woff2?|ttf|otf|so|dll|exe)$/i;
    const SKIP = /(^|\/)(\.DS_Store|Thumbs\.db|__pycache__|\.git)(\/|$)/;
    const chosen: SkillFileUpload[] = [];
    let md: File | null = null;
    let total = 0;
    for (const f of Array.from(list)) {
      const rel = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, "/");
      // 去掉所选目录本身那一层，得到相对技能根目录的路径
      const parts = rel.split("/");
      const path = parts.slice(1).join("/");
      if (!path || SKIP.test(path)) continue;
      if (path === "SKILL.md") { md = f; continue; }
      if (chosen.length >= 200) return void toast.error("附件超过 200 个，请精简后重试");
      if (f.size > 512 * 1024) return void toast.error(`${path} 超过单文件上限 512KB`);
      total += f.size;
      if (total > 8 * 1024 * 1024) return void toast.error("附件总量超过 8MB，请精简后重试");
      if (BIN_EXT.test(path) || f.type === "") {
        // 二进制：base64（ArrayBuffer → base64，避免 readAsText 破坏字节）
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (const b of buf) bin += String.fromCharCode(b);
        chosen.push({ path, contentB64: btoa(bin) });
      } else {
        chosen.push({ path, content: await f.text() });
      }
    }

    if (md) {
      const text = await md.text();
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      const pick = (key: string): string | null => {
        if (!fm) return null;
        const body = fm[1] ?? "";
        const m = new RegExp("^" + key + "\\s*:\\s*(.+)$", "m").exec(body);
        return m && m[1] !== undefined ? m[1].trim().replace(/^["']|["']$/g, "") : null;
      };
      const fmName = pick("name");
      setForm((f) => ({
        ...f,
        content: text,
        name: sheet === "new" && !f.name.trim() && fmName ? fmName.toLowerCase() : f.name,
        title: sheet === "new" && !f.title.trim() && (pick("title") ?? fmName) ? (pick("title") ?? fmName)! : f.title,
      }));
    }

    if (skillId === null) {
      // 新建：技能还没 id，附件先存内存，保存成功后一次性提交
      setPendingFiles(chosen);
      toast.ok(`已读取目录：${md ? "SKILL.md " : ""}${chosen.length} 个附件（保存后上传）`);
      return;
    }
    if (chosen.length === 0) return void toast.error("目录里没有可导入的附件");
    setFilesBusy(true);
    try {
      const r = await skillFilesApi.replace(skillId, chosen);
      setFiles(r.files ?? []);
      toast.ok(`已上传 ${chosen.length} 个附件`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setFilesBusy(false);
    }
  };

  /** 删除单个附件 */
  const removeFile = async (skillId: number, path: string): Promise<void> => {
    setFilesBusy(true);
    try {
      const r = await skillFilesApi.replace(
        skillId,
        files.filter((f) => f.path !== path).map((f) => ({ path: f.path, content: "" })),
      );
      setFiles(r.files ?? []);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setFilesBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!form.name.trim() || !form.title.trim() || !form.content.trim()) {
      toast.error("标识 / 名称 / SKILL.md 内容必填");
      return;
    }
    // 只保留当前 kind 对应的维度：切换范围类型时残留的旧维度必须清掉，
    // 否则会出现「选了全公司，却把上次的角色列表一起提交」的脏数据。
    const scope: SkillScope = {
      kind: form.scope.kind,
      roles: form.scope.kind === "role" ? form.scope.roles : [],
      deptIds: form.scope.kind === "dept" ? form.scope.deptIds : [],
      uids:
        form.scope.kind === "user"
          ? form.uidsText.split(/[,，\s]+/).map((u) => u.trim()).filter(Boolean)
          : [],
    };
    if (scope.kind === "role" && scope.roles.length === 0) return void toast.error("按角色下发需至少选一个角色");
    if (scope.kind === "dept" && scope.deptIds.length === 0) return void toast.error("按部门下发需至少选一个部门");
    if (scope.kind === "user" && scope.uids.length === 0) return void toast.error("按账号下发需至少填一个账号");

    setBusy(true);
    try {
      // 元数据（元数据先归一：空图标/空作者存 null，空标签存 []，权重截到上限）
      const meta = {
        icon: form.icon.trim() || null,
        category: form.category,
        tags: parseTags(form.tags),
        author: form.author.trim() || null,
        featured: form.featured,
        weight: Math.max(0, Math.min(SKILL_LIMITS.weight, Number(form.weight) || 0)),
        autoInstall: form.autoInstall,
      };
      if (form.icon.trim().length > SKILL_LIMITS.iconChars) {
        setBusy(false);
        return void toast.error(`图标不超过 ${SKILL_LIMITS.iconChars} 个字符`);
      }
      if (form.title.trim().length > SKILL_LIMITS.titleChars) {
        setBusy(false);
        return void toast.error(`名称不超过 ${SKILL_LIMITS.titleChars} 字`);
      }
      if (form.description.trim().length > SKILL_LIMITS.descChars) {
        setBusy(false);
        return void toast.error(`描述不超过 ${SKILL_LIMITS.descChars} 字`);
      }
      if (sheet === "new") {
        await skillsApi.create({
          name: form.name.trim().toLowerCase(),
          title: form.title.trim(),
          description: form.description.trim() || null,
          content: form.content,
          version: form.version.trim() || "1.0.0",
          enabled: form.enabled,
          scope,
          ...meta,
        });
      } else if (sheet) {
        await skillsApi.patch(sheet.id, {
          title: form.title.trim(),
          description: form.description.trim() || null,
          content: form.content,
          version: form.version.trim() || "1.0.0",
          enabled: form.enabled,
          scope,
          ...meta,
        });
      }
      // 新建后拿到 id，把目录导入时暂存的附件一次性提交（避免"读了目录却没传上去"）
      if (sheet === "new" && pendingFiles.length > 0) {
        const created = await skillsApi.list();
        const mine = (created.skills ?? []).find((x) => x.name === form.name.trim().toLowerCase());
        if (mine) {
          try {
            await skillFilesApi.replace(mine.id, pendingFiles);
          } catch (e) {
            toast.error(`附件上传失败：${(e as Error).message}`);
          }
        }
        setPendingFiles([]);
      }
      toast.ok("已保存");
      setSheet(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (skill: AdminSkill): Promise<void> => {
    try {
      await skillsApi.patch(skill.id, { enabled: !skill.enabled });
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async (skill: AdminSkill): Promise<void> => {
    if (!window.confirm(`删除技能「${skill.title}」？桌面端将不再下发。`)) return;
    try {
      await skillsApi.remove(skill.id);
      toast.ok(`已删除 ${skill.name}`);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  /** 看受众：这个技能到底发给谁、已经有多少人装了 */
  const openAudience = async (skill: AdminSkill): Promise<void> => {
    setAudience({ skill, data: null });
    try {
      const data = await skillsApi.audience(skill.id);
      setAudience({ skill, data });
    } catch (e) {
      toast.error((e as Error).message);
      setAudience(null);
    }
  };

  /**
   * 从本地 `.md` 导入 SKILL.md 正文。
   *
   * 为什么值得做：技能正文实际是「作者在自己仓库里写的 SKILL.md」，此前只能复制粘贴进
   * textarea —— 团队里贴错/贴漏是常态。导入时顺手从 frontmatter 里认出 name/title
   * （只在新建且该字段还空着时填，避免覆盖管理员已经改过的值）。
   */
  const importMarkdown = async (file: File): Promise<void> => {
    const text = await file.text().catch(() => "");
    if (!text.trim()) return void toast.error("文件是空的");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const pick = (key: string): string | null => {
      if (!fm) return null;
      const body = fm[1] ?? "";
      const m = new RegExp("^" + key + "\\s*:\\s*(.+)$", "m").exec(body);
      return m && m[1] !== undefined ? m[1].trim().replace(/^["']|["']$/g, "") : null;
    };
    const fmName = pick("name");
    const fmTitle = pick("title") ?? pick("name");
    setForm((f) => ({
      ...f,
      content: text,
      // 仅新建 + 字段为空时带入，避免把管理员已经改好的值冲掉
      name: sheet === "new" && !f.name.trim() && fmName ? fmName.toLowerCase() : f.name,
      title: sheet === "new" && !f.title.trim() && fmTitle ? fmTitle : f.title,
    }));
    toast.ok(`已导入 ${file.name}${fmName ? `（标识：${fmName}）` : ""}`);
  };

  /** 重解析：把 SKILL.md 里 frontmatter 的值同步过来（已被人工覆盖的字段不动） */
  const reparse = async (skill: AdminSkill): Promise<void> => {
    try {
      await skillsApi.parse(skill.id);
      toast.ok("已从 SKILL.md 重解析元数据");
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  /**
   * 清除人工覆盖，把字段交还给 frontmatter。
   * 先问一次 —— 这是一次会改变“以后自动同步行为”的动作，且无法从 UI 看出之前手工填了什么。
   */
  const clearOverrides = async (skill: AdminSkill): Promise<void> => {
    const fields = skill.overriddenFields ?? [];
    if (fields.length === 0) return void toast.error("该技能没有人工覆盖的字段");
    if (!window.confirm(`交还 frontmatter 控制：${fields.join("、")}\n（清除后这些字段将随 SKILL.md 自动变化）`)) return;
    try {
      await skillsApi.clearOverride(skill.id, fields);
      toast.ok("已清除覆盖，交还 frontmatter");
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div>
      <PageHead
        title="Skills 技能"
        desc="技能库（SKILL.md）统一定义与下发：桌面端登录后按角色/部门/账号拉取，落盘到本地技能目录"
      />
      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <ToneBadge tone="info">服务端为真源 · 桌面端只读同步</ToneBadge>
        <div className="spacer" />
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setDictOpen(true)}>
          <Tag size={14} /> 分类字典
        </Button>
        <Button size="sm" variant="default" className="gap-1.5" onClick={openNew}>
          <Plus size={14} /> 新增技能
        </Button>
      </div>

      <div className="tablewrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>技能</TableHead>
              <TableHead>分类 / 标签</TableHead>
              <TableHead>上架位</TableHead>
              <TableHead>授权范围</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-[230px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null ? (
              <TableRow><TableCell colSpan={6}><SkeletonRows /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="empty">
                    <BookOpen size={22} />
                    <div className="t">还没有技能</div>
                    <div className="s">新增一个 SKILL.md，桌面端登录后即可拉取使用</div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((skill) => (
                <TableRow key={skill.id}>
                  <TableCell>
                    <div style={{ fontWeight: 600 }}>
                      {skill.icon ? <span style={{ marginRight: 6 }}>{skill.icon}</span> : null}
                      {skill.title}
                    </div>
                    <div className="cell-sub">
                      <span className="mono">{skill.name}</span> · v{skill.version}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{SKILL_CATEGORY_LABELS[skill.category] ?? skill.category}</div>
                    <div className="cell-sub">
                      {(skill.tags ?? []).length > 0 ? skill.tags.join("、") : "—"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {skill.featured ? <ToneBadge tone="accent">精选</ToneBadge> : null}
                      {skill.autoInstall ? <ToneBadge tone="info">默认安装</ToneBadge> : null}
                      {!skill.featured && !skill.autoInstall ? <span className="cell-sub">普通</span> : null}
                    </div>
                    {skill.weight > 0 ? <div className="cell-sub">权重 {skill.weight}</div> : null}
                  </TableCell>
                  <TableCell>
                    {scopeLabel(skill.scope)}
                    {skill.scope.kind === "dept" && skill.scope.deptIds.length > 0 ? (
                      <div className="cell-sub">
                        {skill.scope.deptIds.slice(0, 3).map((id) => deptPath.get(id) ?? `#${id}`).join("、")}
                        {skill.scope.deptIds.length > 3 ? " …" : ""}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {skill.enabled ? <ToneBadge tone="accent">上架</ToneBadge> : <ToneBadge tone="danger">已下架</ToneBadge>}
                    {(skill.overriddenFields ?? []).length > 0 ? (
                      <div className="cell-sub" title={skill.overriddenFields.join("、")}>
                        人工字段 {skill.overriddenFields.length} 项
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="row-actions">
                      <Button size="sm" variant="ghost" className="gap-1" onClick={() => openEdit(skill)}>
                        <PencilSimple size={14} /> 编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        title="这个技能发给谁、已有多少人装"
                        onClick={() => void openAudience(skill)}
                      >
                        <Users size={14} /> 发给谁
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        title="从 SKILL.md 的 frontmatter 重新解析元数据（人工覆盖的字段不动）"
                        onClick={() => void reparse(skill)}
                      >
                        <ArrowsClockwise size={14} /> 重解析
                      </Button>
                      {(skill.overriddenFields ?? []).length > 0 ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1"
                          title="把被人工覆盖的字段交还给 frontmatter"
                          onClick={() => void clearOverrides(skill)}
                        >
                          <ArrowUUpLeft size={14} /> 交还
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => void toggle(skill)}>
                        {skill.enabled ? "下架" : "上架"}
                      </Button>
                      <Button size="sm" variant="ghost" className="gap-1" onClick={() => void remove(skill)}>
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

      {/*
        分类字典弹层（中间方案）：**只允许改名 / 排序 / 停用** —— 编码是编译期常量，
        刻意不支持新增/删除。想做新类目要发版，这是换取"类型安全 + 离线可用"的代价。
      */}
      <Dialog open={dictOpen} onOpenChange={(open) => { if (!open) setDictOpen(false); }}>
        <DialogContent className="modal" style={{ maxWidth: 560 }}>
          <DialogHeader className="modal-head">
            <DialogTitle>分类字典</DialogTitle>
          </DialogHeader>
          <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
            <div className="cell-sub">
              分类**编码**由代码固定（筛选与存值都用它）；这里改的是展示名、顺序与是否启用，保存后桌面端与管理台立刻一致。
            </div>
            {(categoryRows.length > 0
              ? [...categoryRows].sort((a, b) => a.sort - b.sort)
              : SKILL_CATEGORIES.map((code) => ({ code, label: SKILL_CATEGORY_LABELS[code], sort: 0, enabled: true, skillCount: 0 }))
            ).map((row) => (
              <div key={row.code} className="flex items-center gap-2 rounded border px-2 py-1.5" style={{ borderColor: "var(--line)" }}>
                <span className="mono" style={{ width: 90, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{row.code}</span>
                <Input
                  defaultValue={row.label}
                  aria-label={`${row.code} 展示名`}
                  style={{ maxWidth: 180 }}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next && next !== row.label) void patchCategory(row.code, { label: next });
                  }}
                />
                <Input
                  defaultValue={String(row.sort)}
                  aria-label={`${row.code} 排序`}
                  inputMode="numeric"
                  style={{ maxWidth: 80 }}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n) && n !== row.sort) void patchCategory(row.code, { sort: n });
                  }}
                />
                <span className="cell-sub" style={{ minWidth: 64 }}>{row.skillCount ?? 0} 个技能</span>
                <div style={{ flex: 1 }} />
                <Switch
                  checked={row.enabled}
                  disabled={dictBusy === row.code}
                  onCheckedChange={(v) => void patchCategory(row.code, { enabled: v })}
                />
              </div>
            ))}
            <div className="cell-sub">
              停用后该分类不再出现在用户端 chips；**已用该分类的存量技能不受影响**（卡片回退显示编码）。
            </div>
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setDictOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={audience !== null} onOpenChange={(open) => { if (!open) setAudience(null); }}>
        <DialogContent className="modal" style={{ maxWidth: 460 }}>
          <DialogHeader className="modal-head">
            <DialogTitle>受众：{audience?.skill.title}</DialogTitle>
          </DialogHeader>
          <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            {audience && !audience.data ? (
              <div className="cell-sub">计算中…</div>
            ) : audience?.data ? (
              <>
                <div>
                  授权范围：{scopeLabel(audience.data.scope)}
                  {audience.data.scope.kind === "dept" ? <span className="cell-sub">（部门为精确匹配，不含子部门）</span> : null}
                </div>
                <div>
                  预计可见：<b>{audience.data.visibleUsers}</b> 人
                  <span className="cell-sub">（口径与服务端可见性判据一致）</span>
                </div>
                <div>
                  已安装：<b>{audience.data.installedUsers}</b> 人
                </div>
                <div className="cell-sub">
                  {audience.data.enabled
                    ? audience.data.autoInstall
                      ? "当前已上架，且标为「默认安装」：新用户开箱即用"
                      : "当前已上架"
                    : "当前已下架：已装用户保留本地文件、不进新会话"}
                </div>
              </>
            ) : null}
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setAudience(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sheet !== null} onOpenChange={(open) => { if (!open) setSheet(null); }}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>{sheet === "new" ? "新增技能" : "编辑技能"}</DialogTitle>
          </DialogHeader>
          <div className="form-col modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="grid gap-1.5">
              <Label htmlFor="skill-name">标识（目录名，小写字母/数字/连字符）</Label>
              <Input
                id="skill-name"
                value={form.name}
                disabled={sheet !== "new"}
                placeholder="office-report"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="skill-title">名称</Label>
              <Input
                id="skill-title"
                value={form.title}
                placeholder="办公周报"
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="skill-desc">描述</Label>
              <Input
                id="skill-desc"
                value={form.description}
                placeholder="把要点整理成周报"
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="skill-content">SKILL.md 内容</Label>
                {/* 导入 = 选本地 .md 文件；作者平时就是在自己仓库里写这个文件的 */}
                <label
                  className="flex items-center gap-1"
                  style={{ fontSize: 12, cursor: "pointer", color: "var(--dsw-alias-label-secondary)" }}
                  title="选择本地 SKILL.md 文件导入（自动识别 frontmatter 里的 name/title）"
                >
                  <UploadSimple size={13} /> 导入 .md
                  <input
                    type="file"
                    accept=".md,text/markdown"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void importMarkdown(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              <Textarea
                id="skill-content"
                rows={12}
                className="font-mono text-[12px]"
                value={form.content}
                onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="skill-version">版本</Label>
                <Input
                  id="skill-version"
                  value={form.version}
                  onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}
                />
              </div>
              <div className="flex items-center justify-between rounded border px-3" style={{ borderColor: "var(--line)", marginTop: 22 }}>
                <span style={{ fontSize: 13 }}>启用</span>
                <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
              </div>
            </div>

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <Label>附属文件（脚本 / 参考资料 / 模板）</Label>
                {/* 整目录导入：这是把一个真实技能目录搬进市场的主路径 ——
                    只发 SKILL.md 的话，带 scripts/ 的技能到用户机器上跑不起来 */}
                <label
                  className="flex items-center gap-1"
                  style={{ fontSize: 12, cursor: "pointer", color: "var(--dsw-alias-label-secondary)" }}
                  title="选择技能目录（含 SKILL.md，可选 scripts/references 等子目录）"
                >
                  <UploadSimple size={13} /> 导入技能目录
                  <input
                    type="file"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const fs = e.target.files;
                      if (fs && fs.length > 0) void importDirectory(fs, sheet === "new" ? null : sheet ? sheet.id : null);
                      e.target.value = "";
                    }}
                    {...({ webkitdirectory: "" } as Record<string, string>)}
                  />
                </label>
              </div>
              {sheet === "new" && pendingFiles.length > 0 ? (
                <div className="cell-sub">待上传 {pendingFiles.length} 个附件（保存技能后自动上传）</div>
              ) : files.length === 0 ? (
                <div className="cell-sub">无附属文件（只发 SKILL.md）</div>
              ) : (
                <div style={{ maxHeight: 140, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 8 }}>
                  {files.map((f) => (
                    <div key={f.path} className="flex items-center gap-2" style={{ fontSize: 12, padding: "2px 0" }}>
                      <span className="mono" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                      <span className="cell-sub">{Math.max(1, Math.round(f.size / 1024))}KB</span>
                      <button
                        type="button"
                        className="cell-sub"
                        disabled={filesBusy}
                        onClick={() => sheet !== "new" && sheet ? void removeFile(sheet.id, f.path) : undefined}
                        title="删除该附件"
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="cell-sub">单文件 ≤512KB、总量 ≤8MB、最多 200 个；root 级 SKILL.md 作为正文，不计入附件。</div>
            </div>

            <div className="grid gap-1.5">
              <Label>市场元数据</Label>
              <div className="cell-sub" style={{ marginBottom: 2 }}>
                这些字段优先取 SKILL.md 的 frontmatter；在管理台手改后会标记为「人工字段」，重解析不会覆盖它们。
                {typeof sheet === "object" && sheet !== null && (sheet.overriddenFields ?? []).length > 0
                  ? ` 当前人工字段：${sheet.overriddenFields.join("、")}`
                  : ""}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="skill-icon">图标（emoji，{SKILL_LIMITS.iconChars} 字以内）</Label>
                  <Input
                    id="skill-icon"
                    value={form.icon}
                    placeholder="🧩"
                    onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>分类</Label>
                  <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v as SkillCategory }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {categoryOptions.map((cat) => (
                        <SelectItem key={cat.code} value={cat.code}>{cat.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="skill-tags">标签（逗号分隔，最多 {SKILL_LIMITS.tags} 个）</Label>
                  <Input
                    id="skill-tags"
                    value={form.tags}
                    placeholder="周报, 汇报"
                    onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="skill-author">作者</Label>
                  <Input
                    id="skill-author"
                    value={form.author}
                    placeholder="平台团队"
                    onChange={(e) => setForm((f) => ({ ...f, author: e.target.value }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="skill-weight">精选权重（0-{SKILL_LIMITS.weight}，越大越容易被换一换抽到）</Label>
                  <Input
                    id="skill-weight"
                    value={form.weight}
                    inputMode="numeric"
                    onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-3" style={{ marginTop: 22 }}>
                  <label className="flex items-center justify-between gap-2" style={{ fontSize: 13 }}>
                    <span>精选（进首页精选位）</span>
                    <Switch checked={form.featured} onCheckedChange={(v) => setForm((f) => ({ ...f, featured: v }))} />
                  </label>
                  <label className="flex items-center justify-between gap-2" style={{ fontSize: 13 }}>
                    <span title="新用户登录后默认已安装（无需自己去市场点）">默认安装（推给新用户）</span>
                    <Switch checked={form.autoInstall} onCheckedChange={(v) => setForm((f) => ({ ...f, autoInstall: v }))} />
                  </label>
                </div>
              </div>
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
