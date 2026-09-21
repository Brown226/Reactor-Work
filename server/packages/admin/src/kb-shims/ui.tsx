/**
 * 知识库移植的 **UI 侧 shim**——把移植页面引用的「上游工作区里的零碎件」在本仓实现掉。
 *
 * 与 `data.tsx` 同一套理由（见该文件头注）：手写代码不能放进 `kb-port/`（移植脚本每次全量重建），
 * 所以脚本把页面里的这些外部 import **机械改指**到本文件。
 *
 * ## 这里装了什么（共 11 项，都是「用到一点点、不值得整包搬」的东西）
 *
 * | 上游 specifier | 本文件导出 | 处置 |
 * |---|---|---|
 * | `@/layouts/console/_components/page-container` | `PageContainer` | ★ 顺带承担**作用域与主题**（见下） |
 * | `@/components/ask-assistant-ui` | `ModelSelector` | 只用到模型选择器，本仓自绘 |
 * | `@/components/provider-icons` | `ProviderIcon` | 模型厂商图标，退化为首字母徽标 |
 * | `@/components/tags` | `TagSelect` | 标签多选，本仓自绘 |
 * | `@/components/file-fomat-icons` | `FileFormatIcon` | 文件格式图标，退化为扩展名徽标 |
 * | `@/utils/format` | `getFileFormatKey` | 纯函数 |
 * | `@buildingai/i18n` | `useI18n` | 只用到 `locale`（时间组件用） |
 * | `@buildingai/constants` | `TagTypeType` | 仅类型 |
 * | `@buildingai/constants/shared/status-codes.constant` | `BooleanNumber` | 枚举 |
 * | `@buildingai/stores` | `useAuthStore` | ⚠️ **mock 权限（见下）** |
 *
 * ## ★ 为什么 `PageContainer` 承担作用域与主题
 *
 * `theme.css` 里那份 4.6k 行 token 被改成只作用于 `.reactor-kb-scope` 子树
 *（Tailwind v4 的 `@theme` 只能顶层，直接引会污染整个后台的语义色）。
 * 两个移植页面都用 `<PageContainer>` 包根节点 —— 所以**在这里套作用域**，
 * 「引一次主题 + 套一层作用域」就不会漏、也不用每个页面各写一遍。
 *
 * ## ⚠️ `useAuthStore` 是 mock，且是「一律放行」
 *
 * `permission-guard.tsx` 用 `useAuthStore((s) => s.auth)` 读 `userInfo.isRoot` 与
 * `userInfo.permissionsCodes` 来决定是否渲染子节点。mock 阶段为了让页面**看得见**，
 * 这里固定返回 `isRoot = YES`、权限码为空数组 —— 即**权限校验形同虚设**。
 *
 * 这是刻意的中间态，但绝不能上线：真权限来自服务端（`admin/src/stores/auth.ts` 的
 * `useAuthStore` 有真实的 user/scope），KB-⑥ 后端落地时要把它换回本仓真 store 并按
 * 数据集可见性（个人/部门/公开）校验。**在那之前，这个预览页只用于看版式。**
 */

import { useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import "../kb-port/theme/theme.css";

// ─────────────────────────────────────────────────────────────────────────────
// PageContainer：页面外壳 + 作用域 + 主题 + **必需 Provider**（见下）
// ─────────────────────────────────────────────────────────────────────────────

export interface PageContainerProps {
  children: ReactNode;
  className?: string;
}

/**
 * ⚠️ Provider 必须在**页面组件的祖先**上挂，不能挂在这里。
 *
 * 移植页面在组件**顶部**就调用 `useAlertDialog()`（如 `list/index.tsx` 的
 * `const { confirm } = useAlertDialog()`），而 `<PageContainer>` 是该组件 return 出来的**子节点** ——
 * context 只能向下流，所以把 provider 放进 PageContainer 是**无效**的（探针实测仍抛
 * `useAlertDialog must be used within an AlertDialogProvider`）。
 *
 * 上游把 provider 挂在它的 **console 外壳**里，而外壳按清单 §2 决策不搬 ⇒ 这个责任归我们。
 * 当前的挂载点：`pages/KbDatasetsPreview.tsx`（预览包装层）。
 * **正式把 `/kb` 指向移植页面时，必须把 provider 提到路由/布局层**（任何移植页面的祖先），
 * 否则那些页面一打开就抛错 —— 这是 t193 探针抓到并钉住的约束。
 */
export function PageContainer({ children, className }: PageContainerProps): ReactNode {
  return (
    <div className={`reactor-kb-scope reactor-kb-page${className ? ` ${className}` : ""}`}>
      <div className="mx-auto w-full max-w-[1200px] px-6 py-5">{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 模型选择器（上游是 ask-assistant-ui 里的富组件；这里退化为原生 select）
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelSelectorProps {
  /** "llm" | "text-embedding" | … —— 决定候选项 */
  modelType?: string;
  value?: string;
  onSelect?: (value: string) => void;
  placeholder?: string;
  triggerVariant?: string;
  className?: string;
}

const MOCK_MODELS: Record<string, string[]> = {
  llm: ["deepseek-chat", "deepseek-reasoner", "gpt-4o-mini"],
  "text-embedding": ["bge-m3", "text-embedding-3-large", "text-embedding-3-small"],
};

export function ModelSelector({ modelType = "llm", value, onSelect, placeholder, className }: ModelSelectorProps): ReactNode {
  const options = MOCK_MODELS[modelType] ?? MOCK_MODELS["llm"] ?? [];
  return (
    <select
      className={`h-9 rounded-md border border-input bg-transparent px-3 text-sm${className ? ` ${className}` : ""}`}
      value={value ?? ""}
      onChange={(e) => onSelect?.(e.target.value)}
      data-kb-shim="model-selector"
    >
      <option value="">{placeholder ?? "请选择模型"}</option>
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 图标类 shim：都退化为「文字徽标」，避免为几个图标引入上游整包
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderIconProps {
  provider?: string;
  className?: string;
  /** 无匹配图标时渲染的内容（调用方会传一个 lucide 图标） */
  fallback?: ReactNode;
}

export function ProviderIcon({ provider, className, fallback }: ProviderIconProps): ReactNode {
  if (!provider) return <>{fallback ?? null}</>;
  return (
    <span className={`inline-flex items-center justify-center text-[10px] font-semibold uppercase${className ? ` ${className}` : ""}`} title={provider} data-kb-shim="provider-icon">
      {provider.slice(0, 1)}
    </span>
  );
}

export interface ProviderAvatarProps {
  /** 厂商标识（openai / anthropic / …）；本仓没有厂商图标库 ⇒ 恒走首字母退化 */
  provider?: string;
  /** 厂商图标 URL（上游有图时用图；本仓恒无） */
  iconUrl?: string;
  /** 展示名（模型名/厂商名）——provider 为空时用它出首字母 */
  name?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * 上游 `@/components/provider-avatar` 的退化实现（dashboard 的 Token 排行用）。
 * 上游按 provider 匹配品牌图标；本仓没有图标库 ⇒ 用「名称首字母」兜底 ——
 * 这不是编造数据，是**图标缺失时的占位**（与 fallback 同性质）。
 */
export function ProviderAvatar({ provider, name, size = "md", className }: ProviderAvatarProps): ReactNode {
  const label = (provider || name || "?").trim();
  const px = size === "sm" ? "size-5 text-[10px]" : size === "lg" ? "size-9 text-sm" : "size-7 text-xs";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-md border bg-muted font-semibold uppercase text-muted-foreground ${px}${className ? ` ${className}` : ""}`}
      title={name ?? provider}
      data-kb-shim="provider-avatar"
    >
      {label.slice(0, 2)}
    </span>
  );
}

export interface FileFormatIconProps {
  format?: string;
  className?: string;
}

export function FileFormatIcon({ format, className }: FileFormatIconProps): ReactNode {
  return (
    <span className={`inline-flex items-center justify-center rounded border px-1 text-[10px] font-medium uppercase${className ? ` ${className}` : ""}`} data-kb-shim="file-format-icon">
      {(format ?? "file").slice(0, 4)}
    </span>
  );
}

/** 上游把「文件名/类型」归一成图标 key；这里只做最小映射 */
export function getFileFormatKey(fileType?: string | null): string {
  const t = (fileType ?? "").toLowerCase();
  if (t.includes("pdf")) return "pdf";
  if (t.includes("doc")) return "doc";
  if (t.includes("xls")) return "xls";
  if (t.includes("ppt")) return "ppt";
  if (t.includes("md") || t.includes("markdown")) return "md";
  if (t.includes("txt")) return "txt";
  return "file";
}

// ─────────────────────────────────────────────────────────────────────────────
// 标签选择（上游是带远端搜索的多选；这里退化为本地假标签）
// ─────────────────────────────────────────────────────────────────────────────

export type TagTypeType = "dataset" | "agent" | "tool" | (string & {});

export interface TagSelectProps {
  type?: TagTypeType;
  value?: string[];
  onChange?: (ids: string[]) => void;
  placeholder?: string;
  className?: string;
}

const MOCK_TAGS = [
  { id: "t-1", name: "研发" },
  { id: "t-2", name: "行政" },
  { id: "t-3", name: "法务" },
  { id: "t-4", name: "市场" },
];

export function TagSelect({ value = [], onChange, className }: TagSelectProps): ReactNode {
  const toggle = (id: string) => {
    const next = value.includes(id) ? value.filter((v) => v !== id) : [...value, id];
    onChange?.(next);
  };
  return (
    <div className={`flex flex-wrap items-center gap-1.5${className ? ` ${className}` : ""}`} data-kb-shim="tag-select">
      {MOCK_TAGS.map((t) => {
        const active = value.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => toggle(t.id)}
            className={`rounded-full border px-2 py-0.5 text-xs ${active ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}`}
          >
            {t.name}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具类 shim
// ─────────────────────────────────────────────────────────────────────────────

/** 上游的状态码枚举（`BooleanNumber.YES === 1`） */
export const BooleanNumber = { NO: 0, YES: 1 } as const;

/** 上游 i18n：本仓只用到 locale（时间组件选 date-fns locale 用） */
export function useI18n(): { locale: string; t: (key: string) => string } {
  return { locale: "zh-CN", t: (key: string) => key };
}

/**
 * ⚠️ **mock 权限 store：一律放行**（见文件头注）。
 *
 * 形状对齐 `permission-guard.tsx` 的用法：`useAuthStore((s) => s.auth)` → `{ userInfo }`。
 * 真实现应换成 `admin/src/stores/auth.ts` 的 `useAuthStore` + 数据集可见性校验。
 */
export function useAuthStore<T>(selector: (state: {
  auth: { userInfo: { isRoot: number; permissionsCodes: string[] }; token: string | null };
  /** 登录页（kb-shims/login.tsx）要 `s.authActions.setToken`；对话侧只读 `s.auth` */
  authActions: { setToken: (t: string) => void; isLogin: () => boolean };
}) => T): T {
  return selector({
    auth: {
      userInfo: { isRoot: BooleanNumber.YES, permissionsCodes: [] },
      token: null,
    },
    authActions: { setToken: () => {}, isLogin: () => false },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 两个 npm 包也一并 shim 掉（`usehooks-ts` / `date-fns`）
//
// ## 为什么不直接装这两个包
//
// 移植脚本自己立过一条先例：为「闭包里其实没人用」的三个组件**不装**三个依赖
//（embla-carousel-react / cmdk / react-resizable-panels，见脚本 PRUNE 段注释）。
// 这里同一口径：实际用到的只有 `useDebounceValue` 一个 hook 与
// `formatDistanceToNow` 一个函数 —— 为此在 admin 里新增两个第三方依赖不划算，
// 也让移植子树继续保持「零新增依赖」。
//
// 真需要 `date-fns` 的完整能力（多语言/多格式）时，把脚本的改指规则去掉、
// 在 `packages/admin/package.json` 加依赖即可 —— 页面侧不用改。
// ─────────────────────────────────────────────────────────────────────────────

/** `usehooks-ts` 的 `useDebounceValue`：返回 `[debouncedValue, setValue]`（页面只取第一个） */
export function useDebounceValue<T>(value: T, delay = 500): [T, (next: T) => void] {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return [debounced, setDebounced];
}

/** `date-fns` 的 `Locale`（shim 里只作不透明标记，不透出上游实现） */
export type Locale = { readonly code: string };

export const enUS: Locale = { code: "en-US" };
export const zhCN: Locale = { code: "zh-CN" };

/**
 * `date-fns` 的 `formatDistanceToNow`（shim：只做「N 分钟前 / N days ago」这一档粒度）。
 *
 * 覆盖时间组件用到的 `variant="relative"` 场景；`addSuffix` 为 true 时带前后缀。
 */
export function formatDistanceToNow(
  date: Date | number | string,
  options?: { addSuffix?: boolean; locale?: Locale },
): string {
  const target = date instanceof Date ? date : new Date(date);
  const diffMs = Date.now() - target.getTime();
  const zh = (options?.locale?.code ?? "zh-CN").startsWith("zh");
  const past = diffMs >= 0;
  const mins = Math.floor(Math.abs(diffMs) / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  let unit: string;
  if (mins < 1) unit = zh ? "不到 1 分钟" : "less than a minute";
  else if (mins < 60) unit = zh ? `${mins} 分钟` : `${mins} minute${mins === 1 ? "" : "s"}`;
  else if (hours < 24) unit = zh ? `${hours} 小时` : `${hours} hour${hours === 1 ? "" : "s"}`;
  else unit = zh ? `${days} 天` : `${days} day${days === 1 ? "" : "s"}`;

  if (!options?.addSuffix) return unit;
  if (zh) return past ? `${unit}前` : `${unit}后`;
  return past ? `${unit} ago` : `in ${unit}`;
}

// ── 上游「升级弹窗」的空实现 ────────────────────────────────────────────────
// 上游 sidebar 挂了一个商业化升级弹窗（UpgradeDialog），内部部署无意义。
// 按「原文不改」纪律不改页面，而是在这里垫一个不渲染任何东西的同名组件。

export function UpgradeDialog(_props: { open?: boolean; onOpenChange?: (v: boolean) => void }): ReactNode {
  return null;
}

// ── 上游 workspace 包的零散 shim（definePageMeta/useDocumentHead/模型特性表/体积格式化） ──

/** 上游的页面元信息钩子（nuxt 风格）；SPA 里无对应概念 ⇒ no-op */
export function definePageMeta(_meta?: unknown): void {
  /* no-op */
}
export function useDocumentHead(_arg?: unknown): { title: string } {
  return { title: "" };
}

/** 上游的模型特性说明表（对话侧展示用）；本仓如实给空表 + 空描述 */
export const MODEL_FEATURES: string[] = [];
export const MODEL_FEATURE_DESCRIPTIONS: Record<string, string> = {};

/** 上传文件体积 → 可读串（document-table 显示文件大小用） */
export function bytesToReadable(bytes?: number | null): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ── 对话栈的 API 基址与错误提取 ────────────────────────────────────────────
/**
 * 与 admin 的 http/client.ts 同一约定：部署态同源（基址空串）、开发期走 vite 的 /api 代理。
 * 对话流的请求地址由这里拼出（`${base}/api/ai-datasets/:id/chat`）——
 * 服务端同时注册了 `/api/ai-datasets/...` 与 `/ai-datasets/...` 两条路径以兼容两种形态。
 */
export function getApiBaseUrl(): string {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/console") ? "" : "/api";
}

/** 上游的统一错误提取（toast 文案用） */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const anyErr = err as { message?: unknown; error?: { message?: unknown } };
    if (typeof anyErr.message === "string") return anyErr.message;
    if (anyErr.error && typeof anyErr.error.message === "string") return anyErr.error.message;
  }
  return String(err);
}

// ── 助手状态 store（对齐上游 assistant.slice 的两个字段） ──────────────────
// 上游用 zustand + persist（选中的模型 id 记忆到 localStorage）。admin 已依赖 zustand，
// 直接用同一套 API 建，页面侧调用方式（useAssistantStore((s) => s.xxx)）与上游一致。

interface KbAssistantState {
  selectedModelId: string;
  setSelectedModelId: (id: string) => void;
}

export const useAssistantStore = create<KbAssistantState>()(
  persist(
    (set) => ({
      selectedModelId: "",
      setSelectedModelId: (id: string) => set({ selectedModelId: id }),
    }),
    { name: "reactor-kb-assistant" },
  ),
);

// ── 富文本「渲染」垫片（用户拍板：不要富文本编辑器） ────────────────────────
/**
 * 上游 `EditorContentRenderer` 渲染 platejs 的富文本 JSON（知识库欢迎描述用）。
 * 本仓不引入 platejs（依赖山），这里提取 JSON 里的全部文本节点拼成纯文本渲染 ——
 * 观感退化（无排版/颜色），但内容不丢。欢迎描述是唯一的使用场景。
 */
function extractTextFromPlateJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(extractTextFromPlateJson).filter(Boolean).join("");
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["text"] === "string") return obj["text"];
    const children = obj["children"];
    if (Array.isArray(children)) return extractTextFromPlateJson(children);
    return "";
  }
  return "";
}

export function EditorContentRenderer(props: { value?: unknown; className?: string }): ReactNode {
  const text = extractTextFromPlateJson(props.value);
  return <div className={props.className}>{text}</div>;
}

// ── ask-assistant-ui 依赖的其余工具件（均按「用到才实现」的最小面补齐） ──────

/** 上游的全局配置 store（对话侧的展示偏好）；本仓给内存实现 + localStorage 持久化
 *
 * `config.websiteConfig` 是**登录页**要的（站点名/可用登录方式），与对话偏好共用一个 store 是我们这边的
 * 取舍：上游也是同一个 useConfigStore，分家反而会让原文页面读不到。*/
export const useConfigStore = create<{
  showThinking: boolean;
  setShowThinking: (v: boolean) => void;
  config: {
    websiteConfig: {
      name: string;
      /** 上游登录页读的是这两个（webinfo.name / webinfo.logo）；logo 必须非空，否则回落成上游自己的字标 */
      webinfo: { name: string; logo: string };
      loginSettings: {
        allowedLoginMethods: string[];
        allowedRegisterMethods: string[];
        showPolicyAgreement: boolean;
      };
    };
  };
}>()(
  persist(
    (set) => ({
      showThinking: true,
      setShowThinking: (v) => set({ showThinking: v }),
      config: {
        websiteConfig: {
          name: "Reactor 管理控制台",
          // 上游读的是 `webinfo.*`（webinfo.name / webinfo.logo）。
          // ⚠️ logo 不能给空：上游为空时回落到**它自己的字标**（`SvgIcons.buildingaiFull`），
          // 那等于把别人的品牌挂在我们的登录页上。这里喂一张内联 SVG 方块标（我们自己的橙色），
          // 好处是**完全不用改移植来的原文文件**。
          webinfo: {
            name: "Reactor 管理控制台",
            // 上游读 webinfo.logo；空值会回落到 BuildingAI 字标。这里喂 Reactor 立方体简化标
            // （深空底 + 青色立方体，与 public/favicon.svg 同构），不改移植原文。
            logo: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='8' fill='%230B1E45'/%3E%3Cpath d='M16 7 L23 11.5 L16 16 L9 11.5 Z' fill='%237DF0FF'/%3E%3Cpath d='M9 11.5 L16 16 L16 25 L9 20.5 Z' fill='%231A3F7A' stroke='%238FD8F0' stroke-width='0.6'/%3E%3Cpath d='M23 11.5 L16 16 L16 25 L23 20.5 Z' fill='%23245A8E' stroke='%238FD8F0' stroke-width='0.6'/%3E%3C/svg%3E",
          },
          loginSettings: {
            // 只开账号密码：短信/微信入口因此不渲染（页面用 includes 判断）
            allowedLoginMethods: ["account"],
            allowedRegisterMethods: [],
            // 协议勾选先关掉：我们还没有服务协议/隐私政策正文，显示空协议比不显示更糟
            showPolicyAgreement: false,
          },
        },
      },
    }),
    { name: "reactor-kb-config" },
  ),
);

/** 上游设置弹窗开关（mcp-selector 用）；本仓无设置弹窗 ⇒ 打开态恒 false + 空开闭 */
export function useSettingsDialog(): { open: boolean; setOpen: (v: boolean) => void } {
  const [open, setOpen] = useState(false);
  return { open, setOpen };
}

/** 上游图片预览（点开大图）；本仓退化为新窗口打开原图 */
export function useImagePreview(): { preview: { url: string } | null; show: (url: string) => void; close: () => void } {
  const [preview, setPreview] = useState<{ url: string } | null>(null);
  useEffect(() => {
    if (preview === null || typeof window === "undefined") return;
    const w = window.open(preview.url, "_blank", "noopener");
    w?.close?.();
    setPreview(null);
  }, [preview]);
  return { preview, show: (url) => setPreview({ url }), close: () => setPreview(null) };
}
export function ImagePreview(props: { preview: { url: string } | null; onClose: () => void }): ReactNode {
  return props.preview === null ? null : null; // 上游是全屏蒙层；本仓直接新窗口打开，这里不渲染
}

/** 上游的 dayjs 导出与区间判断（会话时间分组用） */
export const format = (d: Date | string | number, fmt = "YYYY-MM-DD"): string => {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return fmt
    .replace("YYYY", p(date.getFullYear(), 4))
    .replace("MM", p(date.getMonth() + 1))
    .replace("DD", p(date.getDate()))
    .replace("HH", p(date.getHours()))
    .replace("mm", p(date.getMinutes()))
    .replace("ss", p(date.getSeconds()));
};
export function isWithinInterval(
  d: Date | string | number,
  interval: { start?: Date | string | number | null; end?: Date | string | number | null },
): boolean {
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return false;
  const lo = interval.start ? new Date(interval.start).getTime() : -Infinity;
  const hi = interval.end ? new Date(interval.end).getTime() : Infinity;
  return t >= lo && t <= hi;
}

/** 上游 utils/storage 的本地存取容错封装 */
export function getLocalStorage(key: string, fallback: unknown = null): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
export function safeJsonStringify(value: unknown, pretty = false): string {
  try {
    return JSON.stringify(value, null, pretty ? 2 : 0);
  } catch {
    return "null";
  }
}

/** 上游 http 层的 HttpError（ask-assistant-ui 的错误分支判断用） */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export * from "./login";
