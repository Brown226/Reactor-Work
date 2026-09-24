/**
 * 企业服务端技能市场契约（专家·技能市场 M1）——客户端侧唯一的 payload shape 与 normalize。
 *
 * 事实源：`server/packages/shared/src/skills.ts` 的 `SkillCatalogItem`（`GET /me/skills/catalog`
 * 分页条目、`GET /me/skills/featured` 精选条目、安装/收藏写操作回带的 `skill` 字段同形）。
 * 与专家侧 `server-agents-types.ts` 同纪律：服务端加字段/改缺省必须在这里显式跟随，
 * services 层不再手写第二份 shape（方案见 docs/专家技能市场-方案-v1.md §2/§4/§5.3）。
 *
 * 为什么 catalog 条目要单独一份契约：P2 的 `ReactorServerSkillPayload` 是**落盘集**
 * （含 content/files、不含市场字段），本文件是**市场目录**（含 hot/uses/favorited、不含正文），
 * 两者形状不同源，不能互相兜底。
 */

/** 与服务端 `SKILL_NAME_PATTERN`/`SKILL_NAME_MAX` 同口径：先校验再当目录名（防线 1）。 */
const SERVER_SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SERVER_SKILL_NAME_MAX = 64;

/** 该 name 能否安全物化为 `server-skills/<name>/` 目录。 */
export function isServerSkillNameFileSafe(name: string): boolean {
  return (
    name.length >= 1 && name.length <= SERVER_SKILL_NAME_MAX && SERVER_SKILL_NAME_PATTERN.test(name)
  );
}

/** `GET /me/skills/catalog` / `/featured` 单条条目（关系字段对未安装条目为 false，normalize 统一兜底）。 */
export interface ServerSkillCatalogItem {
  readonly id: number;
  readonly name: string;
  readonly title: string;
  readonly description: string | null;
  /** emoji/icon（服务端 ≤8 字符）；卡片首图，缺省 null 时 UI 用名字首字兜底。 */
  readonly icon: string | null;
  /**
   * 分类编码（服务端受控词表 `office|dev|data|content|other`，字典文案走 `/me/skills/categories`）。
   * 客户端不钉死码表：未知值归 null，UI 显示「其他」而不是空 chip。
   */
  readonly category: string | null;
  readonly tags: readonly string[];
  /** 作者；服务端技能侧暂无独立 `official` 位，官方性以作者字段表达。 */
  readonly author: string | null;
  readonly version: string;
  readonly featured: boolean;
  /** 安装量（skill_installs 计数）。 */
  readonly hot: number;
  /** 使用量（按会话去重的调用次数）；「最热」排序主口径。 */
  readonly uses: number;
  readonly autoInstall: boolean;
  /** frontmatter 声明「不自动调用」（斜杠面板排序/标注用）。 */
  readonly disableModelInvocation: boolean;
  readonly updatedAt: string | null;
  /* 我的关系：安装关系唯一真相在服务端（`skill_installs`） */
  readonly installed: boolean;
  readonly favorited: boolean;
  /** 解析后的启用态（工作区覆盖 > 全局 > 默认启用）。 */
  readonly enabled: boolean;
  /**
   * 是否可安装/可被下发：服务端技能侧**没有**独立 `installEnabled` 位
   * （那是专家侧 `agent_installs.install_enabled` 的概念），此处兜底取 `enabled`——
   * 已停用的技能不再接受新安装；服务端将来若补独立字段，normalize 会优先取它。
   */
  readonly installEnabled: boolean;
  /** 已安装版本 ≠ 服务端版本（有更新可升级）。 */
  readonly hasUpdate: boolean;
  // 示例词类字段（starters/examples/prompts）：服务端 catalog 条目**暂无**（方案 §7-U7 已核对
  // server/packages/shared/src/skills.ts），出现后在此显式跟进，不在客户端伪造。
}

/** `GET /me/skills/catalog` 分页响应（服务端 `SkillCatalogPage`）。 */
export interface ServerSkillCatalogPage {
  readonly items: readonly ServerSkillCatalogItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * `GET /me/skills/catalog` 查询参数（与服务端 `CatalogQuery` 同名对齐；
 * 不传走服务端默认：sort=name、page=1、pageSize=24）。
 * 市场页筛选以客户端过滤为主，这里只透传确有服务端语义的几项。
 */
export interface ServerSkillCatalogQuery {
  readonly q?: string;
  readonly category?: string;
  readonly tag?: string;
  readonly favoritedOnly?: boolean;
  readonly sort?: "name" | "hot" | "new";
  readonly page?: number;
  readonly pageSize?: number;
}

/** `POST /me/skills/:name/install` 返回（对齐服务端 `SkillMutationResult`，另带回写后的目录条目）。 */
export interface ServerSkillInstallResult {
  readonly ok: true;
  readonly affected: readonly string[];
  /** 服务端写后回带的目录条目；聚合字段仍以 re-GET 为准，客户端不本地推算（D3 同款）。 */
  readonly skill: ServerSkillCatalogItem | null;
}

/** `PUT|DELETE /me/skills/:name/favorite` 返回（对齐服务端 `{ok, favorited}`）。 */
export interface ServerSkillFavoriteResult {
  readonly ok: true;
  readonly favorited: boolean;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * 归一化一条 catalog/featured payload；**非法 name 直接丢弃整条**
 * （宁可少一个技能，也不让 UI 拿它当目录名用），旧响应缺字段按 0/false/[]/null 兜底。
 */
export function normalizeServerSkillCatalogItem(raw: unknown): ServerSkillCatalogItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const id = asNumber(item.id);
  const name = asString(item.name)?.trim() ?? "";
  if (!isServerSkillNameFileSafe(name)) return null;
  const title = asString(item.title)?.trim();
  const enabled = asBoolean(item.enabled);
  return {
    id,
    // title 服务端必填；防御旧数据缺失时退回 name，保证 UI 与描述兜底有值。
    title: title && title.length > 0 ? title : name,
    name,
    description: asString(item.description),
    icon: asString(item.icon),
    category: asString(item.category),
    tags: asStringList(item.tags),
    author: asString(item.author),
    version: typeof item.version === "string" ? item.version : "",
    featured: asBoolean(item.featured),
    hot: asNumber(item.hot),
    uses: asNumber(item.uses),
    autoInstall: asBoolean(item.autoInstall),
    disableModelInvocation: asBoolean(item.disableModelInvocation),
    updatedAt: asString(item.updatedAt),
    installed: asBoolean(item.installed),
    favorited: asBoolean(item.favorited),
    enabled,
    // 服务端无独立位时与 enabled 同义（详见字段注释）。
    installEnabled: typeof item.installEnabled === "boolean" ? item.installEnabled : enabled,
    hasUpdate: asBoolean(item.hasUpdate),
  };
}

/**
 * 解析目录类响应：兼容 `{items:[...]}`（catalog/featured/installed）、`{skills:[...]}`（兼容面）
 * 与裸数组三种载荷；形状不对时返回空集而不是抛错，按 name 去重、丢非法 name。
 */
export function normalizeServerSkillCatalogList(payload: unknown): ServerSkillCatalogItem[] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null
      ? (() => {
          const record = payload as { items?: unknown; skills?: unknown };
          if (Array.isArray(record.items)) return record.items;
          if (Array.isArray(record.skills)) return record.skills;
          return [];
        })()
      : [];
  const result: ServerSkillCatalogItem[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const item = normalizeServerSkillCatalogItem(raw);
    if (!item || seen.has(item.name)) continue;
    seen.add(item.name);
    result.push(item);
  }
  return result;
}

/** 解析 `GET /me/skills/catalog` 分页响应（分页元数据缺省按服务端默认值兜底）。 */
export function normalizeServerSkillCatalogPage(payload: unknown): ServerSkillCatalogPage {
  const record = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const items = normalizeServerSkillCatalogList(payload);
  return {
    items,
    total: asNumber(record.total) || items.length,
    page: asNumber(record.page) || 1,
    pageSize: asNumber(record.pageSize) || items.length,
  };
}
