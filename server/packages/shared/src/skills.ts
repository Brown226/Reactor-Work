/**
 * 技能市场（Skills 商城）契约 —— 服务端 / 桌面端 / 管理台三端共用。
 *
 * 分类用**稳定代码**存库、中文标签只在前端展示：标签会随文案调整，代码不会，
 * 所以筛选条件（URL、SQL）永远用代码，展示层查 `SKILL_CATEGORY_LABELS`。
 *
 * ## 为什么只有 5 类（产品拍板）
 * 首版按 11 类设计，实测 chips 在窄栏里挤成两行、且多数类目长期为空（等于噪音）。
 * 收敛后细分需求靠**搜索 + 标签（tags）**承载 —— 分类负责导航，标签负责粒度。
 * 历史编码由 `SKILL_CATEGORY_ALIASES` 归一（存量数据迁移见服务端 `ensureSkillsSchema`）。
 */

export const SKILL_CATEGORIES = ["office", "dev", "data", "content", "other"] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export const SKILL_CATEGORY_LABELS: Record<SkillCategory, string> = {
  office: "办公协同",
  dev: "开发工具",
  data: "数据分析",
  content: "内容创作",
  other: "其他",
};

export const DEFAULT_SKILL_CATEGORY: SkillCategory = "other";

/**
 * 历史/越界编码 → 现行编码。
 *
 * ①存量数据迁移时归位；②**读路径兜底** —— 库里若残留旧值（别的分支写进去的、
 * 或改分类前的老数据），前端只会显示成「其他」，而不是冒出一个没有标签的空 chip。
 */
export const SKILL_CATEGORY_ALIASES: Record<string, SkillCategory> = {
  finance: "office",
  efficiency: "office",
  business: "office",
  news: "content",
  education: "content",
  life: "other",
};

/**
 * 别名也算合法（旧编码兼容，便于历史脚本/管理台平滑过渡）；未知值返回 `null`，
 * 由调用方决定报错（路由 → 400）还是兜底（读路径 → other）。
 */
export function coerceSkillCategory(raw: unknown): SkillCategory | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if ((SKILL_CATEGORIES as readonly string[]).includes(key)) return key as SkillCategory;
  return SKILL_CATEGORY_ALIASES[key] ?? null;
}

/** 任意输入 → 合法分类（永不抛；未知值归 `other`）。**写入路径必须先过这里**。 */
export function normalizeSkillCategory(raw: unknown): SkillCategory {
  return coerceSkillCategory(raw) ?? DEFAULT_SKILL_CATEGORY;
}

/** 分类白名单校验（服务端与管理台共用，避免两处各写一份） */
export function isSkillCategory(value: unknown): value is SkillCategory {
  return typeof value === "string" && (SKILL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * 分类字典条目（**中间方案**：编码仍由 `SKILL_CATEGORIES` 在编译期固定，
 * 字典只承载「中文名 / 顺序 / 是否启用」）。
 *
 * 为什么不做成完全可自建：编码同时是筛选条件与存值（`skills.category`），
 * 若允许后台新增编码，类型会从字面量联合退化成 string、离线也要有兜底表，
 * 换来的只是"加类目不发版"。当前 5 类且不常变，不值这个价。
 * 真正每天在变的是**文案与顺序**（运营口语、活动期临时置顶）—— 那才是字典要解决的。
 */
export interface SkillCategoryItem {
  /** 稳定编码（编译期常量；永远用它做筛选与存值） */
  code: string;
  /** 展示名（可改，不发版） */
  label: string;
  /** 排序（越小越前，可调） */
  sort: number;
  /** 停用后不再出现在 chips（存量技能的 category 不变，卡片回退显示编码） */
  enabled: boolean;
  /** 当前有多少技能在用（管理台展示，避免"停用了但不知道影响谁"） */
  skillCount?: number;
}

/**
 * 分类字典的**种子**（仅当字典表为空时写入一次）。
 *
 * 种子 = 当前代码内常量 + 数组顺序。为什么不是每次启动都补齐：那样管理员删/停用过的分类
 * 会在重启后复活（与专家侧 `agent_categories` 同款教训）。
 */
export const SKILL_CATEGORY_SEED: Array<Pick<SkillCategoryItem, "code" | "label" | "sort">> = SKILL_CATEGORIES.map(
  (code, index) => ({ code, label: SKILL_CATEGORY_LABELS[code], sort: (index + 1) * 10 }),
);

/**
 * 技能**附属文件**（技能目录里的非 SKILL.md 文件）。
 *
 * ## 为什么需要它
 * 只下发 `SKILL.md` 的技能局限性太窄：真实技能常带脚本/参考资料/模板
 *（例如 Office 三件套带 `scripts/`，`pptx` 甚至有 1MB+ 的 schema 文件）。
 * 只发一个文件等于"说明还在、脚本没了"，技能到了用户机器上跑不起来。
 * 所以按 **Agent Skills 规范**把整个技能目录一起下发。
 *
 * ## 传输策略：清单 + 按需拉取
 * 同步时只拿 `{ path, size, sha256 }` 清单，主进程比对本地后再逐个拉内容 ——
 * 否则每次同步都要把几 MB 的附件全量传一遍（离线/弱网下体验灾难）。
 */
export interface SkillFileMeta {
  /** 相对技能目录的 POSIX 路径（如 `scripts/office/pack.py`；永远不含 `..`） */
  path: string;
  /** 字节数（用于本地比对与上限校验） */
  size: number;
  /** 内容 sha256（hex；本地一致就不重下） */
  sha256: string;
  /** 是否可执行（POSIX 权限位；Windows 上忽略） */
  executable?: boolean;
}

/**
 * 附属文件路径校验（**安全边界，必须单点实现**）。
 *
 * 为什么放 shared 而不是服务端：服务端写入前要校验、桌面端**落盘前也要再校验一次** ——
 * 两边各写一份必然漂移，而这里漂移的代价是"能写到技能目录之外"。
 *
 * 允许：`scripts/pack.py`、`references/a-b_c.md`
 * 拒绝：绝对路径、Windows 盘符、`..` 段、反斜杠（统一 POSIX）、空段、超长、控制字符。
 * 返回规范化后的 POSIX 相对路径；非法返回 null。
 */
export function normalizeSkillFilePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim().replace(/\\/g, "/");
  if (!p || p.length > SKILL_FILE_LIMITS.maxPathChars) return null;
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
  if (/[\u0000-\u001f]/.test(p)) return null;
  const segs = p.split("/").filter((x) => x.length > 0);
  if (segs.length === 0) return null;
  if (segs.some((seg) => seg === "." || seg === "..")) return null;
  // SKILL.md 本体走 skills.content 列，不允许作为附属文件重复出现
  if (segs.length === 1 && segs[0] === "SKILL.md") return null;
  return segs.join("/");
}

/** 拉取单个附属文件（按需） */
export interface SkillFileContent extends SkillFileMeta {
  /** 文本内容（二进制文件用 base64 放在 `contentB64`） */
  content?: string;
  contentB64?: string;
}

/** 技能目录的体积/数量上限（服务端校验 + 管理台上传前置校验共用，避免"传完才报错"） */
export const SKILL_FILE_LIMITS = {
  /** 单个技能最多多少个附属文件 */
  maxFiles: 200,
  /** 单个文件上限（字节）。Office schema 类文件实测 246KB，留一倍余量 */
  maxFileBytes: 512 * 1024,
  /** 单个技能附件总量上限（字节）。pptx/xlsx 含 schema 约 1.2MB，故放到 8MB */
  maxTotalBytes: 8 * 1024 * 1024,
  /** 路径最大长度 */
  maxPathChars: 240,
} as const;

/** 目录/已安装卡片的字段上限（服务端校验 + 客户端截断展示共用同一组常量） */
export const SKILL_LIMITS = {
  tags: 10,
  tagChars: 24,
  iconChars: 8,
  titleChars: 120,
  descChars: 500,
  weight: 100,
} as const;

/** 目录卡片（**不含 content**：列表不下发正文，详情/下发才带） */
export interface SkillCatalogItem {
  id: number;
  name: string;
  title: string;
  description: string | null;
  icon: string | null;
  category: SkillCategory;
  tags: string[];
  author: string | null;
  version: string;
  featured: boolean;
  /** 安装量（skill_installs 计数） */
  hot: number;
  /**
   * 使用量（`skill_usage`：**按会话去重**的调用次数，口径与专家侧 agent_usage 一致）。
   * 「最热」排序以它为主 —— 安装量只能说明"装过"，不代表真的在用。
   */
  uses: number;
  autoInstall: boolean;
  /** frontmatter 声明"不自动调用"（斜杠面板里排序/标注用） */
  disableModelInvocation: boolean;
  updatedAt: string | null;
  /** 当前请求者是否已安装 */
  installed: boolean;
  /** 是否已收藏（账号级、与安装相互独立：收藏只是"先记下"） */
  favorited: boolean;
  /** 解析后的启用态（工作区覆盖 > 全局 > 默认启用） */
  enabled: boolean;
  /** 已安装版本 ≠ 服务端版本 */
  hasUpdate: boolean;
}

export interface SkillCatalogPage {
  items: SkillCatalogItem[];
  total: number;
  page: number;
  pageSize: number;
}

export type SkillSort = "name" | "hot" | "new";

/** 「我安装的」列表项：目录卡片 + 安装时间 */
export interface SkillInstalledItem extends SkillCatalogItem {
  installedAt: string | null;
  /**
   * 是否仍然可用（管理员没有停用）。
   *
   * `false` = 已下架：**文件保留在本地**（不做静默删除，避免用户报障「技能莫名消失」），
   * 但不会注入任何会话（注入集另走 `/me/skills/state`，那里恒过滤 enabled）。
   */
  available: boolean;
}

/** 每技能解析后的状态（替代 pi-web 遗留的死链 `/api/skills`） */
export interface SkillStateEntry {
  name: string;
  enabled: boolean;
  disableModelInvocation: boolean;
}

/**
 * 标签清单项（自由词表）：标签 + 使用它的技能数。
 *
 * 与分类的区别：分类是**受控 5 类白名单**，标签是运营/作者自由填写的词表 ——
 * 所以标签清单只能"统计当前用户可见范围内的真实值"，不能钉死码表。
 */
export interface SkillTagCount {
  tag: string;
  count: number;
}

/** 套件（一等实体）：成员可见性取交集后按"是否全部已安装"给按钮态 */
export interface SkillBundleSummary {
  id: number;
  name: string;
  title: string;
  description: string | null;
  icon: string | null;
  enabled: boolean;
  memberCount: number;
  /** 当前请求者已安装的成员数 */
  installedCount: number;
  /** 成员是否全部已安装 */
  allInstalled: boolean;
}

export interface SkillBundleDetail extends SkillBundleSummary {
  members: SkillCatalogItem[];
}

/** 安装/卸载/批量安装的统一返回（客户端据此刷新本地列表与状态文件） */
export interface SkillMutationResult {
  ok: true;
  /** 本次受影响的技能名（安装=新增的，卸载=移除的） */
  affected: string[];
}

/** 技能详情（详情弹层用）：目录字段 + SKILL.md 正文 + 它能调用的工具 */
export interface SkillDetail {
  skill: SkillCatalogItem;
  content: string;
  allowedTools: string[];
  /**
   * 附属文件清单（多文件技能）。
   * 只给清单（path/size/sha），**内容按需拉** —— 否则详情弹层会把几 MB 传输拖进来。
   */
  files?: SkillFileMeta[];
  /** 附件总字节数（详情里显示"含 N 个文件 / 共 X KB"） */
  filesTotalBytes?: number;
}
