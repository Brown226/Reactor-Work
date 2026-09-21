/**
 * BuildingAI 管理端移植脚本（BuildingAI-26.1.2 → packages/admin/src/kb-port）
 *
 * 依据：`docs/实施计划/知识库前端-移植清单-v1.md`（KB）与
 * `docs/实施计划/管理端BuildingAI移植-台账-v1.md`（其余页面）；Apache-2.0，保留出处注释 + 台账。
 *
 * 做三件事：
 *   1. 从**全部要搬的页面族**（collectClosure 的 seeds）出发解析 **import 闭包**，只取
 *      `@buildingai/ui` 里真正用到的子集（裁掉 `components/editor` 富文本等 —— 逐批拍板）；
 *   2. 按相对结构复制 ui 子集进 `admin/src/kb-port/ui/**`，页面进 `kb-port/pages|components/**`，
 *      把 `@/x` 与 `@buildingai/ui/x` **改写为相对路径**（上游 `@/` 别名根就是 ui/src）；
 *   3. 单独搬 design token（`ui/src/styles/theme.css` → `kb-port/theme/`），
 *      交由调用方用**容器作用域**引入（不污染 admin 其它页面）。
 *
 * ⚠️ 不搬的 `@buildingai/*`（services/stores/hooks/utils/constants/i18n）在复制的文件里
 * **仍然引用着** —— 脚本会把这类文件加 `@ts-nocheck` 并在文件头写明"待接线"，
 * 这是**中间态**；取数层由手写的 `kb-shims/console-services.tsx`（+ data/ui）承接。
 *
 * 坑：Windows 下 relpath 带反斜杠 ⇒ 所有前缀判断/输出路径先归一为 `/`（本轮已因此算错过一次）。
 * 用法：`node packages/admin/scripts/port-kb-ui.mjs`
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SRC_UI = join(ROOT, "开源项目/BuildingAI-26.1.2/packages/@buildingai/web/ui/src");
const SRC_CLIENT = join(ROOT, "开源项目/BuildingAI-26.1.2/packages/client/src");
const OUT = join(ROOT, "packages/admin/src/kb-port");
/** 作用域类名：知识库模块的根节点用它，token 只在此子树内生效 */
const KB_SCOPE_CLASS = "reactor-kb-scope";
const BASELINE = "BuildingAI-26.1.2";

/** 用户拍板裁掉的两块（富文本编辑器 / AI 对话元素） */
const SKIP = ["components/editor/"]; // ai-elements 已于「都搬」批解除（对话栈的 prompt-input/message/tool 需要）
/**
 * 额外剪枝（实施时发现）：
 *  - `layouts/styles/**` 是 **console 外壳**（含「升级弹窗」），清单 §2 已定「外壳不搬」；
 *  - 下面三个组件在闭包里**无人引用**（被上游 barrel 带进来），且各自需要一个未安装的 npm 包
 *    （embla-carousel-react / cmdk / react-resizable-panels）⇒ 为三个用不到的组件装三个依赖不值。
 */
const PRUNE = [
  "layouts/styles/", // console 外壳不搬；但 upgrade-dialog 例外 —— 由 kb-shims 垫成空实现
  // carousel/command 曾被剪（当时无引用且不想装 embla/cmdk）；「都搬」批解除：
  // ai-elements 的 inline-citation 引 carousel、prompt-input/model-selector 引 command。
];
const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx", ".css"];

/**
 * 区块级适配（dashboard）：上游「订单统计」卡是 ToC 概念，用户拍板移除，原位换成
 * 「客户端使用」卡（活跃人数，数据来自 usage/summary 的 user 维度，见
 * kb-shims/console-services.ts 的 usage 段与 DashboardData 注释）。
 *
 * ⚠️ 必须做成**脚本变换**而不是手改生成物 —— 本脚本幂等全量重生成，手改会被下次重跑覆盖。
 * 匹配方式：定位 `title="订单统计"` → 向前找最近的 `<DataCard`、向后找最近的 `</DataCard>`，
 * 整块替换（DataCard 不嵌套，结构稳定；上游快照冻结 ⇒ 文本可依赖）。找不到就**抛错**，
 * 不静默跳过 —— 上游源变了必须有人来同步这条变换。
 */
const CLIENT_USAGE_CARD = [
  '          <DataCard',
  '            title="客户端使用"',
  '            description="活跃人数（按模型调用去重）"',
  '            contentClassName="flex flex-col gap-1 px-4 md:gap-2"',
  '            action={',
  '              <div className="flex flex-col items-center justify-center">',
  '                {isLoading ? (',
  '                  <Skeleton className="h-16 w-20" />',
  '                ) : (',
  '                  <>',
  '                    {(data?.usage.changePct ?? 0) >= 0 ? (',
  '                      <TrendingUp className="size-8 text-green-600" />',
  '                    ) : (',
  '                      <TrendingDown className="text-destructive size-8" />',
  '                    )}',
  '                    <div className="text-muted-foreground text-xs">',
  '                      活跃较昨日',
  '                      {(data?.usage.changePct ?? 0) >= 0 ? "增长" : "下降"}',
  '                      <span',
  '                        className={`mx-1 text-lg font-bold ${(data?.usage.changePct ?? 0) >= 0 ? "text-green-600" : "text-destructive"}`}',
  '                      >',
  '                        {Math.abs(data?.usage.changePct ?? 0).toFixed(1)}%',
  '                      </span>',
  '                    </div>',
  '                  </>',
  '                )}',
  '              </div>',
  '            }',
  '          >',
  '            {isLoading ? (',
  '              <>',
  '                <Skeleton className="h-6 w-full" />',
  '                <Skeleton className="h-6 w-full" />',
  '                <Skeleton className="h-6 w-full" />',
  '              </>',
  '            ) : (',
  '              <>',
  '                <div className="flex items-center justify-between">',
  '                  <span className="text-sm">今日活跃</span>',
  '                  <span className="text-primary text-xl font-bold">',
  '                    <CountUp direction="up" duration={0.05} to={data?.usage.activeToday ?? 0} />',
  '                  </span>',
  '                </div>',
  '                <div className="flex items-center justify-between">',
  '                  <span className="text-sm">近7日活跃</span>',
  '                  <span className="text-primary text-xl font-bold">',
  '                    <CountUp direction="up" duration={0.05} to={data?.usage.active7d ?? 0} />',
  '                  </span>',
  '                </div>',
  '                <div className="flex items-center justify-between">',
  '                  <span className="text-sm">平台用户</span>',
  '                  <span className="text-primary text-xl font-bold">',
  '                    <CountUp direction="up" duration={0.05} to={data?.user.totalUsers ?? 0} />',
  '                  </span>',
  '                </div>',
  '              </>',
  '            )}',
  '          </DataCard>',
].join("\n");

const norm = (p) => p.split(sep).join("/");
const lines = (f) => readFileSync(f, "utf8").split("\n").length;

/** 手写适配层（取数层 + UI shim）——**不在 kb-port 内**，故不受重生成影响 */
const SHIMS = join(ROOT, "packages/admin/src/kb-shims");

/**
 * 把「上游才有的说明符」改指到本仓实现；返回 null = 本函数不处理（原样保留）。
 *
 * 分三类：
 *  ① 已搬的常量表 → 本地副本 `kb-port/constants/`；
 *  ② 页内互引（上游 `@/pages/console/ai/datasets/**`）→ 对应的生成物路径；
 *  ③ 取数层与零碎件 → `kb-shims/data`（`@buildingai/services/*`）或 `kb-shims/ui`（其余）。
 *
 * ⚠️ 三类都不是「改写就能了事」的机械变换，而是「指向本仓自己写的那一层」——
 * 所以改指过的文件仍加 `@ts-nocheck`（shim 的类型是宽松的，暂不参与类型检查）。
 */
function rewriteExternal(spec, destFile) {
  if (spec === "@buildingai/constants/shared/datasets.constants") {
    return relTo(destFile, join(OUT, "constants/datasets.constants"));
  }
  // 登录页需要（整台换皮第 1 步）：同为「原文照搬的常量表」，所以照 datasets.constants 的写法办。
  // 为什么单独列：不列它就会以上游包名留在产物里 ⇒ 运行期解析不到（tsc 因 @ts-nocheck 看不出来）。
  if (spec === "@buildingai/constants/shared/auth") {
    return relTo(destFile, join(OUT, "constants/auth.constants"));
  }
  if (spec === "@buildingai/constants/shared/sms.constant") {
    return relTo(destFile, join(OUT, "constants/sms.constant"));
  }
  if (spec.startsWith("@/pages/console/ai/datasets/")) {
    return relTo(destFile, join(OUT, "pages/console/ai/datasets", spec.slice("@/pages/console/ai/datasets/".length)));
  }
  // 取数层统一改指到 **console-services barrel**（KB 的 data.tsx 经 `export *` 透出，
  // dashboard/secret 的映射段也住在里面）。为什么要 barrel 而不是按页面分文件：
  // 上游所有页面 import 的是**同一个** `@buildingai/services/console` 说明符，改指时
  // 无法按来源页面区分 —— 只能让 barrel 自己按导出名聚合。
  if (spec.startsWith("@buildingai/services/")) return relTo(destFile, join(SHIMS, "console-services"));
  if (spec === "@buildingai/constants" || spec.startsWith("@buildingai/constants/shared/status-codes")) {
    return relTo(destFile, join(SHIMS, "ui"));
  }
  if (spec === "@buildingai/i18n" || spec === "@buildingai/stores") return relTo(destFile, join(SHIMS, "ui"));
  // 对话组件库整棵搬 ⇒ 指回生成物（必须在通用 @/components 兜底之前）
  if (spec === "@/components/ask-assistant-ui") {
    return relTo(destFile, join(OUT, "ask-assistant-ui", "index")); // barrel 形式（无子路径）
  }
  if (spec.startsWith("@/components/ask-assistant-ui/")) {
    return relTo(destFile, join(OUT, "ask-assistant-ui", spec.slice("@/components/ask-assistant-ui/".length)));
  }
  if (spec.startsWith("@/components/") || spec.startsWith("@/layouts/") || spec.startsWith("@/utils/")) {
    return relTo(destFile, join(SHIMS, "ui"));
  }
  // 上游的「升级弹窗」是商业化组件，内部部署无意义 ⇒ 垫成空实现（不渲染）
  if (spec.includes("upgrade-dialog")) return relTo(destFile, join(SHIMS, "ui"));
  // 只用到一两个函数的 npm 包也一并 shim（同一口径：不为此新增依赖，见 kb-shims/ui.tsx 说明）
  if (spec === "usehooks-ts" || spec === "date-fns" || spec.startsWith("date-fns/")) {
    return relTo(destFile, join(SHIMS, "ui"));
  }
  // 上游 workspace 包的零散引用（hooks=页面元信息 no-op；utils/format=体积格式化；ai-sdk 接口=模型特性表）
  if (spec === "@buildingai/hooks" || spec === "@buildingai/utils/format" || spec === "@buildingai/ai-sdk/interfaces" || spec === "@buildingai/http") {
    return relTo(destFile, join(SHIMS, "ui"));
  }
  // 富文本编辑器（platejs）：用户拍板不要富文本。实际被引用的只有
  // EditorContentRenderer（渲染欢迎描述）⇒ 垫一个纯文本渲染实现，避免拉整座 plate 依赖山
  if (spec.includes("components/editor")) {
    return relTo(destFile, join(SHIMS, "ui"));
  }
  return null;
}

/** 需要改指的说明符全集（两个阶段的 replace 都用它） */
const EXTERNAL_SPEC = /(from\s+")(@buildingai\/[^"]+|@\/[^"]+|usehooks-ts|date-fns(?:\/locale)?)(")/g;

function relTo(fromFile, targetNoExt) {
  let rel = norm(relative(dirname(fromFile), targetNoExt));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** 中间态标记：文件已改指 kb-shims，但 shim 类型宽松 ⇒ 暂不参与类型检查 */
function noCheckHeader(specs) {
  return (
    `// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（${[...new Set(specs)].join(", ")}）。\n` +
    "// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与\n" +
    "// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。\n"
  );
}

/**
 * 解析 import 说明符到真实文件。
 *
 * ⚠️ `@/` 在两边都指向各自的 `src`，而 `SRC_UI` / `SRC_CLIENT` **已是 src 本身** ⇒
 * 不能再拼一层 "src"（本脚本第一版就因此把二者拼成 `src/src`，闭包恒为空）。
 */
function resolveImport(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) {
    const aliasRoot = fromFile.startsWith(SRC_UI) ? SRC_UI : SRC_CLIENT;
    base = join(aliasRoot, spec.slice(2));
  } else if (spec.startsWith(".")) {
    base = join(dirname(fromFile), spec);
  } else {
    return null;
  }
  for (const e of EXTS) {
    const cand = `${base}${e}`;
    if (e !== "" && existsSync(cand)) return cand;
  }
  return null;
}

function collectClosure() {
  const seeds = [];
  // 闭包种子的口径 = **所有要搬的页面族**。ui 子集是从这些页面的 `@buildingai/ui/*` import
  // 里解析出来的 —— 新搬一族页面时必须把它的目录加进来，否则它用到的 ui 组件
  //（如 dashboard 的 chart / count-up）不会进闭包，生成物里就是解析不到的 import。
  for (const dir of [
    "pages/console/ai/datasets", // 知识库（管理台侧）
    "pages/datasets", // 知识库（用户侧）
    "pages/console/dashboard", // 运营总览（第 1 批移植）
    // ⚠ 密钥管理（pages/console/ai/secret）已于 2026-09-19 下线（用户口径：不要单独的密钥
    //   管理界面，密钥改在供应商配置里直接填）⇒ 本 seeds 与下方 PAGE_ROOTS 都不能再收它，
    //   否则下次重跑脚本会把已删除的页面**复活**成死代码。
    "pages/login", // 登录页（整台换皮第 1 步；它独用的 ui 组件如 field/input-otp 靠这一行才进闭包）
  ]) {
    const abs = join(SRC_CLIENT, dir);
    if (!existsSync(abs)) continue;
    const walk = (d) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(tsx|ts)$/.test(ent.name)) seeds.push(p);
      }
    };
    walk(abs);
  }

  const seen = new Set();
  const uiFiles = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const inUi = cur.startsWith(SRC_UI);
    const rel = inUi ? norm(relative(SRC_UI, cur)) : null;
    if (rel !== null && [...SKIP, ...PRUNE].some((s) => rel.startsWith(s))) continue; // 整棵/单文件剪掉
    if (inUi) uiFiles.add(cur);

    let text;
    try {
      text = readFileSync(cur, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
      const spec = m[1];
      if (spec.startsWith("@buildingai/ui")) {
        const sub = spec.slice("@buildingai/ui".length).replace(/^\//, "");
        if (sub.length === 0) continue;
        const t = resolveImport(`@/${sub}`, join(SRC_UI, "index.ts"));
        if (t !== null) queue.push(t);
      } else if (spec.startsWith("@/") || spec.startsWith(".")) {
        const t = resolveImport(spec, cur);
        if (t !== null) queue.push(t);
      }
    }
  }
  return { seeds, uiFiles };
}

function headerFor(srcFile) {
  const rel = norm(relative(SRC_UI, srcFile));
  return [
    "/**",
    ` * 移植自 ${BASELINE}：packages/@buildingai/web/ui/src/${rel}`,
    " * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）",
    " * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。",
    " */",
  ].join("\n");
}

/**
 * 本仓 admin 变量名 ← 上游 BuildingAI 变量名的映射表（左列取自 `src/styles/tw.css` 与 `src/tokens.css`）。
 *
 * 只映「影响观感」的语义色与圆角；`--danger-soft` 这类辅助色留着本仓自己的（差异极小且少用）。
 */
const TOKEN_MAP = [
  ["--canvas", "--background"],
  ["--surface", "--card"],
  ["--surface-2", "--secondary"],
  ["--surface-hover", "--muted"],
  ["--ink", "--foreground"],
  ["--ink-2", "--muted-foreground"],
  ["--hairline", "--border"],
  ["--hairline-strong", "--input"],
  ["--accent", "--primary"],
  ["--accent-ink", "--primary-foreground"],
  ["--accent-soft", "--accent"],
  ["--danger", "--destructive"],
  ["--r-lg", "--radius"],
];

/** 把上游变量表映射成本仓变量声明（跳过值里还引用 var() 的项，避免引到我们这里不存在的名字） */
function mapDeclarations(vars) {
  const out = [];
  for (const [ours, theirs] of TOKEN_MAP) {
    const v = vars.get(theirs);
    if (v !== undefined && v.length > 0 && !v.includes("var(")) out.push(`  ${ours}: ${v};`);
  }
  const radius = vars.get("--radius");
  if (radius !== undefined && !radius.includes("var(")) {
    // 本仓口径：控件圆角 = 容器圆角 - 2px（tokens.css 的 r-sm/r-lg 关系）
    out.push(`  --r-sm: calc(${radius} - 2px);`);
  }
  return out;
}

/**
 * 解析上游 theme.css，取浅色/深色两套变量取值。
 *
 * 上游的深色不是顶层 `.dark` 选择器，而是 Tailwind v4 的 **`@variant dark { … }` 嵌套块**
 *（每个令牌分组的块里各一个）——所以必须逐块拼出深色表，不能只看顶层选择器。
 * 同名取首个：远离「后一个块覆盖前一个」的歧义（深色已经单独抽出来了）。
 */
function parseThemeBlocks(text) {
  const darkBodies = extractVariantBodies(text, "dark");
  // 浅色：先把深色块从原文里挖掉，防某个只在深色里出现的变量污染浅色表
  let lightText = text;
  for (const body of darkBodies) lightText = lightText.replace(body, "");

  const light = new Map();
  collectVars(lightText, light);
  const dark = new Map();
  for (const body of darkBodies) collectVars(body, dark);
  return { light, dark };
}

function collectVars(src, into) {
  for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (!into.has(m[1])) into.set(m[1], m[2].trim());
  }
}

/** 抽出所有 `@variant <name> { … }` 的花括号内文（支持嵌套） */
function extractVariantBodies(text, name) {
  const bodies = [];
  const needle = `@variant ${name}`;
  let i = 0;
  while (true) {
    const at = text.indexOf(needle, i);
    if (at === -1) break;
    const open = text.indexOf("{", at);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}") depth -= 1;
      j += 1;
    }
    bodies.push(text.slice(open + 1, j - 1));
    i = j;
  }
  return bodies;
}

function main() {
  const { seeds, uiFiles } = collectClosure();
  if (uiFiles.size === 0) {
    console.error("闭包为空：检查源路径是否存在（开源项目/ 是否已就位）");
    process.exitCode = 1;
    return;
  }

  // 重建**生成子树**（幂等：每次全量重生成，避免残留旧文件造成"幽灵组件"）。
  //
  // ⚠️ 只清生成物（ui/ pages/ theme/），**不清整个 kb-port** ——
  //    手写件（constants/ 等）住在同一个 kb-port 下，清整目录会把它们一起删掉。
  //    取数层与 UI shim 则住在 kb-port 之外的 kb-shims/，天然不受影响。
  for (const sub of ["ui", "pages", "theme"]) {
    const p = join(OUT, sub);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  let rewritten = 0;
  let tsNoCheck = 0;
  const unresolvedPkgs = new Set();

  for (const src of uiFiles) {
    const rel = norm(relative(SRC_UI, src));
    const dest = join(OUT, "ui", rel);
    mkdirSync(dirname(dest), { recursive: true });

    let text = readFileSync(src, "utf8");
    // ① `@buildingai/ui/x` → `@/x`（随后统一按 `@/` 处理）
    text = text.replace(/@buildingai\/ui\//g, "@/");
    // ② `@/x` → 相对路径（相对**目标文件**）
    text = text.replace(/(from\s+")@\/([^"]+)(")/g, (_m, a, sub, c) => {
      const target = join(OUT, "ui", sub);
      let relPath = norm(relative(dirname(dest), target));
      if (!relPath.startsWith(".")) relPath = `./${relPath}`;
      rewritten += 1;
      return `${a}${relPath}${c}`;
    });
    // ③ 其余上游工作区包（services/stores/i18n/constants…）→ 改指本仓 kb-shims/，并记一笔
    const shimmed = [];
    text = text.replace(EXTERNAL_SPEC, (full, a, spec, c) => {
      const target = rewriteExternal(spec, dest);
      if (target === null) return full;
      shimmed.push(spec);
      return `${a}${target}${c}`;
    });
    let prefix = "";
    if (shimmed.length > 0) {
      for (const p of shimmed) unresolvedPkgs.add(p.split("/").slice(0, 2).join("/"));
      prefix = noCheckHeader(shimmed);
      tsNoCheck += 1;
    } else if (rel.startsWith("components/ai-elements/")) {
      // ai-elements 按宽松类型写（streamdown/motion 的松散 API 在严格模式下报空值错）——
      // 与 piweb 同一取舍：@ts-nocheck 保原文不改。
      prefix = "// @ts-nocheck —— 上游原样移植（宽松类型，与 piweb 同一取舍）；改动逐处见移植清单。\n";
      tsNoCheck += 1;
    }
    writeFileSync(dest, `${prefix}${headerFor(src)}\n${text}`, "utf8");
  }

  // token：**不搬上游的 @theme + 映射层**，而是把它那份 `theme.css` 的**取值**
  // 映射到**我们自己的变量名**上，整包包在 `.reactor-kb-scope` 里。
  //
  // 为什么这么做（本轮踩过的真坑）：
  //  我们的 admin 在 `src/styles/tw.css` 里已经有了 shadcn 语义色映射：
  //    `--color-primary: var(--accent)`、`--color-card: var(--surface)` …
  //  而移植来的组件用的就是 `bg-primary` / `bg-card` / `text-muted-foreground` 这些类。
  //  上游则用另一套变量名（`--primary`、`--card`…）+ 它的映射层 `shadcn/tailwind.css`（我们**没搬**）。
  //  ⇒ 结果：组件的类名被解析到**我们**的变量（`--accent` = 反应堆橙）—— 于是「组件是它的、皮是我们的」，
  //   上一版样板页看起来“没变化”就是这个原因。
  //
  // 正确做法：**在作用域内改我们变量的值**（而不是改类名映射）——
  //  作用域内整棵子树自动变成 BuildingAI 的观感，作用域外一点不动。
  //  两套 `@theme` 也因此不需要共存（Tailwind v4 的 `@theme` 是全局的，根本不能作用域）。
  const styleDir = join(SRC_UI, "styles");
  const themeOut = join(OUT, "theme");
  mkdirSync(themeOut, { recursive: true });
  const copiedStyles = [];
  const themeSrc = join(styleDir, "theme.css");
  if (existsSync(themeSrc)) {
    const raw = readFileSync(themeSrc, "utf8");
    const { light, dark } = parseThemeBlocks(raw);
    const scoped = [
      headerFor(themeSrc),
      "/* 机械变换：把上游 theme.css 的**取值**映射到本仓 admin 的变量名（详见移植清单 §2）。",
      " * 不经上游映射层 shadcn/tailwind.css —— 那会与本仓 admin 自己的 @theme 冲突（@theme 是全局的、不能作用域）。 */",
      "/* 选择器写成 `.reactor-kb-scope.reactor-kb-scope`（重复类名）是为了**提特异性**：",
      " * 本仓 :root / [data-theme=\"dark\"] 同为 (0,1,0)，只靠加载顺序不可靠。 */",
      "\n.reactor-kb-scope.reactor-kb-scope {",
      ...mapDeclarations(light),
      "}",
      // ★深色：本仓 admin 的深色选择器是 [data-theme="dark"]（不是 .dark）
      "\n[data-theme=\"dark\"] .reactor-kb-scope.reactor-kb-scope {",
      ...mapDeclarations(dark),
      "}",
      "",
    ].join("\n");
    writeFileSync(join(themeOut, "theme.css"), scoped, "utf8");
    copiedStyles.push(`theme.css（已作用域化：浅/深两条，共 ${mapDeclarations(light).length + mapDeclarations(dark).length} 条变量）`);
  }

  const totalLines = [...uiFiles].reduce((n, f) => n + lines(f), 0);
  console.log(`源闭包：知识库页面 ${seeds.length} 个起点 → ui 子集 ${uiFiles.size} 文件 / ${totalLines} 行`);
  console.log(`已复制：ui/** ${uiFiles.size} 个文件；theme/ ${copiedStyles.join(", ")}`);
  console.log(`import 改写：${rewritten} 处；加 @ts-nocheck 的中间态文件：${tsNoCheck} 个`);
  if (unresolvedPkgs.size > 0) console.log(`待替换的上游工作区包：${[...unresolvedPkgs].sort().join(", ")}`);

  portPages();
}

/**
 * 第二阶段：搬**页面**（管理台侧 console/ai/datasets + 用户侧 pages/datasets）。
 *
 * 管理台侧 9 个文件（~1.8k 行）；用户侧 39 个文件（~5.3k 行）——用户侧才是知识库的主体验
 * （上传/预览/批量/标签/发布审核/转让/与库对话），2026-09-19 拍板「都搬」。
 *
 * 与 ui 子集不同，页面会引用上游的取数层/常量/i18n —— 这些**不能机械复制**（它们连着上游后端），
 * 所以这里只做两件事：①按相对结构复制 + 改写指向已搬 ui 的路径；②**把剩下解析不了的说明符全量打印**，
 * 作为写本仓 `kb-shims/` 的清单（不猜、不漏）。
 */
function portPages() {
  const PAGE_ROOTS = [
    { src: join(SRC_CLIENT, "pages/console/ai/datasets"), out: "pages/console/ai/datasets", label: "知识库·管理台侧" },
    { src: join(SRC_CLIENT, "pages/datasets"), out: "pages/datasets", label: "知识库·用户侧" },
    // 对话栈组件库（38 文件/8k 行）：整棵搬，页内相对引用原样保留
    { src: join(SRC_CLIENT, "components/ask-assistant-ui"), out: "ask-assistant-ui", label: "对话组件库" },
    // —— 第 1 批管理端移植（台账：docs/实施计划/管理端BuildingAI移植-台账-v1.md）——
    { src: join(SRC_CLIENT, "pages/console/dashboard"), out: "pages/console/dashboard", label: "运营总览" },
    // 整台换皮第 1 步：登录页（用户要求「先搬个登录界面看看」；皮的主体在 _components/login-form.tsx 964 行）
    { src: join(SRC_CLIENT, "pages/login"), out: "pages/login", label: "登录页" },
  ];
  const external = new Map();
  /** `@buildingai/ui/x` 指向被 SKIP/PRUNE 掉的组件 ⇒ 生成物里会有解析不到的 import，必须点名 */
  const missingUi = new Map();
  let pageFiles = 0;
  let pageLines = 0;

  for (const root of PAGE_ROOTS) {
    if (!existsSync(root.src)) {
      console.log(`页面阶段：${root.label}（${root.src}）不在，跳过`);
      continue;
    }
    const files = [];
    const walk = (d) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(tsx|ts)$/.test(ent.name)) files.push(p);
      }
    };
    walk(root.src);

    const pagesOut = join(OUT, root.out);
    mkdirSync(pagesOut, { recursive: true });

    for (const src of files) {
      const rel = norm(relative(root.src, src));
      const dest = join(pagesOut, rel);
      mkdirSync(dirname(dest), { recursive: true });
      pageFiles += 1;
      pageLines += lines(src);
      let text = readFileSync(src, "utf8");
      // ask-assistant-ui 跨包引用 ui 包的富文本编辑器（../ui/components/editor）——
      // 编辑器按拍板不搬，EditorContentRenderer 垫纯文本渲染（见 kb-shims/ui）
      if (root.out === "ask-assistant-ui") {
        // 上游是 @buildingai/ui/components/editor（改写前）；相对形式是改写后的兜底
        text = text.replace(/(from\s+")@buildingai\/ui\/components\/editor(")/g, (m2, a2, c2) => `${a2}${relTo(dest, join(SHIMS, "ui"))}${c2}`);
        text = text.replace(/(from\s+")((?:\.\.\/)+)ui\/components\/editor(")/g, (m2, a2, _dots, c2) => `${a2}${relTo(dest, join(SHIMS, "ui"))}${c2}`);
      }
      // 逃逸修正（所有 root 通用）：指向 kb-shims 的相对路径统一按**本文件**深度重算。
      // 各 root 深度不同，深度算错一次（少一个 ../）就会指向不存在的 pages/kb-shims ——
      // 实测 secret 页的映射算出 4 层（需要 5 层）。对正确的引用这是恒等替换。
      {
        const shimsPrefix = relTo(dest, join(SHIMS, "x")).slice(0, -1);
        text = text.replace(/(?:\.\.\/)+kb-shims\//g, shimsPrefix);
        // ../../provider-icons（client/src/components 的兄弟件）→ kb-shims/ui
        text = text.replace(/(from\s+")((?:\.\.\/)+)provider-icons(")/g, (m2, a2, _d2, c2) => `${a2}${relTo(dest, join(SHIMS, "ui"))}${c2}`);
      }
      // lucide 版本漂移适配：上游依赖的 FileSearchCornerIcon 在我们锁定的 lucide 里不存在
      //（同名相近的是 FileSearchIcon）—— 这是全仓唯一一处非 import 路径的代码文本改写
      text = text.replace(/FileSearchCornerIcon/g, "FileSearchIcon");

      // 区块级适配（见 CLIENT_USAGE_CARD 注释）：「订单统计」卡 → 「客户端使用」卡
      if (root.out === "pages/console/dashboard" && rel === "index.tsx") {
        const t0 = text.indexOf('title="订单统计"');
        if (t0 === -1) {
          throw new Error("dashboard 区块适配失败：找不到「订单统计」卡 —— 上游源可能已变，请同步修改本变换（CLIENT_USAGE_CARD）");
        }
        const start = text.lastIndexOf("<DataCard", t0);
        const end = text.indexOf("</DataCard>", t0) + "</DataCard>".length;
        text = text.slice(0, start) + CLIENT_USAGE_CARD + text.slice(end);
      }

      // ① 指向已搬 ui 子集的 import → 相对路径（从目标文件定位到 kb-port/ui/…）。
      //    目标若不存在（被 SKIP/PRUNE 剪掉的组件），照改但**点名** —— 这些页面得等组件补齐才能编译。
      //    ⚠️ 存在性判断必须试扩展名（上游 import 不带后缀，直接 existsSync 会把
      //    `components/ui/button` 这类明明存在的也误报成缺失）。
      text = text.replace(/(from\s+")@buildingai\/ui\/([^"]+)(")/g, (full, a, sub, c) => {
        const target = join(OUT, "ui", sub);
        const exists = EXTS.some((e) => (e === "" ? false : existsSync(`${target}${e}`)));
        // 被剪组件里的特例：升级弹窗（商业化）垫成空实现，而不是报缺失
        if (!exists && sub.includes("upgrade-dialog")) return `${a}${relTo(dest, join(SHIMS, "ui"))}${c}`;
        if (!exists) {
          const k = `@buildingai/ui/${sub}`;
          missingUi.set(k, (missingUi.get(k) ?? 0) + 1);
        }
        let relPath = norm(relative(dirname(dest), target));
        if (!relPath.startsWith(".")) relPath = `./${relPath}`;
        return `${a}${relPath}${c}`;
      });
      // ② 其余「上游才有的说明符」→ 改指本仓实现（kb-shims / 本地常量副本 / 页内互引），
      //    并逐条记入清单 —— 脚本输出即「本仓接管了哪些上游引用」的清单（不猜不漏）。
      // 注：页面目录是**整棵照搬**的，页面之间的**相对**引用原样保留即可，不需要改写。
      const shimmed = [];
      text = text.replace(EXTERNAL_SPEC, (full, a, spec, c) => {
        external.set(spec, (external.get(spec) ?? 0) + 1);
        const target = rewriteExternal(spec, dest);
        if (target === null) return full;
        shimmed.push(spec);
        return `${a}${target}${c}`;
      });
      writeFileSync(dest, `${(shimmed.length > 0 || root.out === "ask-assistant-ui") ? noCheckHeader(shimmed.length > 0 ? shimmed : ["ask-assistant-ui 原样移植（宽松类型）"]) : ""}${headerFor(src)}
${text}`, "utf8");
    }
    console.log(`页面阶段[${root.label}]：复制 ${files.length} 个文件 → kb-port/${root.out}/`);
  }

  console.log(`页面阶段合计：${pageFiles} 个文件 / ${pageLines} 行`);
  console.log(`本仓已接管的引用（已改指 kb-shims/ 或本地副本；计数为改写前出现次数）：`);
  for (const [k, c] of [...external.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(c).padStart(3)}  ${k}`);
  if (missingUi.size > 0) {
    console.log(`❗指向被 SKIP/PRUNE 组件的 import（需要把组件搬回来或改写页面）：`);
    for (const [k, c] of [...missingUi.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(c).padStart(3)}  ${k}`);
  }
}

main();
