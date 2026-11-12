/**
 * 知识库 · 数据集列表页（**正式页**，KB-⑥）。
 *
 * 主体是**整棵搬来**的 BuildingAI 列表页（`kb-port/pages/console/ai/datasets/list`）——
 * 版式、表格列、筛选、分页、四个对话框都是上游原样；取数层由 `kb-shims/data.tsx` 接到
 * 本仓服务端 `/v1/kb/*`。
 *
 * ## 为什么上面还要自己加一条工具条
 *
 * 上游那页**没有「新建数据集」入口，也没有「往库里放文档」入口**（`DocumentDialog` 是只读的
 * —— 它只 `useConsoleDatasetDocumentsQuery`）。上游的建库/入库走的是它自己的另一套流程。
 * 结果就是：搬完之后 UI 上**没法建库、没法入库**，后端能力再全也用不上。
 *
 * 移植页面是**生成物**（`port-kb-ui.mjs` 每次重跑覆盖），不能直接改，所以在**外层包装页**
 * 补这两个入口 —— 用同一套移植组件画，视觉一致，且不碰生成物。
 *
 * ## ★ provider 必须在页面**祖先**上
 *
 * 移植页面在组件顶部就调用 `useAlertDialog()`，没有 provider 时直接抛错；上游把 provider
 * 挂在它的 console 外壳里，而外壳不搬 ⇒ 由我们提供。放进 `PageContainer`（页面 return 的
 * 子节点）**无效**（context 只向下流），必须在这里包住整页。
 */
import { useState } from "react";
import { MagnifyingGlass, Plus, UploadSimple } from "@phosphor-icons/react";
import { toast } from "sonner";
import DatasetsListPage from "../kb-port/pages/console/ai/datasets/list";
import { AlertDialogProvider } from "../kb-port/ui/hooks/use-alert-dialog";
import { Button } from "../kb-port/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../kb-port/ui/components/ui/dialog";
import { Input } from "../kb-port/ui/components/ui/input";
import { Label } from "../kb-port/ui/components/ui/label";
import { Textarea } from "../kb-port/ui/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../kb-port/ui/components/ui/select";
import { kbApi, useDatasetsConfigQuery } from "../kb-shims/data";

export default function KbDatasetsPage(): React.ReactElement {
  const { data: cfg, isLoading } = useDatasetsConfigQuery();
  // ⚠️ 必须等 health 回来再判降级：否则首帧就显示「检索能力降级」，环境正常也会闪一下假告警
  const degraded = !isLoading && (cfg.embedderConfigured === false || cfg.vectorReady === false);

  // 移植页自己管取数 ⇒ 建库/入库成功后用 key 强制重挂载，让它重新拉一次列表
  const [nonce, setNonce] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <div className="flex h-full flex-col">
      {degraded ? (
        <div className="border-b border-amber-300/60 bg-amber-50 px-6 py-2 text-xs text-amber-900" data-kb-degraded="">
          检索能力降级：
          {cfg.embedderConfigured === false ? "未配置向量化器（REACTOR_GATEWAY_TOKEN）" : "pgvector 不可用"}
          ，当前按「关键词（中文二字组）{cfg.embedderConfigured === false ? "" : " + Node 内余弦"}」检索。
          补上配置后重启服务即可启用向量检索。
        </div>
      ) : null}

      {/* 上游页面缺的两个入口（见文件头注） */}
      <div className="flex items-center gap-2 border-b px-6 py-3" data-kb-toolbar="">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 size-4" />
          新建数据集
        </Button>
        <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
          <UploadSimple className="mr-1 size-4" />
          入库文档
        </Button>
        <Button size="sm" variant="outline" onClick={() => setSearchOpen(true)}>
          <MagnifyingGlass className="mr-1 size-4" />
          检索测试
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <AlertDialogProvider>
          <DatasetsListPage key={nonce} />
        </AlertDialogProvider>
      </div>

      <CreateDatasetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => setNonce((n) => n + 1)}
      />
      <AddDocumentDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onAdded={() => setNonce((n) => n + 1)}
      />
      <SearchTestDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 新建数据集（对应 POST /v1/kb/datasets）
// ─────────────────────────────────────────────────────────────────────────────

function CreateDatasetDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scopeKind, setScopeKind] = useState<"all" | "dept" | "user">("all");
  const [deptIds, setDeptIds] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (name.trim().length === 0) {
      toast.error("请填写名称");
      return;
    }
    // 部门/仅自己两种范围需要各自的目标值；解析失败就直接挡在提交前（不发给后端猜）
    const deptIdList = deptIds
      .split(/[,，\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (scopeKind === "dept" && deptIdList.length === 0) {
      toast.error("按部门可见需要填写至少一个部门 id");
      return;
    }
    setBusy(true);
    try {
      await kbApi.create({
        name: name.trim(),
        description: description.trim() || null,
        scope:
          scopeKind === "dept"
            ? { kind: "dept", roles: [], deptIds: deptIdList, uids: [] }
            : scopeKind === "user"
              ? { kind: "user", roles: [], deptIds: [], uids: [] }
              : { kind: "all", roles: [], deptIds: [], uids: [] },
      });
      toast.success("数据集已创建");
      setName("");
      setDescription("");
      props.onOpenChange(false);
      props.onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent data-kb-dialog="create-dataset">
        <DialogHeader>
          <DialogTitle>新建数据集</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="kb-name">名称</Label>
            <Input id="kb-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：产品需求文档库" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="kb-desc">描述（可选）</Label>
            <Input id="kb-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>可见范围</Label>
            <Select value={scopeKind} onValueChange={(v) => setScopeKind(v as "all" | "dept" | "user")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全员可见</SelectItem>
                <SelectItem value="dept">按部门可见</SelectItem>
                <SelectItem value="user">仅自己可见</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {scopeKind === "dept" ? (
            <div className="space-y-1">
              <Label htmlFor="kb-depts">部门 id（多个用逗号分隔）</Label>
              <Input id="kb-depts" value={deptIds} onChange={(e) => setDeptIds(e.target.value)} placeholder="101, 202" />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 入库文档（对应 POST /v1/kb/datasets/:id/documents）
//
// 本仓**没有通用文件上传通道**：正文以文本提交，服务端负责切片与向量化。
// 所以这里给的是「选库 + 文档名 + 正文」，而不是上传控件 —— 如实对应后端能力。
// ─────────────────────────────────────────────────────────────────────────────

function AddDocumentDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}): React.ReactElement {
  const [datasets, setDatasets] = useState<Array<{ id: string; name: string }>>([]);
  const [datasetId, setDatasetId] = useState("");
  const [docName, setDocName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  // 打开时才拉列表（避免常驻多打一次请求）
  const loadDatasets = (): void => {
    kbApi
      .list()
      .then((r) => setDatasets(r.items.map((d) => ({ id: d.id, name: d.name }))))
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
  };

  const submit = async (): Promise<void> => {
    if (datasetId === "") {
      toast.error("请选择数据集");
      return;
    }
    if (docName.trim().length === 0 || content.trim().length === 0) {
      toast.error("文档名与正文都不能为空");
      return;
    }
    setBusy(true);
    try {
      const r = await kbApi.addDocument(datasetId, { name: docName.trim(), content });
      toast.success(`已入库：切片 ${r.segmentCount} 段`);
      setDocName("");
      setContent("");
      props.onOpenChange(false);
      props.onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(v) => {
        props.onOpenChange(v);
        if (v) loadDatasets();
      }}
    >
      <DialogContent data-kb-dialog="add-document">
        <DialogHeader>
          <DialogTitle>入库文档</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>目标数据集</Label>
            <Select value={datasetId} onValueChange={setDatasetId}>
              <SelectTrigger>
                <SelectValue placeholder="请选择" />
              </SelectTrigger>
              <SelectContent>
                {datasets.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {datasets.length === 0 ? (
              <p className="text-xs text-muted-foreground">还没有可见的数据集 —— 先用「新建数据集」建一个。</p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="kb-doc-name">文档名</Label>
            <Input id="kb-doc-name" value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="如：需求规格.md" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="kb-doc-body">正文（服务端会切片并向量化）</Label>
            <Textarea
              id="kb-doc-body"
              rows={8}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="粘贴文本内容…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "入库中…" : "入库"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 检索测试（对应 POST /v1/kb/search）
//
// 为什么要有它：检索是这个功能的核心，但上游页面里**没有检索入口**（它的检索在对话侧）。
// 没有它，管理员只能靠"猜"——不知道库里到底能不能搜到、走的是哪条路。
// 所以这里把三种模式、来源标注、以及**降级状态**（degraded / vectorUsed / effectiveMode）
// 全部如实显示出来：看到 `effectiveMode` 与所选不一致，就知道是环境降级而不是没命中。
// ─────────────────────────────────────────────────────────────────────────────

function SearchTestDialog(props: { open: boolean; onOpenChange: (v: boolean) => void }): React.ReactElement {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"hybrid" | "vector" | "lexical">("hybrid");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ hits: Array<{ chunk: string; score: number; source: string; datasetName: string; docName: string; position: number }>; meta: { effectiveMode: string; vectorUsed: boolean; degraded: boolean; degradeReason?: string } } | null>(null);

  const submit = async (): Promise<void> => {
    if (query.trim().length === 0) {
      toast.error("请输入检索词");
      return;
    }
    setBusy(true);
    try {
      const r = await kbApi.search({ queries: [query.trim()], mode, topK: 8 });
      setResult({ hits: r.hits, meta: r.meta });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-2xl" data-kb-dialog="search-test">
        <DialogHeader>
          <DialogTitle>检索测试</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="kb-q">检索词</Label>
              <Input id="kb-q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="如：量子计算" />
            </div>
            <Select value={mode} onValueChange={(v) => setMode(v as "hybrid" | "vector" | "lexical")}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hybrid">混合</SelectItem>
                <SelectItem value="vector">向量</SelectItem>
                <SelectItem value="lexical">关键词</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? "检索中…" : "检索"}
            </Button>
          </div>

          {result ? (
            <>
              <p className="text-xs text-muted-foreground" data-kb-search-meta="">
                命中 {result.hits.length} 条 · 实际模式 {result.meta.effectiveMode} ·
                向量路 {result.meta.vectorUsed ? "已用" : "未用"}
                {result.meta.degraded ? ` · ⚠️ 降级：${result.meta.degradeReason ?? "未知原因"}` : ""}
              </p>
              <div className="max-h-80 space-y-2 overflow-auto">
                {result.hits.length === 0 ? (
                  <p className="text-sm text-muted-foreground">没有命中。若实际模式被降级，先按上面的提示补环境配置。</p>
                ) : (
                  result.hits.map((h, i) => (
                    <div key={`${h.datasetName}-${h.docName}-${h.position}`} className="rounded border p-2 text-sm">
                      <div className="mb-1 text-xs text-muted-foreground">
                        [{i + 1}] {h.source === "org" ? "全员" : "部门"} · 《{h.datasetName}》 · {h.docName}#{h.position} ·{" "}
                        {h.score.toFixed(3)}
                      </div>
                      <div className="whitespace-pre-wrap">{h.chunk.slice(0, 300)}</div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
