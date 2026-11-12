/**
 * 分类与标签维护弹层（v1 专家市场）。
 *
 * 为什么单独一个弹层而不是塞进 Agent 表单：
 * 这是**字典维护**（平台级、低频、批量），与「编辑某个专家」（对象级、高频）是两种任务。
 * 混在一起会让 Agent 表单长到失控，也会让管理员误以为改分类会影响当前这个专家。
 *
 * 关键交互口径：
 *  - 分类 = code（不可改）+ label（可改）+ 排序 + 启停。code 创建后不可改 —— 存量专家按 code 引用。
 *  - 标签 = name 即展示值（不拆 code/label：标签本身就是给人看的词组）。
 *  - **有引用只许停用，不许删除**：服务端返 409，前端把它转成人话
 *    （「还有 3 个专家在使用」），并引导去点停用。
 *  - 停用 = 新专家不能再选，存量专家不受影响 —— 这是「下架一个分类」的正确姿势。
 */
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import {
  agentTaxonomyApi,
  AGENT_CODE_PATTERN,
  AGENT_LIMITS,
  type AgentCategoryItem,
  type AgentTagItem,
} from "../services/agents";
import { toast } from "../lib/toast";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 字典变更后通知外层重拉（Agent 表单的下拉/多选要跟着变） */
  onChanged: () => void;
}

export function AgentTaxonomyDialog({ open, onClose, onChanged }: Props): React.ReactElement {
  const [categories, setCategories] = useState<AgentCategoryItem[]>([]);
  const [tags, setTags] = useState<AgentTagItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [newCatCode, setNewCatCode] = useState("");
  const [newCatLabel, setNewCatLabel] = useState("");
  const [newTagName, setNewTagName] = useState("");

  const load = useCallback(async (): Promise<void> => {
    const data = await agentTaxonomyApi.list();
    setCategories(data.categories);
    setTags(data.tags);
  }, []);

  useEffect(() => {
    if (!open) return;
    void load().catch((e) => toast.error((e as Error).message));
  }, [open, load]);

  /** 统一包装：失败提示 + 成功后重拉字典并通知外层 */
  const run = async (fn: () => Promise<unknown>, okMsg: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await load();
      onChanged();
      toast.ok(okMsg);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addCategory = async (): Promise<void> => {
    const code = newCatCode.trim().toLowerCase();
    const label = newCatLabel.trim();
    if (!AGENT_CODE_PATTERN.test(code)) return void toast.error("分类标识仅允许小写字母/数字/连字符");
    if (!label) return void toast.error("分类名称必填");
    await run(() => agentTaxonomyApi.createCategory({ code, label }), "分类已新增");
    setNewCatCode("");
    setNewCatLabel("");
  };

  const addTag = async (): Promise<void> => {
    const name = newTagName.trim();
    if (!name) return void toast.error("标签名必填");
    await run(() => agentTaxonomyApi.createTag({ name }), "标签已新增");
    setNewTagName("");
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="modal" data-agent-taxonomy-dialog="" style={{ maxWidth: 720 }}>
        <DialogHeader className="modal-head">
          <DialogTitle>分类与标签</DialogTitle>
        </DialogHeader>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {/* ===== 分类 ===== */}
          <section>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>分类</div>
            <p className="cell-sub" style={{ marginTop: 0, marginBottom: 10 }}>
              分类标识（code）创建后不可修改，改「名称」即可；「排序」越小越前；停用后新专家不能再选它，已有专家不受影响。
              只有没有任何专家使用的分类才能删除。
            </p>
            <div className="grid grid-cols-[150px_1fr_auto] gap-2 items-end" style={{ marginBottom: 10 }}>
              <div className="grid gap-1.5">
                <Label htmlFor="cat-code">标识</Label>
                <Input id="cat-code" value={newCatCode} placeholder="office" onChange={(e) => setNewCatCode(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cat-label">名称</Label>
                <Input id="cat-label" value={newCatLabel} placeholder="办公协同" onChange={(e) => setNewCatLabel(e.target.value)} />
              </div>
              <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => void addCategory()}>
                <Plus size={14} /> 新增分类
              </Button>
            </div>
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, maxHeight: 220, overflowY: "auto" }}>
              {categories.length === 0 ? (
                <div className="cell-sub" style={{ padding: 10 }}>还没有分类</div>
              ) : (
                categories.map((cat) => (
                  <div key={cat.code} data-agent-cat={cat.code} className="flex items-center gap-3" style={{ padding: "6px 10px", borderBottom: "1px solid var(--line)" }}>
                    <span className="mono" style={{ width: 130, fontSize: 12 }}>{cat.code}</span>
                    <Input
                      defaultValue={cat.label}
                      style={{ width: 160 }}
                      aria-label={`分类名称 ${cat.code}`}
                      data-agent-cat-label={cat.code}
                      onBlur={(e) => {
                        const label = e.target.value.trim();
                        if (label && label !== cat.label) void run(() => agentTaxonomyApi.patchCategory(cat.code, { label }), "名称已更新");
                        else if (!label) e.target.value = cat.label;
                      }}
                    />
                    {/* 排序：越小越前。用失焦提交（避免每敲一个数字发一次请求） */}
                    <Input
                      type="number"
                      defaultValue={cat.sort}
                      style={{ width: 76 }}
                      aria-label={`分类排序 ${cat.code}`}
                      data-agent-cat-sort={cat.code}
                      onBlur={(e) => {
                        const sort = Number(e.target.value);
                        if (Number.isFinite(sort) && sort !== cat.sort) void run(() => agentTaxonomyApi.patchCategory(cat.code, { sort }), "排序已更新");
                        else if (!Number.isFinite(sort)) e.target.value = String(cat.sort);
                      }}
                    />
                    <span className="cell-sub" style={{ minWidth: 74 }} data-agent-cat-refs={cat.agentCount ?? 0}>{cat.agentCount ?? 0} 个专家</span>
                    <div className="spacer" style={{ flex: 1 }} />
                    <label className="flex items-center gap-2" style={{ fontSize: 12 }}>
                      启用
                      <Switch
                        checked={cat.enabled}
                        onCheckedChange={(v) => void run(() => agentTaxonomyApi.patchCategory(cat.code, { enabled: v }), v ? "已启用" : "已停用")}
                      />
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      title={(cat.agentCount ?? 0) > 0 ? "有专家在用，只能停用不能删除" : "删除分类"}
                      onClick={() => {
                        if (!window.confirm(`删除分类「${cat.label}」？`)) return;
                        void run(() => agentTaxonomyApi.removeCategory(cat.code), "分类已删除");
                      }}
                    >
                      <Trash size={14} />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* ===== 标签 ===== */}
          <section>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>标签库</div>
            <p className="cell-sub" style={{ marginTop: 0, marginBottom: 10 }}>
              专家表单只能从这里选标签（受控词表，避免「周报 / 写周报 / 周报写作」这类同义变体把筛选搞废）。
              停用后新专家不能再选；只有没有任何专家使用的标签才能删除。
            </p>
            <div className="grid grid-cols-[1fr_auto] gap-2 items-end" style={{ marginBottom: 10 }}>
              <div className="grid gap-1.5">
                <Label htmlFor="tag-name">标签名</Label>
                <Input
                  id="tag-name"
                  value={newTagName}
                  placeholder="周报"
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void addTag(); }}
                />
              </div>
              <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => void addTag()}>
                <Plus size={14} /> 新增标签
              </Button>
            </div>
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, maxHeight: 200, overflowY: "auto" }}>
              {tags.length === 0 ? (
                <div className="cell-sub" style={{ padding: 10 }}>标签库是空的 —— 先新增几个，专家表单里才有的选</div>
              ) : (
                tags.map((tag) => (
                  <div key={tag.name} data-agent-tag={tag.name} className="flex items-center gap-3" style={{ padding: "6px 10px", borderBottom: "1px solid var(--line)" }}>
                    <span style={{ minWidth: 160, fontSize: 12.5 }}>{tag.name}</span>
                    <Input
                      type="number"
                      defaultValue={tag.sort}
                      style={{ width: 76 }}
                      aria-label={`标签排序 ${tag.name}`}
                      data-agent-tag-sort={tag.name}
                      onBlur={(e) => {
                        const sort = Number(e.target.value);
                        if (Number.isFinite(sort) && sort !== tag.sort) void run(() => agentTaxonomyApi.patchTag(tag.name, { sort }), "排序已更新");
                        else if (!Number.isFinite(sort)) e.target.value = String(tag.sort);
                      }}
                    />
                    <span className="cell-sub" style={{ minWidth: 74 }} data-agent-tag-refs={tag.agentCount ?? 0}>{tag.agentCount ?? 0} 个专家</span>
                    <div className="spacer" style={{ flex: 1 }} />
                    <label className="flex items-center gap-2" style={{ fontSize: 12 }}>
                      启用
                      <Switch
                        checked={tag.enabled}
                        onCheckedChange={(v) => void run(() => agentTaxonomyApi.patchTag(tag.name, { enabled: v }), v ? "已启用" : "已停用")}
                      />
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      title={(tag.agentCount ?? 0) > 0 ? "有专家在用，只能停用不能删除" : "删除标签"}
                      onClick={() => {
                        if (!window.confirm(`删除标签「${tag.name}」？`)) return;
                        void run(() => agentTaxonomyApi.removeTag(tag.name), "标签已删除");
                      }}
                    >
                      <Trash size={14} />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
        <DialogFooter className="modal-foot">
          <span className="cell-sub" style={{ fontSize: 11 }}>
            字段上限：名称 {AGENT_LIMITS.labelChars} 字 / 标识 {AGENT_LIMITS.codeChars} 字符 / 每个专家最多 {AGENT_LIMITS.tags} 个标签
          </span>
          <Button variant="outline" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
