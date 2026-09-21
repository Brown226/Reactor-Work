/**
 * Skills 渐进式披露 4 层 + 打包预算（W5-④）—— **纯函数层**。
 *
 * 设计来源：LeAgent `skills/{manager,bundle_payload,discovery}.py`（Apache-2.0）。
 * 常量与算法逐项照抄（它们是产品语义）；只把「算」与「读盘」分开：本模块**不碰 IO**，
 * 字节由调用方读好后传进来（这样能在浏览器/探针里直接测，也便于我们只读**有界**的量）。
 *
 * ## 四层（L1 常驻，L2–L4 按需）
 *
 * | 层 | 内容 | 进入上下文的方式 | 规模 |
 * |---|---|---|---|
 * | **L1 广告** | `name + description + version + hasResources/hasScripts` | **进 system prompt（常驻）** | 必须**有预算** |
 * | **L2 正文** | SKILL.md body | 按需取（工具调用） | 有界 |
 * | **L3 资源** | `references/` 等文本 | 按需取 | 单文件有界 |
 * | **L4 脚本** | `scripts/` 源码 | 按需取 / 执行 | 单文件有界 |
 *
 * ## 两个预算，解决两个不同的问题
 *
 * ① **L1 广告预算**（`planAdvertisement`）—— 「技能多了上下文爆炸」的**主因**：
 *    L1 是**常驻**前缀，技能越多它线性增长。LeAgent 只把 L1 做成 name+description，
 *    但**没有对 L1 本身设预算**；这里补上：超预算先砍 description，再截断列表并报数。
 *    （注：Pi 内核已提供 `formatSkillsForPrompt`，但它同样无预算 —— 所以这层是我们加的。）
 *
 * ② **L2 打包预算**（`buildSkillBundle`）—— 照 LeAgent 的关键洞察：
 *    **body 必须先截断以给附件留空间**，否则一个超长 SKILL.md 会把 resources/scripts
 *    挤到零，模型永远看不到它们（而它们往往才是真正要用的东西）。
 */

// ---------------------------------------------------------------------------
// 常量（照 LeAgent `bundle_payload.py`）
// ---------------------------------------------------------------------------

/** 整个 bundle 的字符预算 */
export const SKILL_BUNDLE_TOTAL_CHARS = 200_000;
/** 为附件预留的比例 */
export const SKILL_BUNDLE_RESERVE_FRACTION = 0.45;
/** 预留上限 */
export const SKILL_BUNDLE_RESERVE_CAP_CHARS = 90_000;
/** bundle 预算下限（照 LeAgent `max(1024, …)`） */
export const SKILL_BUNDLE_MIN_TOTAL_CHARS = 1_024;
/** 单文件字符上限 */
export const SKILL_PER_FILE_MAX_CHARS = 50_000;
/** body 至少留这么多（照 LeAgent `max(512, …)`） */
export const SKILL_MIN_BODY_CAP_CHARS = 512;
/** 可以内联源码的脚本文本扩展名（照 LeAgent；其余只给 hint 让模型走 L4 执行） */
export const SKILL_TEXT_SCRIPT_EXTENSIONS: readonly string[] = [".py", ".js", ".sh", ".ps1", ".cs", ".csx"];

/** 技能名校验（照 LeAgent：小写字母数字 + 单连字符分段，且必须等于目录名） */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 换行（单独常量：本文件多处拼接 JSON/XML，避免在模板字符串里写转义导致可读性差） */
const NL = "\n";

/** L1 广告的默认字符预算（**我们的补充**） */
export const SKILL_ADVERTISEMENT_DEFAULT_BUDGET_CHARS = 8_000;
/** 砍 description 时的最短保留长度；低于它就干脆退成 name-only */
export const SKILL_DESCRIPTION_MIN_CHARS = 40;

// ---------------------------------------------------------------------------
// L1：广告
// ---------------------------------------------------------------------------

/** 一个技能的 L1 广告字段（照 LeAgent `get_active_advertisement`） */
export interface SkillAdvertisement {
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly hasResources?: boolean;
  readonly hasScripts?: boolean;
}

/** description 的处理档位 */
export type DescriptionMode = "full" | "truncated" | "dropped";

export interface AdvertisementPlan {
  /** 按预算裁决后的技能与 description 档位 */
  readonly entries: readonly { readonly skill: SkillAdvertisement; readonly mode: DescriptionMode }[];
  /** 因预算被整体省略的技能名 */
  readonly omitted: readonly string[];
  readonly budgetChars: number;
  readonly usedChars: number;
  /** 渲染好的文本（≤ budgetChars） */
  readonly text: string;
  readonly notes: readonly string[];
}

/**
 * 单个技能的广告行。
 *
 * 用 XML 风格（与 Pi / Agent Skills 标准一致），并把 `has_resources` / `has_scripts`
 * 作为**属性**给出 —— 模型据此知道有没有 L3/L4 可拿，而不必先试探。
 */
export function formatAdvertisementLine(skill: SkillAdvertisement, description: string): string {
  const attrs = [
    `name="${escapeAttr(skill.name)}"`,
    ...(skill.version !== undefined && skill.version !== "" ? [`version="${escapeAttr(skill.version)}"`] : []),
    ...(skill.hasResources === true ? ['has-resources="true"'] : []),
    ...(skill.hasScripts === true ? ['has-scripts="true"'] : []),
  ].join(" ");
  const desc = description.trim();
  return desc === "" ? `<skill ${attrs} />` : `<skill ${attrs}>${escapeText(desc)}</skill>`;
}

/**
 * 规划 L1 广告（**预算化**）。
 *
 * 降级顺序（每一步都只在还超预算时才做）：
 *  1. 保留全部技能的 `name`（**绝不丢名字** —— 名字是 `/skill:<name>` 的入口，丢了技能就不可达）；
 *  2. 逐步等比例截断 description（只保留较短描述）；
 *  3. 仍超预算 → 丢 description（退成 name-only 空元素）；
 *  4. 仍超预算 → 按**输入顺序**截断技能列表并在 `omitted` 里报出被省略的名字。
 *
 * 为什么按输入顺序而不是按「重要性」截断：调用方（`skillsOverride`）拿到的顺序已由
 * Pi 的发现优先级决定（project 覆盖 builtin），我们不再引入第二套排序依据，
 * 否则「哪些技能可见」会变得难以解释。
 */
export function planAdvertisement(
  skills: readonly SkillAdvertisement[],
  options: { budgetChars?: number; minDescriptionChars?: number } = {},
): AdvertisementPlan {
  const budget = Math.max(0, options.budgetChars ?? SKILL_ADVERTISEMENT_DEFAULT_BUDGET_CHARS);
  const minDesc = Math.max(0, options.minDescriptionChars ?? SKILL_DESCRIPTION_MIN_CHARS);
  const notes: string[] = [];

  /**
   * 渲染并**含包裹**。
   *
   * ⚠️ 必须把 `<available_skills>` 包裹算进来：修前这里返回裸文本、预算检查按裸文本量，
   * 而返回值又套了包裹 → 每次判定都少算约 21 字符，于是「在预算内」的断言实际**超预算**
   * （实测 400 的预算返回 403）。预算判定与最终渲染一旦分家就会这样悄悄错位。
   */
  const render = (entries: readonly { skill: SkillAdvertisement; mode: DescriptionMode }[], cap: number): string => {
    const rows: string[] = [];
    for (const { skill, mode } of entries) {
      const desc =
        mode === "dropped"
          ? ""
          : mode === "full"
            ? skill.description
            : skill.description.slice(0, cap);
      rows.push(`  ${formatAdvertisementLine(skill, desc)}`);
    }
    return wrap(rows.join(NL));
  };

  // 先试全量 + 完整 description
  const all = skills.map((skill) => ({ skill, mode: "full" as DescriptionMode }));
  let text = render(all, Number.MAX_SAFE_INTEGER);
  if (text.length <= budget) {
    return { entries: all, omitted: [], budgetChars: budget, usedChars: text.length, text, notes };
  }

  // ② 逐步收缩 description 上限（二分不成，用比例逼近后线性收敛）
  const maxDescLen = Math.max(0, ...skills.map((s) => s.description.length));
  let cap = Math.max(minDesc, Math.floor(maxDescLen / 2));
  while (cap >= minDesc) {
    const entries = skills.map((skill) => ({
      skill,
      mode: (skill.description.length <= cap ? "full" : "truncated") as DescriptionMode,
    }));
    text = render(entries, cap);
    if (text.length <= budget) {
      notes.push(`description 截断到 ${cap} 字符以适配 L1 预算 ${budget}。`);
      return { entries, omitted: [], budgetChars: budget, usedChars: text.length, text, notes };
    }
    if (cap === minDesc) break;
    cap = Math.max(minDesc, Math.floor(cap / 2));
  }

  // ③ 丢掉全部 description（只留 name —— 名字必须保住）
  const nameOnly = skills.map((skill) => ({ skill, mode: "dropped" as DescriptionMode }));
  text = render(nameOnly, 0);
  if (text.length <= budget) {
    notes.push(`L1 预算 ${budget} 不足，已丢弃全部 description 仅保留技能名。`);
    return { entries: nameOnly, omitted: [], budgetChars: budget, usedChars: text.length, text, notes };
  }

  // ④ 仍超预算 → 截断列表
  const kept: { skill: SkillAdvertisement; mode: DescriptionMode }[] = [];
  const omitted: string[] = [];
  for (const entry of nameOnly) {
    const candidate = render([...kept, entry], 0);
    if (candidate.length > budget && kept.length > 0) {
      omitted.push(entry.skill.name);
      continue;
    }
    kept.push(entry);
  }
  text = render(kept, 0);
  notes.push(
    `L1 预算 ${budget} 过小：仅保留 ${kept.length}/${skills.length} 个技能名，省略 ${omitted.length} 个。`,
  );
  return { entries: kept, omitted, budgetChars: budget, usedChars: text.length, text, notes };
}

/** 包一层 `<available_skills>`（与 Pi / Agent Skills 标准的呈现一致） */
function wrap(inner: string): string {
  return inner === "" ? "" : `<available_skills>\n${inner}\n</available_skills>`;
}

/**
 * 只按预算**截断 description**，返回可交给 Pi 的 Skill 形态（名字与其余字段原样保留）。
 *
 * 这是把 L1 预算接进 Pi 的落点：Pi 用 `skillsOverride` 让我们改 `skills` 数组，
 * 而它自己用 `formatSkillsForPrompt(skills)` 渲染 —— 所以我们**缩短 description**
 * 就能收窄常驻前缀，同时保住 `name`（`/skill:<name>` 入口不丢）。
 * 不返回 `entries`/`text`（那是给自渲染用的），只返回改过的技能列表。
 */
export function budgetSkillDescriptions<T extends SkillAdvertisement>(
  skills: readonly T[],
  options: { budgetChars?: number; minDescriptionChars?: number } = {},
): { skills: T[]; plan: AdvertisementPlan } {
  const plan = planAdvertisement(skills, options);
  const modeOf = new Map(plan.entries.map((e) => [e.skill.name, e.mode]));
  const omitted = new Set(plan.omitted);
  const cap = extractCap(plan) ?? 0;
  const out: T[] = [];
  for (const skill of skills) {
    if (omitted.has(skill.name)) continue;
    const mode = modeOf.get(skill.name) ?? "dropped";
    if (mode === "full") out.push(skill);
    else if (mode === "dropped") out.push({ ...skill, description: "" });
    else out.push({ ...skill, description: skill.description.slice(0, cap) });
  }
  return { skills: out, plan };
}

/** 从 notes 里回收实际使用的 description 上限（避免把 cap 再算一遍导致两处口径） */
function extractCap(plan: AdvertisementPlan): number | null {
  for (const note of plan.notes) {
    const m = /description 截断到 (\d+) 字符/.exec(note);
    if (m) return Number(m[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// L2：打包预算
// ---------------------------------------------------------------------------

/** 一个候选文件（字节由调用方按有界量读好） */
export interface BundleFileCandidate {
  /** 相对技能根的路径（用于输出与排序） */
  readonly path: string;
  /** 文件真实字节数（用于统计 bytesOmitted） */
  readonly size: number;
  /** 已读出的字节；读失败/超限截断由调用方负责，`null` = 读不到 */
  readonly bytes: Uint8Array | null;
}

export interface BundleFileEntry {
  readonly path: string;
  readonly content: string | null;
  readonly truncated?: boolean;
  /** 未内联的原因（二进制 / 扩展名不支持 / 读失败） */
  readonly omitted?: string;
  /** 给模型的下一步指引（**照 LeAgent：不内联就告诉它怎么拿**） */
  readonly hint?: string;
  readonly size?: number;
  readonly kind?: string;
}

export interface SkillBundleResult {
  /**
   * 组装好的载荷（body + 结构化 bundle 元数据），**序列化后**总长 ≤ maxTotal。
   *
   * ⚠️ 与 LeAgent 的一处差异（刻意）：LeAgent 的 `max_total_chars` 只约束 `content`
   * （SKILL.md 正文 + 内联附件文本），bundle 元数据作为**独立的 dict** 返回，不计入预算。
   * 我们把它序列化成**一个字符串**（便于直接当工具结果返回），因此把 JSON 信封
   * 也计入预算 —— 这是**更严**的保证：调用方拿到的字符串一定不超上限。
   * 代价是同样预算下可容纳的正文略少（信封约百余字符）。
   */
  readonly content: string;
  readonly bundle: {
    readonly bundledResources: readonly BundleFileEntry[];
    readonly bundledScripts: readonly BundleFileEntry[];
    readonly truncationNotes: readonly string[];
    readonly bytesOmitted: number;
  };
  /** body 实际保留长度（供审计：是否被压缩换预算） */
  readonly bodyChars: number;
  readonly totalChars: number;
}

/**
 * 为附件预留的字符数（照 LeAgent `_reserved_chars_for_bundle`）：
 * `min(maxTotal*0.45, 90000, maxTotal-512)`。
 */
export function reservedCharsForBundle(maxTotal: number): number {
  return Math.min(
    Math.floor(maxTotal * SKILL_BUNDLE_RESERVE_FRACTION),
    SKILL_BUNDLE_RESERVE_CAP_CHARS,
    maxTotal - SKILL_MIN_BODY_CAP_CHARS,
  );
}

/**
 * 需要内联附件时的 body 上限（照 LeAgent `max(512, maxTotal - reserved)`）。
 *
 * 这条就是「超长 SKILL.md 不会把附件挤到零」的保证。
 */
export function bundledBodyCap(maxTotal: number): number {
  return Math.max(SKILL_MIN_BODY_CAP_CHARS, maxTotal - reservedCharsForBundle(maxTotal));
}

export interface BuildSkillBundleInput {
  readonly skillBody: string;
  readonly resources?: readonly BundleFileCandidate[];
  readonly scripts?: readonly BundleFileCandidate[];
  readonly resourceKinds?: Readonly<Record<string, string>>;
}

export interface BuildSkillBundleOptions {
  readonly maxTotalChars?: number;
  readonly includeResources?: boolean;
  readonly includeScripts?: boolean;
  readonly maxPerFileChars?: number;
}

/**
 * 组装 L2 打包载荷（照 LeAgent `build_bundle_payload`）。
 *
 * 分配顺序即语义：
 *  1. 先决定 body 上限 —— **要内联附件时 body 先让路**（预留 `reserved`）；
 *  2. 剩余预算按**路径升序**给 resources，再给 scripts（确定性：同输入必同输出）；
 *  3. 二进制 / 非 UTF-8 / 扩展名不支持 → **不内联**，给出 `hint` 指向 L3/L4；
 *  4. 预算耗尽 → 停止并写 `truncationNotes`（**明确告知被略过了什么**，而不是静默变短）。
 */
export function buildSkillBundle(
  input: BuildSkillBundleInput,
  options: BuildSkillBundleOptions = {},
): SkillBundleResult {
  const maxTotal = Math.max(SKILL_BUNDLE_MIN_TOTAL_CHARS, Math.floor(options.maxTotalChars ?? SKILL_BUNDLE_TOTAL_CHARS));
  const includeResources = options.includeResources ?? false;
  const includeScripts = options.includeScripts ?? false;
  const maxPerFile = Math.max(1, Math.floor(options.maxPerFileChars ?? SKILL_PER_FILE_MAX_CHARS));

  const notes: string[] = [];
  let bytesOmitted = 0;

  const body = input.skillBody ?? "";
  const inlineBundle = includeResources || includeScripts;
  let bodyOut: string;
  if (inlineBundle) {
    const cap = bundledBodyCap(maxTotal);
    if (body.length > cap) {
      bodyOut = body.slice(0, cap);
      notes.push(
        `SKILL.md body 截断到 ${cap} 字符，为附件预留约 ${reservedCharsForBundle(maxTotal)} 字符预算。`,
      );
    } else {
      bodyOut = body;
    }
  } else {
    if (body.length > maxTotal) {
      bodyOut = body.slice(0, maxTotal);
      notes.push(`SKILL.md body 截断到 ${maxTotal} 字符（max_total_chars 上限）。`);
    } else {
      bodyOut = body;
    }
  }

  let remaining = maxTotal - bodyOut.length;
  const bundledResources: BundleFileEntry[] = [];
  const bundledScripts: BundleFileEntry[] = [];

  const takeFiles = (
    files: readonly BundleFileCandidate[],
    target: BundleFileEntry[],
    kind: "resource" | "script",
  ): void => {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    for (const file of sorted) {
      const kindLabel = kind === "resource" ? (input.resourceKinds?.[file.path] ?? "resource") : "script";
      if (remaining <= 0) {
        notes.push(
          `预算耗尽，自 '${file.path}' 起的其余${kind === "resource" ? "资源" : "脚本"}未内联；` +
            `请改用 ${kind === "resource" ? "read_skill_resource" : "run_skill_script"}。`,
        );
        break;
      }

      if (kind === "script") {
        const ext = extensionOf(file.path);
        if (!SKILL_TEXT_SCRIPT_EXTENSIONS.includes(ext)) {
          target.push({
            path: file.path,
            content: null,
            omitted: "unsupported_extension",
            hint: "该扩展名不内联源码；请用 run_skill_script 执行。",
          });
          continue;
        }
      }

      const decoded = decodeUtf8(file.bytes);
      if (decoded === null) {
        bytesOmitted += Math.max(0, file.size);
        target.push({
          path: file.path,
          content: null,
          omitted: file.bytes === null ? "read_error" : "binary",
          size: file.size,
          hint: "非 UTF-8 或二进制，未内联；请用 read_skill_resource 取完整内容。",
          ...(kind === "resource" ? { kind: kindLabel } : {}),
        });
        continue;
      }

      const cap = Math.min(decoded.length, remaining, maxPerFile);
      const slice = decoded.slice(0, cap);
      target.push({
        path: file.path,
        content: slice,
        ...(decoded.length > cap ? { truncated: true } : {}),
        ...(kind === "resource" ? { kind: kindLabel, size: file.size } : {}),
      });
      remaining -= slice.length;
      if (decoded.length > cap) {
        notes.push(`'${file.path}' 已截断以适配 bundle 预算。`);
      }
    }
  };

  if (includeResources) takeFiles(input.resources ?? [], bundledResources, "resource");
  if (includeScripts) takeFiles(input.scripts ?? [], bundledScripts, "script");

  const bundle = { bundledResources, bundledScripts, truncationNotes: notes, bytesOmitted };
  const serialize = (body: string, withBundleNotes: boolean): string =>
    JSON.stringify(
      {
        skill_md: body,
        ...(bundledResources.length > 0 ? { bundled_resources: bundledResources } : {}),
        ...(bundledScripts.length > 0 ? { bundled_scripts: bundledScripts } : {}),
        ...(withBundleNotes && notes.length > 0 ? { truncation_notes: notes } : {}),
      },
      null,
      1,
    );

  /**
   * 迭代收窄 body 直到载荷真的装进预算。
   *
   * 为什么不能「算一次超出量、一次裁掉」：JSON 转义（引号/换行/反斜杠）让「字符数」
   * 与「预算」不是线性关系，一次算式在含转义的内容上不收敛（实测 1100 的预算产出 1146）。
   * 改为循环逼近，直到装下或 body 归零 —— **不超预算是硬约束**。
   */
  let payload = serialize(bodyOut, true);
  let narrowed = false;
  for (let guard = 0; payload.length > maxTotal && bodyOut.length > 0 && guard < 64; guard++) {
    const over = payload.length - maxTotal;
    const nextLen = Math.max(0, bodyOut.length - Math.max(1, over));
    if (nextLen === bodyOut.length) break;
    bodyOut = bodyOut.slice(0, nextLen);
    if (!narrowed) {
      notes.push("为容纳 JSON 结构开销，body 再次收窄（bundle 总长不超过预算）。");
      narrowed = true;
    }
    payload = serialize(bodyOut, true);
  }
  // 极端情况：body 归零仍装不下（附件本身过大）→ 退化为最小载荷
  if (payload.length > maxTotal) {
    payload = JSON.stringify({ skill_md: bodyOut.slice(0, Math.max(0, maxTotal - 40)) });
  }

  return {
    content: payload,
    bundle: { ...bundle, truncationNotes: notes },
    bodyChars: bodyOut.length,
    totalChars: payload.length,
  };
}

// ---------------------------------------------------------------------------
// 校验（照 LeAgent）
// ---------------------------------------------------------------------------

export interface SkillManifestFinding {
  readonly code: string;
  readonly message: string;
}

/**
 * 校验技能清单（照 LeAgent）：
 *  - `name` 必须匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`；
 *  - `name` 必须**等于目录名**（否则发现逻辑会重名覆盖，且 `/skill:<name>` 指向不明）；
 *  - `description` 不得含 XML 标签（它会进 system prompt 的 XML）。
 */
export function validateSkillManifest(input: {
  name: string;
  dirName?: string;
  description?: string;
}): SkillManifestFinding[] {
  const findings: SkillManifestFinding[] = [];
  const name = input.name ?? "";
  if (!SKILL_NAME_PATTERN.test(name)) {
    findings.push({
      code: "skill.name_invalid",
      message: `技能名「${name}」不符合 ^[a-z0-9]+(-[a-z0-9]+)*$（小写字母数字，用单连字符分段）。`,
    });
  }
  if (input.dirName !== undefined && input.dirName !== name) {
    findings.push({
      code: "skill.name_dir_mismatch",
      message: `技能名「${name}」与目录名「${input.dirName}」不一致 —— 必须一致，否则同名技能会互相覆盖。`,
    });
  }
  const desc = input.description ?? "";
  // 收紧为「像标签」的形态：`<` 后紧跟字母或 `/`；否则 `a < b 且 c > d` 这类正常文本会被误判。
  if (/<[/]?[a-zA-Z][^>]*>/.test(desc)) {
    findings.push({
      code: "skill.description_has_xml",
      message: "description 含 XML 标签；它会进 system prompt 的 XML，必须去掉标签。",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 发现优先级（照 LeAgent `discovery.py`）
// ---------------------------------------------------------------------------

export type SkillDiscoveryScope = "project" | "user" | "builtin";

/**
 * 发现优先级（**小者胜**，照 LeAgent `DiscoveryRoot.priority`）：
 * project/leagent=0 → project/其他=1 → user/leagent=2 → user/其他=3 → builtin=4。
 *
 * 语义：**自己的技能优先于别家厂商同名的技能**，项目级优先于用户级。
 * 这里只提供纯函数；**是否去读 `.claude/skills` 等互操作目录是产品决策**，
 * 默认不启用（避免把不可信来源的技能自动装进来）。
 */
export function discoveryPriority(scope: SkillDiscoveryScope, origin: string): number {
  if (scope === "project") return origin === "leagent" ? 0 : 1;
  if (scope === "user") return origin === "leagent" ? 2 : 3;
  return 4;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 用 fatal 模式解码 UTF-8：非 UTF-8（二进制）返回 null —— 照 LeAgent 的 UnicodeDecodeError 分支 */
function decodeUtf8(bytes: Uint8Array | null): string | null {
  if (bytes === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function extensionOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx < 0 ? "" : path.slice(idx).toLowerCase();
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
