/**
 * 「模型与供应商」合并页（2026-09-19 重构）—— 三级布局：
 *
 *   ① **五个板块 tabs**（对话/向量/重排序/生图/语音）—— 整页最上层，决定下面两块的内容
 *   ② **供应商配置**（上）—— 左列表（本板块专属供应商）+ 右内联表单（不再用弹窗）
 *   ③ **模型列表**（下）—— 当前供应商的模型，撑满剩余高度
 *
 * ## 为什么是「板块 → 专属供应商」而不是「一个供应商挂多种模型」
 *
 * 用户口径（2026-09-19 拍板）：**每个板块单独配置供应商**。所以同一个上游要同时服务
 * 对话与向量时，是**两条 ai_providers 记录**（各自密钥/启停/Base URL），互不影响。
 * 服务端 `ai_providers.model_type` 是这个归属的单一事实源。
 *
 * ## 为什么不做「两态切换」
 *
 * 上一版草图把配置与模型做成互斥的两态；用户明确要求**同时可见、上下堆叠**
 * （配完供应商抬头就能看到它的模型），所以这里是纵向三段而非 tab 切换。
 *
 * ## 诚实标注（本仓一贯纪律，逐条都有界面体现）
 *
 *  · 生图/语音两栏是**预留**：可点但内容为空态并写明「网关无转发链路，配了不生效」；
 *    服务端也拒绝写入这两个板块（见 admin-routes 的板块校验）—— 两侧一致，不假装能用。
 *  · 「按名字推测」徽标：上游不会告诉你模型用途，归类是猜的，因此可逐条改。
 *  · 知识库那两栏显示**实际生效的模型与来源**（管理台配置 / 部署环境变量），
 *    改完需重启 identity —— 界面如实提示，不假装热生效。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowsClockwise,
  CaretDown,
  CaretUp,
  CloudArrowDown,
  Cpu,
  DotsThree,
  Image as ImageIcon,
  Lightning,
  Lock,
  PencilSimple,
  Plus,
  Rows,
  SpeakerHigh,
  TestTube,
  Trash,
  Waveform,
} from "@phosphor-icons/react";
import {
  kbRetrievalApi,
  modelsApi,
  providersApi,
  type AdminKbRetrieval,
  type AdminModel,
  type AdminProvider,
  type DiscoverResult,
  type DiscoveredModel,
  type ResourceScope,
} from "../services/gateway-admin";
import { MODEL_TYPE_LABEL, MODEL_TYPES, isModelTypeAvailable, normalizeModelType, type ModelType } from "../lib/model-types";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import type { Tone } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { deptsApi } from "../services/identity-resources";
import type { DeptNode } from "../types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

/* ────────────────────────── 板块元数据（图标 + 空态文案 + 知识库开关） ────────────────────────── */

interface BoardMeta {
  icon: typeof Cpu;
  /** 空态引导（可操作句子，不是「暂无数据」） */
  emptyHint: string;
  /** 该板块是否参与知识库检索链（向量/重排两栏才有 KB 开关） */
  kb?: "embedding" | "rerank";
}

const BOARD_META: Record<ModelType, BoardMeta> = {
  chat: { icon: Cpu, emptyHint: "点右上「从上游拉取」，用该供应商的密钥拉清单后勾选导入" },
  embedding: {
    icon: Waveform,
    emptyHint: "点右上「从上游拉取」挑选（如 Qwen3-Embedding-8B）；入库时服务端会实测向量维度",
    kb: "embedding",
  },
  rerank: {
    icon: Rows,
    emptyHint: "点右上「从上游拉取」挑选（如 Qwen3-Reranker-8B）—— 不配则检索保持融合顺序",
    kb: "rerank",
  },
  image: { icon: ImageIcon, emptyHint: "本期未接入" },
  audio: { icon: SpeakerHigh, emptyHint: "本期未接入" },
};

/** 预留板块的说明（与 shared/model.ts 的 MODEL_TYPES_RESERVED 对齐；改一处要改两处） */
const RESERVE_NOTE: Partial<Record<ModelType, string>> = {
  image: "网关尚无 /v1/images/generations 转发链路，这里配了也不会生效",
  audio: "TTS / ASR 与 /v1/audio/* 尚未实现",
};


/* ────────────────────────── 范围/表单类型 ────────────────────────── */

interface ModelForm {
  model: string;
  displayName: string;
  features: string[];
  maxContext: string;
  maxOutput: string;
  inputPerM: string;
  outputPerM: string;
  cacheReadPerM: string;
  cacheWritePerM: string;
  currency: string;
  scopeKind: ResourceScope["kind"];
  scopeRoles: string[];
  scopeDeptIds: number[];
  scopeUids: string;
  sort: string;
}

const FEATURES: Array<{ key: string; label: string }> = [
  { key: "tools", label: "工具调用" },
  { key: "reasoning", label: "推理" },
  { key: "anthropic", label: "Anthropic 协议" },
  { key: "vision", label: "视觉输入" },
];

/** 空串 = 不下发（服务端语义：只改传了的字段）；非法数字交给服务端兜底 */
const num = (s: string): number | null => (s.trim() === "" ? null : Number(s));

/** 可见范围的「按角色」选项（与旧 Models 页同口径：本仓只有这三种角色） */
const SCOPE_ROLES: Array<{ key: string; label: string }> = [
  { key: "platform_admin", label: "平台管理员" },
  { key: "dept_head", label: "部门负责人" },
  { key: "user", label: "普通员工" },
];

const SCOPE_LABELS: Record<ResourceScope["kind"], string> = {
  all: "全公司",
  role: "按角色",
  dept: "按部门",
  user: "按账号",
};

/**
 * 供应商表单的**草稿类型**：内联表单是「先改后存」的，所以必须有一份可取消的草稿。
 * 用 `null` 表示「没有未保存改动」（而不是与库值逐字段比较）——比较写法在多轮编辑后会失真。
 */
interface ProviderDraft {
  id: number | null;
  code: string;
  name: string;
  baseUrl: string;
  api: string;
  /**
   * API Key 草稿值。**编辑已有供应商时永远是空串** —— 服务端不回传密钥，
   * 所以空串的语义是「不动」，而不是「清空」（清空会误伤「只改个名字」的场景）。
   */
  apiKey: string;
  enabled: boolean;
}

function emptyDraft(_board: ModelType): ProviderDraft {
  return { id: null, code: "", name: "", baseUrl: "", api: "auto", apiKey: "", enabled: true };
}

function draftOf(p: AdminProvider): ProviderDraft {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    baseUrl: p.baseUrl,
    api: p.api ?? "auto",
    // 密钥不回填（服务端不回传）：空 = 不改
    apiKey: "",
    enabled: p.enabled,
  };
}

/**
 * 模型详情编辑（类型/可见范围/四段价/能力）本轮**未接界面**，仅保留表单模型定义。
 *
 * 为什么保留而不是删掉：模型列表已经能拉取/启停/测试/删除，但「改可见范围与价目」
 * 只能通过接口做 —— 这是下一批要补的入口。先留表单模型（字段与接口一一对应），
 * 免得下一批重新对齐字段名。**导出**是为了让 TS 不把未使用者当漏写。
 */
export function emptyModelForm(): ModelForm {
  return {
    model: "",
    displayName: "",
    features: [],
    maxContext: "",
    maxOutput: "",
    inputPerM: "",
    outputPerM: "",
    cacheReadPerM: "",
    cacheWritePerM: "",
    currency: "",
    scopeKind: "all",
    scopeRoles: [],
    scopeDeptIds: [],
    scopeUids: "",
    sort: "0",
  };
}

/* ───────────────── 板块归属口径（纯函数，探针直接钉这几条） ─────────────────
 *
 * 为什么抽成纯函数而不是写在组件里：SSR（renderToStaticMarkup）**不跑 useEffect**，
 * 所以探针渲染页面时拿不到「数据已到」的那次渲染 —— 与其为了可测性把组件改成收 props，
 * 不如把判断抽出来让探针直接钉矩阵（t197/t198 的同一手法）。
 *
 * 这三个函数都在处理**同一类现实**：管理台（前端）与身份服务（后端）是两条独立发布线，
 * 「新界面 + 旧服务」是常态 —— 旧服务的 `/admin/providers` 不返回 `modelType`。
 * 不兜底就会把供应商全筛掉，用户看到空列表会以为配置丢了（2026-09-19 真实事故）。
 * ─────────────────────────────────────────────────────────────────────── */

/** 某板块的供应商。缺失/未知 `modelType` 一律回退 chat（与服务端 `DEFAULT 'chat'` 一致）。 */
export function providersOfBoard(providers: readonly AdminProvider[], board: ModelType): AdminProvider[] {
  return providers.filter((p) => normalizeModelType(p.modelType) === board);
}

/** 某供应商在某板块下的模型（供应商与模型都必须归一后比较）。 */
export function modelsOfProviderBoard(
  models: readonly AdminModel[],
  providerId: number | null,
  board: ModelType,
): AdminModel[] {
  if (providerId === null) return [];
  return models.filter((m) => m.providerId === providerId && normalizeModelType(m.modelType) === board);
}

/** 各板块的模型计数（未知/缺失类型记到 chat，而不是被丢掉 —— 丢掉会让 tab 数字对不上）。 */
export function countModelsByBoard(models: readonly AdminModel[]): Map<ModelType, number> {
  const out = new Map<ModelType, number>();
  for (const m of models) {
    const t = normalizeModelType(m.modelType);
    out.set(t, (out.get(t) ?? 0) + 1);
  }
  return out;
}

/* ────────────────────────── 页面 ────────────────────────── */

export function ModelsAndProviders() {
  const [params, setParams] = useSearchParams();
  /** 当前板块：写进 URL（?board=embedding），刷新/分享保持（与合并页 OrgUsers 同一手法） */
  const board = ((): ModelType => {
    const b = params.get("board");
    return b !== null && (MODEL_TYPES as readonly string[]).includes(b) ? (b as ModelType) : "chat";
  })();

  const [providers, setProviders] = useState<AdminProvider[] | null>(null);
  const [models, setModels] = useState<AdminModel[] | null>(null);
  const [apis, setApis] = useState<Array<{ value: string; label: string }>>([]);
  const [kb, setKb] = useState<AdminKbRetrieval | null>(null);

  /** 选中的供应商 id（每板块各自记忆：切来切去不该丢上下文） */
  const [selected, setSelected] = useState<Partial<Record<ModelType, number>>>({});
  /** 供应商草稿：非空 = 有未保存改动（含「新增」态） */
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<number | "new" | null>(null);

  // 模型发现
  const [discover, setDiscover] = useState<DiscoverResult | null>(null);
  const [picked, setPicked] = useState<Array<{ id: string; type: ModelType }>>([]);
  const [discoverFilter, setDiscoverFilter] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [importing, setImporting] = useState(false);
  const [testRow, setTestRow] = useState<number | null>(null);

  /**
   * 右侧面板的**两态**（用户口径 2026-09-19）：
   *   `config` = 供应商配置；`models` = 该供应商的模型配置。
   *
   * 切换规则（就是用户描述的那套使用逻辑）：
   *   · 新建供应商 / 点「编辑」   → config
   *   · 保存成功                  → 自动切到 models（配完就该看模型）
   *   · 在左列表点选供应商        → models（已配好的供应商默认看模型）
   */
  const [mode, setMode] = useState<"config" | "models">("models");
  /** 模型编辑草稿（非空 = 打开了编辑弹窗） */
  const [modelEdit, setModelEdit] = useState<ModelForm | null>(null);
  const [modelEditId, setModelEditId] = useState<number | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  /** 可见范围选「按部门」时才拉一次部门树（不拉就不用付这个请求） */
  const [depts, setDepts] = useState<Array<{ id: number; path: string }>>([]);

  const load = useCallback(async () => {
    const [p, m] = await Promise.all([providersApi.list(), modelsApi.list()]);
    setProviders(p.providers);
    setModels(m.models);
    void providersApi.apis().then((r) => setApis(r.apis ?? [])).catch(() => undefined);
    void kbRetrievalApi
      .get()
      .then(setKb)
      .catch(() => setKb(null));
  }, []);

  useEffect(() => {
    void load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  /* ── 派生数据：本板块的供应商 / 当前供应商 / 本供应商的模型 ── */

  /**
   * 本板块的供应商。
   *
   * ⚠ **必须走 `normalizeModelType` 兜底**，不能直接 `p.modelType === board`：
   * 迁移在服务端**启动时**执行，所以「新界面 + 旧服务」时 `modelType` 是 undefined ——
   * 直接比较会把**所有**供应商筛掉、列表变成空的，用户会以为「我配的供应商丢了」
   * （2026-09-19 真实事故）。旧数据回退到 chat，与服务端 `DEFAULT 'chat'` 一致。
   */
  const boardProviders = useMemo(() => providersOfBoard(providers ?? [], board), [providers, board]);

  /** 当前选中的供应商：优先 URL/记忆，其次该板块第一条（保证「选中」永不悬空） */
  const current = useMemo(() => {
    if (boardProviders.length === 0) return null;
    const want = selected[board] ?? (params.get("provider") !== null ? Number(params.get("provider")) : undefined);
    return boardProviders.find((p) => p.id === want) ?? boardProviders[0]!;
  }, [boardProviders, selected, board, params]);

  const boardModels = useMemo(
    () => modelsOfProviderBoard(models ?? [], current?.id ?? null, board),
    [models, board, current],
  );

  /** 每板块的模型计数（tabs 上的数字 = 全平台该板块的模型数，不是当前供应商的） */
  /**
   * 各板块的模型计数。同样走归一兜底：未知/缺失的 model_type 记到 chat，
   * 而不是被 skip 掉（skip 会让 tab 上的数字比实际少，且找不到原因）。
   */
  const countByBoard = useMemo(() => countModelsByBoard(models ?? []), [models]);

  const switchBoard = (b: ModelType): void => {
    // 切板块时丢弃未保存草稿：跨板块的草稿没有意义，留着反而会误存到别的板块
    setDraft(null);
    setDiscover(null);
    const next = new URLSearchParams(params);
    next.set("board", b);
    next.delete("provider");
    setParams(next, { replace: true });
  };

  const selectProvider = (id: number): void => {
    setDraft(null);
    setDiscover(null);
    setSelected((s) => ({ ...s, [board]: id }));
    const next = new URLSearchParams(params);
    next.set("board", board);
    next.set("provider", String(id));
    setParams(next, { replace: true });
  };

  /* ── 供应商：保存 / 启停 / 删除 / 测试 / 拉取 ── */

  const submitProvider = async (): Promise<void> => {
    if (draft === null) return;
    if (!draft.code.trim() || !draft.name.trim() || !draft.baseUrl.trim()) {
      toast.error("编码 / 名称 / Base URL 必填");
      return;
    }
    setBusy(true);
    try {
      if (draft.id === null) {
        await providersApi.create({
          code: draft.code.trim(),
          name: draft.name.trim(),
          baseUrl: draft.baseUrl.trim(),
          // 空串不传（服务端把空串当「未设置」，但显式不传更清楚）
          ...(draft.apiKey.trim() !== "" ? { apiKey: draft.apiKey.trim() } : {}),
          api: draft.api as AdminProvider["api"],
          modelType: board,
        });
        toast.ok(`已在「${MODEL_TYPE_LABEL[board]}」新增供应商`);
      } else {
        await providersApi.patch(draft.id, {
          name: draft.name.trim(),
          baseUrl: draft.baseUrl.trim(),
          // 只填了才传：留空 = 保持原密钥（服务端同口径）
          ...(draft.apiKey.trim() !== "" ? { apiKey: draft.apiKey.trim() } : {}),
          api: draft.api as AdminProvider["api"],
          enabled: draft.enabled,
        });
        toast.ok("已保存（网关 TTL 内生效）");
      }
      setDraft(null);
      /*
       * 保存成功 → **自动切到模型态**（用户口径：配完供应商就该看到它的模型，
       * 下一步就是「一键拉取模型」，不该让用户自己再找入口）。
       */
      setMode("models");
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };


  const removeProvider = async (p: AdminProvider): Promise<void> => {
    const n = (models ?? []).filter((m) => m.providerId === p.id).length;
    if (!window.confirm(`删除供应商「${p.name}」？其名下 ${n} 个模型配置会一并删除（上游数据不受影响）。`)) return;
    try {
      await providersApi.remove(p.id);
      toast.ok(`已删除 ${p.code}`);
      if (current?.id === p.id) setSelected((s) => ({ ...s, [board]: undefined }));
      setDraft(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };


  /** 从上游拉取 → 分类 → 勾选导入（本页的核心入口） */
  const runDiscover = async (): Promise<void> => {
    if (current === null) return;
    setDiscovering(true);
    setDiscover(null);
    setPicked([]);
    try {
      const res = await providersApi.discover(current.id);
      setDiscover(res);
      if (res.ok) {
        // 默认勾选「推测属于本板块、且还没入库」的：不默认勾别的板块，避免误把 chat 塞进向量栏
        const guess = (res.models ?? []).filter(
          (m) => !m.imported && (m.suggestedType ?? "chat") === board,
        );
        setPicked(guess.map((m) => ({ id: m.id, type: board })));
        toast.ok(`拉到 ${res.total ?? 0} 个模型（已入库 ${res.importedCount ?? 0}）`);
      } else {
        toast.error(res.error ?? "拉取失败");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  };

  const doImport = async (): Promise<void> => {
    if (current === null || picked.length === 0) return;
    const byId = new Map((discover?.models ?? []).map((m) => [m.id, m]));
    const payload = picked
      .map(({ id }) => byId.get(id))
      .filter((m): m is DiscoveredModel => m !== undefined)
      .map((m) => ({
        model: m.id,
        displayName: m.name ?? m.id,
        features: (m.features ?? []).filter((f) => FEATURES.some((x) => x.key === f)),
        maxContext: m.contextWindow ?? null,
        maxOutput: m.maxTokens ?? null,
        currency: m.currency ?? null,
        pricing: {
          inputPerM: m.inputPricePer1M ?? null,
          outputPerM: m.outputPricePer1M ?? null,
          cacheReadPerM: m.cacheReadPricePer1M ?? null,
          cacheWritePerM: m.cacheWritePricePer1M ?? null,
        },
      }));
    if (payload.length === 0) {
      toast.error("勾选要导入的模型");
      return;
    }
    setImporting(true);
    try {
      // ⚠ 不传 modelType：服务端按**供应商的板块**强制对齐（见 admin-routes import 段）。
      // 前端仍显示推测值，是为了让用户看清「将要归到哪」，不是让前端决定。
      const r = await modelsApi.import(current.id, payload);
      toast.ok(
        `导入完成：新增 ${r.added} / 更新 ${r.updated}${r.moved ? ` / 归位 ${r.moved}` : ""}`,
      );
      setDiscover(null);
      setPicked([]);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const testModel = async (m: AdminModel): Promise<void> => {
    setTestRow(m.id);
    try {
      const r = await modelsApi.test(m.id);
      if (r.ok) {
        const extra =
          r.embeddingDim !== undefined
            ? ` · 实测维度 ${r.embeddingDim}`
            : r.rerankCount !== undefined
              ? ` · 返回 ${r.rerankCount} 条`
              : "";
        toast.ok(`「${m.model}」测试通过：${r.latencyMs ?? "?"}ms（${r.shape ?? "openai-chat"}）${extra}`);
      } else {
        toast.error(`「${m.model}」测试失败：${r.error ?? "未知错误"}`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTestRow(null);
    }
  };

  const toggleModel = async (m: AdminModel): Promise<void> => {
    try {
      await modelsApi.patch(m.id, { enabled: !m.enabled });
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const removeModel = async (m: AdminModel): Promise<void> => {
    try {
      await modelsApi.remove(m.id);
      toast.ok(`已删除 ${m.model}`);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  /* ── 知识库开关（仅向量/重排两栏） ── */

  const saveKb = async (patch: Partial<{ embeddingEnabled: boolean; embeddingModel: string | null; rerankEnabled: boolean; rerankModel: string | null; embeddingDim: number | null }>): Promise<void> => {
    try {
      await kbRetrievalApi.patch(patch);
      toast.ok("已保存知识库检索配置 —— 需重启 identity 生效");
      void kbRetrievalApi.get().then(setKb).catch(() => undefined);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  /** 展平部门树（可见范围多选用）；与旧 Models 页同一实现 */
  const flattenDepts = (nodes: DeptNode[], out: Array<{ id: number; path: string }> = []): Array<{ id: number; path: string }> => {
    for (const n of nodes) {
      out.push({ id: n.id, path: n.path });
      if (n.children?.length) flattenDepts(n.children, out);
    }
    return out;
  };

  const ensureDepts = useCallback(async (): Promise<void> => {
    if (depts.length > 0) return;
    try {
      const r = await deptsApi.tree();
      setDepts(flattenDepts(r.tree ?? []));
    } catch {
      /* 拉不到就只显示空列表，不阻塞其它字段 */
    }
  }, [depts.length]);

  /* ── 供应商排序（⋯ 菜单里的上移/下移） ── */

  /**
   * 与相邻项交换 `sort` 后各存一次。
   *
   * 为什么不用「拖拽排序」：拖拽要引第三方库、要处理键盘可达性，而这一栏通常只有几个供应商；
   * 上移/下移两个按钮就能覆盖实际需求，且对键盘/读屏友好（本仓的 a11y 纪律）。
   */
  const moveProvider = async (p: AdminProvider, dir: -1 | 1): Promise<void> => {
    const idx = boardProviders.findIndex((x) => x.id === p.id);
    const swap = boardProviders[idx + dir];
    if (idx < 0 || swap === undefined) return;
    try {
      // 两条 PATCH 都写「目标序号」而不是自增自减：自增会依赖对方当前值，并发下会漂
      await providersApi.patch(p.id, { sort: idx + dir });
      await providersApi.patch(swap.id, { sort: idx });
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  /* ── 模型的详情配置（弹窗） ── */

  const openModelEdit = (m: AdminModel): void => {
    setModelEditId(m.id);
    setModelEdit({
      model: m.model,
      displayName: m.displayName ?? "",
      features: [...(m.features ?? [])],
      maxContext: m.maxContext != null ? String(m.maxContext) : "",
      maxOutput: m.maxOutput != null ? String(m.maxOutput) : "",
      inputPerM: m.pricing?.inputPerM != null ? String(m.pricing.inputPerM) : "",
      outputPerM: m.pricing?.outputPerM != null ? String(m.pricing.outputPerM) : "",
      cacheReadPerM: m.pricing?.cacheReadPerM != null ? String(m.pricing.cacheReadPerM) : "",
      cacheWritePerM: m.pricing?.cacheWritePerM != null ? String(m.pricing.cacheWritePerM) : "",
      currency: m.currency ?? "",
      scopeKind: m.scope?.kind ?? "all",
      scopeRoles: [...(m.scope?.roles ?? [])],
      scopeDeptIds: [...(m.scope?.deptIds ?? [])],
      scopeUids: (m.scope?.uids ?? []).join(", "),
      sort: String(m.sort ?? 0),
    });
  };

  const saveModel = async (): Promise<void> => {
    if (modelEdit === null || modelEditId === null) return;
    setSavingModel(true);
    try {
      await modelsApi.patch(modelEditId, {
        displayName: modelEdit.displayName.trim() || modelEdit.model.trim(),
        features: modelEdit.features,
        maxContext: num(modelEdit.maxContext),
        maxOutput: num(modelEdit.maxOutput),
        pricing: {
          inputPerM: num(modelEdit.inputPerM),
          outputPerM: num(modelEdit.outputPerM),
          cacheReadPerM: num(modelEdit.cacheReadPerM),
          cacheWritePerM: num(modelEdit.cacheWritePerM),
        },
        currency: modelEdit.currency.trim() || null,
        scope: {
          kind: modelEdit.scopeKind,
          roles: modelEdit.scopeKind === "role" ? modelEdit.scopeRoles : [],
          deptIds: modelEdit.scopeKind === "dept" ? modelEdit.scopeDeptIds : [],
          uids: modelEdit.scopeKind === "user" ? modelEdit.scopeUids.split(/[,，\s]+/).map((u) => u.trim()).filter(Boolean) : [],
        },
        sort: num(modelEdit.sort) ?? 0,
      });
      toast.ok("模型配置已保存（网关 TTL 内生效）");
      setModelEdit(null);
      setModelEditId(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingModel(false);
    }
  };

  const meta = BOARD_META[board];
  const BoardIcon = meta.icon;
  const available = isModelTypeAvailable(board);

  return (
    <div className="mp-page">
      <PageHead
        title="模型与供应商"
        desc="按用途分板块登记上游供应商与模型；模型参与网关路由，配置经 /v1/models 下发桌面端。"
      />

      {/* ① 板块 tabs（整页最上层） */}
      <div className="mp-tabs" role="tablist" aria-label="模型板块">
        {MODEL_TYPES.map((t) => {
          const Icon = BOARD_META[t].icon;
          const n = countByBoard.get(t) ?? 0;
          const on = t === board;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={on}
              data-board={t}
              className={`mp-tab${on ? " on" : ""}${isModelTypeAvailable(t) ? "" : " reserve"}`}
              onClick={() => switchBoard(t)}
            >
              <Icon size={15} />
              <span>{MODEL_TYPE_LABEL[t]}</span>
              {isModelTypeAvailable(t) ? <span className="n">{n}</span> : <span className="rv">预留</span>}
            </button>
          );
        })}
      </div>

      {!available ? (
        /* 预留板块：直接给空态，不渲染左右两栏（没有可配的东西） */
        <section className="mp-card mp-grow" data-sect="reserve">
          <div className="empty">
            <Lock size={20} />
            <div className="t">{MODEL_TYPE_LABEL[board]}尚未接入</div>
            <div className="s">{RESERVE_NOTE[board]}</div>
          </div>
        </section>
      ) : (
        <div className="mp-split2">
          {/* ══ 左：本板块的供应商列表（每行右侧「⋯」→ 编辑 / 排序 / 删除） ══ */}
          <section className="mp-card mp-provlist" data-sect="list">
            <header className="mp-secthead">
              <h3>供应商</h3>
              <span className="mp-sub">{boardProviders.length} 个</span>
              <div className="spacer" />
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void load()}>
                <ArrowsClockwise size={13} />
              </Button>
              <Button
                size="sm"
                variant="default"
                className="gap-1.5"
                onClick={() => {
                  setDraft(emptyDraft(board));
                  setMode("config");
                  setDiscover(null);
                }}
              >
                <Plus size={13} /> 新增
              </Button>
            </header>
            <div className="mp-list">
              {providers === null ? (
                <SkeletonRows n={3} />
              ) : boardProviders.length === 0 ? (
                <div className="empty" style={{ padding: "20px 10px" }}>
                  <div className="t">暂无供应商</div>
                  <div className="s">本板块的供应商与其它板块互相独立</div>
                </div>
              ) : (
                boardProviders.map((p, idx) => (
                  <div
                    key={p.id}
                    data-provider={p.id}
                    className={`mp-prow${(draft === null && current?.id === p.id) || (draft?.id ?? null) === p.id ? " on" : ""}`}
                    onClick={() => {
                      setDraft(null);
                      setDiscover(null);
                      setMode("models");
                      selectProvider(p.id);
                    }}
                  >
                    <span className="ava">{p.name.slice(0, 1)}</span>
                    <span className="nm-wrap">
                      <span className="nm">{p.name}</span>
                      <span className="cd mono">{p.baseUrl.replace(/^https?:\/\//, "")}</span>
                    </span>
                    <span className={`sd ${p.enabled ? "on" : "off"}`} title={p.enabled ? "已启用" : "已停用"} />
                    {/*
                      ⋯ 菜单：**编辑 / 排序 / 删除**。
                      stopPropagation 是必须的 —— 否则点菜单会同时触发「选中该供应商」，
                      菜单还没开就把右面板切走了（体验上像点不动）。
                    */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="mp-dots"
                          aria-label={`${p.name} 的更多操作`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <DotsThree size={16} weight="bold" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem
                          onSelect={() => {
                            setDiscover(null);
                            setDraft(draftOf(p));
                            setMode("config");
                            selectProvider(p.id);
                          }}
                        >
                          <PencilSimple size={13} /> 编辑配置
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={idx === 0} onSelect={() => void moveProvider(p, -1)}>
                          <CaretUp size={13} /> 上移
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={idx === boardProviders.length - 1} onSelect={() => void moveProvider(p, 1)}>
                          <CaretDown size={13} /> 下移
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => void removeProvider(p)}>
                          <Trash size={13} /> 删除供应商
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* ══ 右：两态面板（供应商配置 ⇄ 模型配置） ══ */}
          <section
            className="mp-card mp-grow"
            data-sect={mode === "config" ? "providers" : "models"}
            data-panel={mode}
          >
            <header className="mp-secthead">
              <h3>{mode === "config" ? (draft?.id === null ? "新增供应商" : "供应商配置") : "模型配置"}</h3>
              <span className="mp-sub">
                {mode === "config"
                  ? current !== null && draft?.id !== null
                    ? `${current.name} · 改完保存即生效`
                    : `为「${MODEL_TYPE_LABEL[board]}」登记一条上游`
                  : current !== null
                    ? `${current.name} · ${MODEL_TYPE_LABEL[board]}`
                    : "先在左侧选一个供应商"}
              </span>
              <div className="spacer" />
              {/* 两态开关：与「保存后自动切到模型」配合，随时可手动切回改配置 */}
              {current !== null || draft !== null ? (
                <div className="seg" role="tablist" aria-label="面板">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "models"}
                    className={mode === "models" ? "on" : ""}
                    onClick={() => setMode("models")}
                  >
                    模型
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "config"}
                    className={mode === "config" ? "on" : ""}
                    onClick={() => {
                      if (draft === null && current !== null) setDraft(draftOf(current));
                      setMode("config");
                    }}
                  >
                    供应商配置
                  </button>
                </div>
              ) : null}
            </header>

            {mode === "config" ? (
              /* ── 态 A：供应商配置（只改字段，保存 / 取消在底部常驻栏） ── */
              draft === null && current === null ? (
                <div className="empty">
                  <div className="t">左侧选择一个供应商</div>
                  <div className="s">或点「新增」为「{MODEL_TYPE_LABEL[board]}」登记一条</div>
                </div>
              ) : (
                (() => {
                  const f = draft ?? draftOf(current!);
                  const isNew = draft !== null && draft.id === null;
                  const hasKey = !isNew && current?.hasApiKey === true;
                  const set = (patch: Partial<ProviderDraft>): void =>
                    setDraft((d) => (d === null ? d : { ...d, ...patch }));
                  return (
                    <>
                      <div className="mp-formbody">
                        <div className="mp-grid2">
                          <div className="field">
                            <Label>编码（唯一）</Label>
                            <Input className="mono" value={f.code} disabled={!isNew} onChange={(e) => set({ code: e.target.value })} placeholder="gitee" />
                            <span className="hint">同一板块内唯一；跨板块可重复（板块各自独立配置）</span>
                          </div>
                          <div className="field">
                            <Label>名称</Label>
                            <Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="千问云 · gitee" />
                          </div>
                          <div className="field" style={{ gridColumn: "1 / -1" }}>
                            <Label>Base URL</Label>
                            <Input className="mono" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://ai.gitee.com/v1" />
                            <span className="hint">上游真实端点；模型拉取与连通性测试都按它拼 /models</span>
                          </div>
                          {/*
                            API Key **单独占一行**：密钥是很长的串，半栏宽只看得到一小截，
                            而它又是这一页最需要「看清楚再粘贴」的字段。
                          */}
                          <div className="field" style={{ gridColumn: "1 / -1" }}>
                            <Label htmlFor="mp-apikey">API Key</Label>
                            <Input
                              id="mp-apikey"
                              type="password"
                              autoComplete="new-password"
                              className="mono"
                              value={f.apiKey}
                              placeholder={hasKey ? "已配置 · 留空则不修改" : "粘贴上游 API Key"}
                              onChange={(e) => set({ apiKey: e.target.value })}
                            />
                            <span className="hint">
                              {hasKey
                                ? "已配置（服务端加密存储，不回传）；留空则保持原值"
                                : "加密后落库（AES-256-GCM），任何接口都不会回传明文"}
                            </span>
                          </div>
                          {/*
                            协议 + 启用状态同占一行：协议是单选（文字短），独占一整行会拖出
                            一条空得厉害的横线；「启用」原来也独占一行、四周大片空白，像漏了东西。
                          */}
                          <div className="field">
                            <Label>上游协议类型</Label>
                            <Select value={f.api} onValueChange={(v) => set({ api: v })}>
                              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {/*
                                  选项来自服务端（/admin/provider-apis）；历史值（如 google-generative-ai，
                                  界面已不再提供）额外补一项，否则 Select 会显示空占位、像配置丢了。
                                */}
                                {(apis.some((a) => a.value === f.api)
                                  ? apis
                                  : [...apis, { value: f.api, label: `${f.api}（历史配置，界面不再提供）` }]
                                ).map((a) => (
                                  <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="field" style={{ alignItems: "flex-end" }}>
                            {/* 启用推到右边缘（用户口径）：它是「开关」而不是「输入项」，贴着右侧与左侧的
                                下拉形成一条稳定的水平线，比顶在右栏左边缘（看着像没对齐）顺眼得多。 */}
                            <Label style={{ textAlign: "right" }}>启用状态</Label>
                            {/* 与左侧 Select 同高（32px）：两栏控件高度不一致会显得整行歪掉 */}
                            <div className="swrow" style={{ height: 32 }}>
                              <Switch checked={f.enabled} onCheckedChange={(v) => set({ enabled: v })} />
                              <span className="lb">{f.enabled ? "已启用" : "已停用"}</span>
                            </div>
                            <span className="hint" style={{ textAlign: "right" }}>停用后其名下模型一律不可用（网关返回 404）</span>
                          </div>
                        </div>
                      </div>

                      {/*
                        底部动作栏：「测试连接」属于模型态（配完模型之后的事），这里不放；
                        「取消」紧跟保存；删除只在左列表的「⋯」菜单里 —— 同屏放两个删除入口
                        既有误点风险，也让「取消/保存」这一对不再纯粹。
                      */}
                      <div className="mp-formfoot">
                        <div className="spacer" />
                        <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setMode("models"); }}>
                          取消
                        </Button>
                        <Button size="sm" variant="default" disabled={draft === null || busy} onClick={() => void submitProvider()}>
                          {busy ? "保存中…" : isNew ? "创建并配置模型" : "保存"}
                        </Button>
                      </div>
                    </>
                  );
                })()
              )
            ) : (
              /* ── 态 B：模型配置（拉取 / 逐个模型配置 / 测试连接） ── */
              <>
                {meta.kb !== undefined && kb !== null ? (
                  <div className="mp-kbnote">
                    <KbControl
                      label={meta.kb === "embedding" ? "知识库向量化" : "知识库重排序"}
                      enabled={meta.kb === "embedding" ? kb.config.embeddingEnabled : kb.config.rerankEnabled}
                      model={meta.kb === "embedding" ? kb.config.embeddingModel : kb.config.rerankModel}
                      options={boardModels.map((m) => m.model)}
                      onSave={(on, model) =>
                        meta.kb === "embedding"
                          ? void saveKb({ embeddingEnabled: on, embeddingModel: model })
                          : void saveKb({ rerankEnabled: on, rerankModel: model })
                      }
                    />
                    {meta.kb === "embedding" ? (
                      kb.effective.embeddingModel !== null ? (
                        <span>
                          当前生效：<b className="mono">{kb.effective.embeddingModel}</b>
                          {kb.dim !== null ? <> · 库内维度 <b className="mono">{kb.dim}</b></> : null}
                          {kb.effective.requiresRestart ? <span className="mp-dim"> · 改完需重启 identity</span> : null}
                        </span>
                      ) : (
                        <span><Lock size={12} /> 未配置 ⇒ 检索降级为纯词法</span>
                      )
                    ) : kb.effective.rerankModel !== null ? (
                      <span>当前生效：<b className="mono">{kb.effective.rerankModel}</b></span>
                    ) : (
                      <span><Lock size={12} /> 未配置 ⇒ 保持融合顺序（不重排）</span>
                    )}
                  </div>
                ) : null}

                <div className="mp-modelbar">
                  <span className="chip warn"><span className="dot" />未登记的模型网关返回 404</span>
                  <div className="spacer" />
                  {current !== null ? (
                    <>
                      <Button size="sm" variant="outline" className="gap-1.5" disabled={discovering} onClick={() => void runDiscover()}>
                        <CloudArrowDown size={13} /> {discovering ? "拉取中…" : "一键拉取模型"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1.5"
                        title="用该供应商的密钥请求一次上游 /models，验证连通性"
                        disabled={testing !== null}
                        onClick={() => {
                          setDraft(null);
                          setTesting(current.id);
                          void providersApi
                            .test(current.id)
                            .then((r) => (r.ok ? toast.ok(`连通正常：${r.modelCount ?? 0} 个模型 · ${r.latencyMs}ms`) : toast.error(`连通失败：${r.error ?? "未知原因"}`)))
                            .catch((e) => toast.error((e as Error).message))
                            .finally(() => setTesting(null));
                        }}
                      >
                        <Lightning size={13} /> {testing === current.id ? "测试中…" : "测试连接"}
                      </Button>
                    </>
                  ) : null}
                </div>

                <div className="mp-rows">
                  {models === null ? (
                    <SkeletonRows />
                  ) : current === null ? (
                    <div className="empty">
                      <div className="t">先在左侧选一个供应商</div>
                      <div className="s">{meta.emptyHint}</div>
                    </div>
                  ) : boardModels.length === 0 ? (
                    <div className="empty">
                      <BoardIcon size={20} />
                      <div className="t">「{current.name}」下还没有{MODEL_TYPE_LABEL[board]}</div>
                      <div className="s">{meta.emptyHint}</div>
                    </div>
                  ) : (
                    boardModels.map((m) => (
                      <div key={m.id} className="mp-mrow" data-model={m.id}>
                        <div className="mp-mid">
                          <div className="mp-m1">
                            {m.displayName || m.model}
                            {m.params?.["dim"] !== undefined ? <span className="tag">{String(m.params["dim"])} 维</span> : null}
                          </div>
                          <div className="mp-m2 mono">
                            {m.model}
                            {m.maxContext != null ? ` · ${Math.round(m.maxContext / 1000)}K` : ""}
                            {m.maxOutput != null ? ` / ${Math.round(m.maxOutput / 1000)}K` : ""}
                            {m.pricing?.inputPerM != null ? ` · 入 ¥${m.pricing.inputPerM}` : ""}
                            {m.pricing?.outputPerM != null ? ` / 出 ¥${m.pricing.outputPerM}` : ""}
                            {m.currency ? ` ${m.currency}` : ""}
                          </div>
                          <div className="mp-m3">
                            {(m.features ?? []).map((feat) => (
                              <span key={feat} className={`tag ${feat === "tools" || feat === "reasoning" ? "i" : ""}`}>
                                {FEATURES.find((x) => x.key === feat)?.label ?? feat}
                              </span>
                            ))}
                            {m.scope && m.scope.kind !== "all" ? <span className="tag a">{SCOPE_LABELS[m.scope.kind]}</span> : null}
                          </div>
                        </div>
                        <div className="mp-macts">
                          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openModelEdit(m)}>
                            <PencilSimple size={12} /> 配置
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            disabled={testRow === m.id}
                            title="发起一次最小真实调用（约几个 token）"
                            onClick={() => void testModel(m)}
                          >
                            <TestTube size={12} /> {testRow === m.id ? "测试中…" : "测试"}
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => void removeModel(m)}>
                            <Trash size={12} />
                          </Button>
                          <Switch checked={m.enabled} onCheckedChange={() => void toggleModel(m)} />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* 拉取对话框：按板块过滤 + 标注「按名字推测」 */}
      <Dialog open={discover !== null && discover.ok} onOpenChange={(o) => !o && setDiscover(null)}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>
              一键拉取模型 · {MODEL_TYPE_LABEL[board]}（{current?.name ?? ""}）
            </DialogTitle>
          </DialogHeader>
          <div className="modal-body">
            {discover?.ok ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="cell-sub">
                    上游共 <b>{discover.total}</b> 个 · 已入库 <b>{discover.importedCount}</b> · 本次已勾 <b>{picked.length}</b>
                    {discover.latencyMs != null ? ` · ${discover.latencyMs}ms` : ""}
                  </span>
                  <span className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setPicked(
                          (discover.models ?? [])
                            .filter((m) => !m.imported && (m.suggestedType ?? "chat") === board)
                            .map((m) => ({ id: m.id, type: board })),
                        )
                      }
                    >
                      仅选推测属于本板块
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setPicked([])}>清空</Button>
                  </span>
                </div>
                <Input
                  value={discoverFilter}
                  onChange={(e) => setDiscoverFilter(e.target.value)}
                  placeholder="过滤模型名…"
                  style={{ marginTop: 8 }}
                />
                <div className="mp-dlist">
                  {(discover.models ?? [])
                    .filter((m) => (discoverFilter.trim() ? m.id.toLowerCase().includes(discoverFilter.trim().toLowerCase()) : true))
                    .map((m) => {
                      const on = picked.some((p) => p.id === m.id);
                      const guessed = m.suggestedType ?? "chat";
                      const mismatch = guessed !== board;
                      return (
                        <label key={m.id} className="mp-drow">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) =>
                              setPicked((cur) => (e.target.checked ? [...cur, { id: m.id, type: guessed }] : cur.filter((x) => x.id !== m.id)))
                            }
                          />
                          <span className="mono mp-dname">{m.id}</span>
                          <span className="cell-sub" style={{ fontSize: 11.5 }}>
                            {m.contextWindow ? `上下文 ${Math.round(m.contextWindow / 1000)}K` : ""}
                            {m.inputPricePer1M != null ? ` · 入 ${m.inputPricePer1M} / 出 ${m.outputPricePer1M ?? "-"}` : ""}
                          </span>
                          <span className="spacer" />
                          <span className={`tag ${mismatch ? "w" : ""}`} title="按模型名推测的用途，导入时以本板块为准">
                            推测：{MODEL_TYPE_LABEL[guessed]}
                          </span>
                          {m.imported ? <span className="tag">已入库</span> : null}
                        </label>
                      );
                    })}
                </div>
              </>
            ) : null}
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setDiscover(null)}>取消</Button>
            <Button variant="default" disabled={importing || picked.length === 0} onClick={() => void doImport()}>
              {importing ? "导入中…" : `导入选中（${picked.length}）`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 模型详情配置（每个模型的窗口/价目/能力/可见范围） */}
      <Dialog open={modelEdit !== null} onOpenChange={(o) => { if (!o) { setModelEdit(null); setModelEditId(null); } }}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>模型配置 · {modelEdit?.model ?? ""}</DialogTitle>
          </DialogHeader>
          <div className="modal-body">
            {modelEdit !== null ? (
              <>
                <div className="field">
                  <Label>模型 ID（上游真实名，不可改）</Label>
                  <Input className="mono" value={modelEdit.model} disabled />
                  <span className="hint">携带这个名字的请求由网关路由到本供应商；改名会变成另一个模型</span>
                </div>
                <div className="field">
                  <Label htmlFor="me-name">显示名</Label>
                  <Input id="me-name" value={modelEdit.displayName} onChange={(e) => setModelEdit({ ...modelEdit, displayName: e.target.value })} />
                </div>
                {board === "chat" ? (
                  <>
                    <div className="field">
                      <Label>能力标记</Label>
                      <div className="mp-headers">
                        {FEATURES.map((feat) => (
                          <label key={feat.key} className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                            <input
                              type="checkbox"
                              checked={modelEdit.features.includes(feat.key)}
                              onChange={(e) =>
                                setModelEdit({
                                  ...modelEdit,
                                  features: e.target.checked ? [...modelEdit.features, feat.key] : modelEdit.features.filter((x) => x !== feat.key),
                                })
                              }
                            />
                            {feat.label}
                          </label>
                        ))}
                      </div>
                      <span className="hint">经 /v1/models 下发给桌面端（supports_*）；向量/重排模型不需要这些</span>
                    </div>
                    <div className="flex gap-3">
                      <div className="field" style={{ flex: 1 }}>
                        <Label htmlFor="me-ctx">上下文窗口（tokens）</Label>
                        <Input id="me-ctx" inputMode="numeric" value={modelEdit.maxContext} onChange={(e) => setModelEdit({ ...modelEdit, maxContext: e.target.value })} />
                      </div>
                      <div className="field" style={{ flex: 1 }}>
                        <Label htmlFor="me-out">最大输出</Label>
                        <Input id="me-out" inputMode="numeric" value={modelEdit.maxOutput} onChange={(e) => setModelEdit({ ...modelEdit, maxOutput: e.target.value })} />
                      </div>
                    </div>
                    <div className="mp-grid2">
                      <div className="field">
                        <Label htmlFor="me-in">输入价（¥ / 百万 tokens）</Label>
                        <Input id="me-in" inputMode="decimal" value={modelEdit.inputPerM} onChange={(e) => setModelEdit({ ...modelEdit, inputPerM: e.target.value })} />
                      </div>
                      <div className="field">
                        <Label htmlFor="me-outp">输出价</Label>
                        <Input id="me-outp" inputMode="decimal" value={modelEdit.outputPerM} onChange={(e) => setModelEdit({ ...modelEdit, outputPerM: e.target.value })} />
                      </div>
                      <div className="field">
                        <Label htmlFor="me-cr">缓存读价</Label>
                        <Input id="me-cr" inputMode="decimal" value={modelEdit.cacheReadPerM} onChange={(e) => setModelEdit({ ...modelEdit, cacheReadPerM: e.target.value })} />
                      </div>
                      <div className="field">
                        <Label htmlFor="me-cw">缓存写价</Label>
                        <Input id="me-cw" inputMode="decimal" value={modelEdit.cacheWritePerM} onChange={(e) => setModelEdit({ ...modelEdit, cacheWritePerM: e.target.value })} />
                      </div>
                      <div className="field">
                        <Label htmlFor="me-cur">币种</Label>
                        <Input id="me-cur" className="mono" placeholder="CNY" value={modelEdit.currency} onChange={(e) => setModelEdit({ ...modelEdit, currency: e.target.value })} />
                      </div>
                      <div className="field">
                        <Label htmlFor="me-sort">排序</Label>
                        <Input id="me-sort" inputMode="numeric" value={modelEdit.sort} onChange={(e) => setModelEdit({ ...modelEdit, sort: e.target.value })} />
                      </div>
                    </div>
                    <div className="field">
                      <Label>可见范围</Label>
                      <Select
                        value={modelEdit.scopeKind}
                        onValueChange={(v) => {
                          const kind = v as ResourceScope["kind"];
                          if (kind === "dept") void ensureDepts();
                          setModelEdit({ ...modelEdit, scopeKind: kind });
                        }}
                      >
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {(Object.keys(SCOPE_LABELS) as ResourceScope["kind"][]).map((k) => (
                            <SelectItem key={k} value={k}>{SCOPE_LABELS[k]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="hint">未授权时网关返回 403（不是静默隐藏）</span>
                    </div>
                    {modelEdit.scopeKind === "role" ? (
                      <div className="flex flex-wrap gap-4">
                        {SCOPE_ROLES.map((r) => (
                          <label key={r.key} className="flex items-center gap-2" style={{ fontSize: 13 }}>
                            <input
                              type="checkbox"
                              checked={modelEdit.scopeRoles.includes(r.key)}
                              onChange={(e) =>
                                setModelEdit({
                                  ...modelEdit,
                                  scopeRoles: e.target.checked ? [...modelEdit.scopeRoles, r.key] : modelEdit.scopeRoles.filter((x) => x !== r.key),
                                })
                              }
                            />
                            {r.label}
                          </label>
                        ))}
                      </div>
                    ) : null}
                    {modelEdit.scopeKind === "dept" ? (
                      <div className="mp-headers" style={{ maxHeight: 180, overflowY: "auto" }}>
                        {depts.length === 0 ? (
                          <span className="hint">暂无部门（先同步 AD 或建部门）</span>
                        ) : (
                          depts.map((d) => (
                            <label key={d.id} className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                              <input
                                type="checkbox"
                                checked={modelEdit.scopeDeptIds.includes(d.id)}
                                onChange={(e) =>
                                  setModelEdit({
                                    ...modelEdit,
                                    scopeDeptIds: e.target.checked ? [...modelEdit.scopeDeptIds, d.id] : modelEdit.scopeDeptIds.filter((id) => id !== d.id),
                                  })
                                }
                              />
                              {d.path}
                            </label>
                          ))
                        )}
                      </div>
                    ) : null}
                    {modelEdit.scopeKind === "user" ? (
                      <div className="field">
                        <Label htmlFor="me-uids">账号（逗号或空格分隔）</Label>
                        <Input id="me-uids" value={modelEdit.scopeUids} placeholder="zhangsan, lisi" onChange={(e) => setModelEdit({ ...modelEdit, scopeUids: e.target.value })} />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <span className="hint">
                    {MODEL_TYPE_LABEL[board]}的配置项较少：只有显示名、排序与启用/停用。
                    窗口与价目对这类模型没有意义（网关按向量/重排语义调用，不做输出窗口钳制）。
                  </span>
                )}
              </>
            ) : null}
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => { setModelEdit(null); setModelEditId(null); }}>取消</Button>
            <Button variant="default" disabled={savingModel} onClick={() => void saveModel()}>
              {savingModel ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ────────────────────────── 小部件 ────────────────────────── */

function KbControl({
  label,
  enabled,
  model,
  options,
  onSave,
}: {
  label: string;
  enabled: boolean;
  model: string | null;
  options: string[];
  onSave: (on: boolean, model: string | null) => void;
}) {
  const noOptions = options.length === 0;
  const disabled = noOptions && !enabled;
  return (
    <span className="mp-kbctl" title={disabled ? "本板块还没有入库模型，先在下面拉取" : undefined}>
      <Switch
        checked={enabled}
        disabled={disabled}
        onCheckedChange={(on) => onSave(on, model ?? options[0] ?? null)}
      />
      <span className="lb">{label}</span>
      <Select
        value={model ?? (options[0] ?? "none")}
        onValueChange={(v) => onSave(enabled, v === "none" ? null : v)}
      >
        <SelectTrigger className="mp-kbsel"><SelectValue placeholder="选择模型" /></SelectTrigger>
        <SelectContent>
          {options.length === 0 ? <SelectItem value="none">（本板块暂无模型）</SelectItem> : null}
          {options.map((o) => (
            <SelectItem key={o} value={o}>{o}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}

/** 供探针引用的板块清单（单一事实源来自 shared，这里只是转出，避免探针 import shared 时打到 dist） */
export const BOARDS: readonly ModelType[] = MODEL_TYPES;
export { MODEL_TYPE_LABEL };
export type { ModelType };
export const BOARD_TONE: Record<ModelType, Tone> = {
  chat: "accent",
  embedding: "success",
  rerank: "info",
  image: "neutral",
  audio: "neutral",
};
