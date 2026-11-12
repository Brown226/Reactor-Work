/**
 * 技能批量导入工具（外部技能目录 → 市场）。
 *
 * ## 为什么要有它
 * 市场此前只有「管理台一次导一个技能目录」这一条路。要把一整批本地技能（`.newmax/skills`
 * 那类目录）搬进市场，手点几十次不现实，而且过程中最容易踩的三个坑脚本能一次性挡住：
 *   ① 顶层与 `_disabled/` 重名 —— 无脑「以顶层为准」会把**顶层是空壳**的技能整个丢掉；
 *   ② `_disabled/.conflicts/` 是冲突副本堆放场（同一个技能多份时间戳目录），不能当技能导入；
 *   ③ 服务端有硬上限（单文件 512KB / 单技能 8MB / 200 个 / 描述 500 字符），
 *      超限会在导入到一半才报，得先在本地说清楚。
 *
 * ## 三个子命令
 *   stage   清洗源目录到 staging/，并产出 manifest.json + manifest.md（**源目录只读，不删不改**）
 *   import  按 manifest 导入（默认 --dry-run 只报计划；--apply 才真写库）
 *
 * ## 用法
 *   node packages/server/scripts/skills-import.mjs stage
 *   node packages/server/scripts/skills-import.mjs import            # 预演
 *   node packages/server/scripts/skills-import.mjs import --apply    # 落库
 *   node packages/server/scripts/skills-import.mjs import --apply --only=docx,pptx
 *
 * ## 环境变量（都有默认值，见下）
 *   REACTOR_SKILLS_SOURCE    源技能根目录
 *   REACTOR_SKILLS_STAGING   清洗产物目录（默认 .runtime/skills-import，已被 gitignore）
 *   REACTOR_IDENTITY_URL     身份服务地址（默认 http://127.0.0.1:8791）
 *   REACTOR_IMPORT_ADMIN     管理员账号（默认 admin）
 *   REACTOR_IMPORT_ADMIN_PWD 管理员口令（默认取 REACTOR_TEST_ADMIN_PWD，再退回 Admin@123）
 *
 * ## 幂等
 * `POST /admin/skills` 对已存在的 name 返回 409。重跑时用 `--update` 走 PATCH 覆盖元数据 +
 * 重传附件，这样"改了清单再导一遍"不会变成一堆重复技能。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// 动态 import Windows 绝对路径必须转 file://，否则 ERR_UNSUPPORTED_ESM_URL_SCHEME 'e:'
const { parseSkillFrontmatter, normalizeSkillFilePath, SKILL_FILE_LIMITS } = await import(
  pathToFileURL(join(ROOT, "packages", "shared", "dist", "index.js")).href
);

const SOURCE = process.env.REACTOR_SKILLS_SOURCE ?? join("C:", "Users", "24800", ".newmax", "skills");
const STAGING = resolve(ROOT, process.env.REACTOR_SKILLS_STAGING ?? join(".runtime", "skills-import"));
const IDENTITY = process.env.REACTOR_IDENTITY_URL ?? "http://127.0.0.1:8791";
const ADMIN_USER = process.env.REACTOR_IMPORT_ADMIN ?? "admin";
const ADMIN_PWD = process.env.REACTOR_IMPORT_ADMIN_PWD ?? process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123";

/** 服务端硬上限（改这里没用，要对齐 routes.ts 的 MAX_* 与 shared 的 SKILL_FILE_LIMITS） */
const MAX_DESC_CHARS = 500;
const MAX_TITLE_CHARS = 120;

/**
 * 排除名单 —— 这些不是"可下发的技能"。
 * `--help` 是 skill-creator 生成的脚手架模板（正文还是 TODO 占位，且 `--` 开头不合 SKILL_NAME_PATTERN）；
 * `niuma-help` 是另一款产品的用户帮助文档，不属于本平台的能力面。
 */
const EXCLUDE = new Map([
  ["--help", "脚手架模板（正文为 TODO 占位），且标识不合 SKILL_NAME_PATTERN"],
  ["niuma-help", "牛马AI 的产品帮助文档，非本平台能力"],
]);

/** 目录名 → 噪音文件（管理台整目录导入用的同一套判据） */
const NOISE = /(^|\/)(\.DS_Store|Thumbs\.db|__pycache__|\.git|\.conflicts)(\/|$)/;

/**
 * 技能**覆写目录**：`<name>/SKILL.md` 存在时，用它替代源目录里的同名技能。
 *
 * 为什么需要它：`stage` 的产物 `.runtime/skills-import/` 是 gitignore 的临时目录，
 * 重跑一次就把人工改过的内容（比如合并稿）冲掉了。凡是要**跨会话保留**的内容改动，
 * 都放这个目录里，这样 `stage` 才是可复现的。
 */
const OVERRIDES = resolve(ROOT, "packages", "server", "scripts", "skills-overrides");

/**
 * 合并规则：把 `from` 里的若干源技能合成一个 `name`（合成稿放覆写目录）。
 *
 * `ponytail` 四件套合并的判据：`ponytail-audit` 开篇自称「ponytail-review, repo-wide」、
 * 标签表与 `ponytail-review` 逐字重复；`ponytail-debt` 扫的 `ponytail:` 注释约定本身
 * 就定义在 `ponytail` 正文里。合并后标签表与边界说明各只留一份，触发词全覆盖（见覆写稿）。
 */
const MERGES = [
  { name: "ponytail", from: ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt"] },
];

/** 被合并吸收掉的源技能名（不再单独导入） */
const MERGED_AWAY = new Map();
for (const m of MERGES) {
  for (const part of m.from) if (part !== m.name) MERGED_AWAY.set(part, m.name);
}

/**
 * 分类建议（5 类：office/dev/data/content/other）。
 * 这里只是**建议** —— 落库前会在 manifest 里列出来给人过目，改 manifest 即可，不必改脚本。
 */
const CATEGORY_SUGGESTION = {
  // 办公协同
  docx: "office", pptx: "office", xlsx: "office", pdf: "office",
  "doc-coauthoring": "office", "vba-excel-modifier": "office", "internal-comms": "office",
  "long-term-plan": "office", "theme-factory": "office",
  // 开发工具
  "mcp-builder": "dev", "skill-creator": "dev", "webapp-testing": "dev", "project-init": "dev",
  triage: "dev", ponytail: "dev", "ponytail-audit": "dev", "ponytail-debt": "dev",
  "ponytail-review": "dev", "workflow-automator": "dev",
  // 数据分析
  "data-analysis": "data", ppocrv5: "data", "ds-vision-skill": "data",
  "deep-review": "data", "daily-review": "data",
  // 内容创作
  "baoyu-article-illustrator": "content", "baoyu-comic": "content", "baoyu-compress-image": "content",
  "baoyu-danger-gemini-web": "content", "baoyu-danger-x-to-markdown": "content",
  "baoyu-format-markdown": "content", "baoyu-image-gen": "content", "baoyu-infographic": "content",
  "baoyu-markdown-to-html": "content", "baoyu-post-to-wechat": "content", "baoyu-post-to-x": "content",
  "baoyu-slide-deck": "content", "baoyu-url-to-markdown": "content", "blog-post-writer": "content",
  "brand-guidelines": "content", "algorithmic-art": "content", "remotion-video": "content",
  "slack-gif-creator": "content", "imagemagick-conversion": "content", "ffmpeg-usage": "content",
  // 其他
  deepl: "other", "feishu-doc-reader": "other",
};

/**
 * 人工复核标记：这些技能**建议暂缓或需要前置配置**，不是脚本能替你拍板的。
 * 导入脚本不会自动跳过它们（避免"静默漏掉"），但 manifest 里会逐条写明理由。
 */
const REVIEW_FLAGS = {
  "baoyu-danger-gemini-web": "自称逆向 Gemini Web API；合规需确认（对外服务的非授权调用）",
  "baoyu-danger-x-to-markdown": "自称逆向 X API，正文要求用户显式同意；合规需确认",
  "baoyu-post-to-x": "向 X 发布内容 + CDP 绕反自动化；对外发布动作需确认",
  "baoyu-post-to-wechat": "向公众号发布内容；对外发布动作需确认",
  "baoyu-url-to-markdown": "Chrome CDP 抓取任意 URL；内网使用需确认边界",
  "baoyu-image-gen": "依赖外部图像生成 API key，未配置则不可用",
  "feishu-doc-reader": "依赖飞书 Open API 凭证，未配置则不可用",
  deepl: "依赖 DeepL API key；且正文与描述为德文",
  "ds-vision-skill": "依赖外部视觉模型（含 .ps1 路由脚本），需确认可用的上游",
  ppocrv5: "OCR 能力，需确认本地/远端依赖",
  "vba-excel-modifier": "可改 .xlsm 宏代码，能力强；建议限部门或角色下发",
  "brand-guidelines": "Anthropic 品牌规范，对内部产出的适用性有限",
  "internal-comms": "英文内部沟通模板（Anthropic 口径），需确认是否替换为本司格式",
  "slack-gif-creator": "Slack 专用产出，本司未必使用",
  triage: "面向 GitHub issue/PR 状态机，需确认与本司流程是否匹配",
};

/** 精选/默认安装建议：先只把「办公三件套 + PDF」设为默认安装，其余走用户自选 */
const AUTO_INSTALL = new Set(["docx", "pptx", "xlsx", "pdf"]);
const FEATURED = new Set(["docx", "pptx", "xlsx", "pdf", "data-analysis", "ds-vision-skill"]);

// ────────────────────────────── 通用小工具 ──────────────────────────────

const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** 是否二进制：含 NUL 或不是合法 UTF-8（比扩展名白名单可靠，且与管理台的判据不冲突） */
function isBinary(buf) {
  if (buf.includes(0)) return true;
  const decoded = buf.toString("utf8");
  return !Buffer.from(decoded, "utf8").equals(buf);
}

function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(base, p).split(sep).join("/");
    if (NOISE.test(rel)) continue;
    if (e.isDirectory()) walk(p, base, acc);
    else if (e.isFile()) acc.push(rel);
  }
  return acc;
}

/** 人类可读标题的兜底：`baoyu-slide-deck` → `Baoyu Slide Deck`（manifest 里可改） */
const humanize = (name) => name.split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");

// ────────────────────────────── stage ──────────────────────────────

function collectNames() {
  const names = new Set();
  for (const e of readdirSync(SOURCE, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== "_disabled") names.add(e.name);
  }
  const disabled = join(SOURCE, "_disabled");
  if (existsSync(disabled)) {
    for (const e of readdirSync(disabled, { withFileTypes: true })) {
      // `.conflicts` 是冲突副本堆放场，不是技能
      if (e.isDirectory() && !e.name.startsWith(".")) names.add(e.name);
    }
  }
  // 被合并吸收的源技能不再单独导入（否则市场里会同时存在合并稿和它的零件）
  return [...names].filter((n) => !MERGED_AWAY.has(n)).sort();
}

/**
 * 选定权威来源。优先级：覆写目录 > 顶层 > `_disabled/`。
 *
 * 关键规则：**顶层有 SKILL.md 才用顶层**。不能按名字一概"以顶层为准"——
 * 本批里有 3 个技能顶层是空壳目录、真正的内容只在 `_disabled/` 里
 * （baoyu-format-markdown / baoyu-url-to-markdown / workflow-automator）。
 */
function pickSource(name) {
  const override = join(OVERRIDES, name);
  if (existsSync(join(override, "SKILL.md"))) {
    const merge = MERGES.find((m) => m.name === name);
    return { dir: override, from: merge ? `merge(${merge.from.length})` : "override" };
  }
  const top = join(SOURCE, name);
  const dis = join(SOURCE, "_disabled", name);
  if (existsSync(join(top, "SKILL.md"))) return { dir: top, from: "top" };
  if (existsSync(join(dis, "SKILL.md"))) return { dir: dis, from: "_disabled" };
  return null;
}

function cmdStage() {
  console.log(`源目录：${SOURCE}`);
  console.log(`清洗到：${STAGING}\n`);
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  const skills = [];
  const skipped = [];

  for (const name of collectNames()) {
    if (EXCLUDE.has(name)) {
      skipped.push({ name, why: EXCLUDE.get(name) });
      continue;
    }
    const picked = pickSource(name);
    if (!picked) {
      skipped.push({ name, why: "空目录（顶层与 _disabled 都没有 SKILL.md）" });
      continue;
    }

    const { meta } = parseSkillFrontmatter(readFileSync(join(picked.dir, "SKILL.md"), "utf8"));
    const files = walk(picked.dir);
    const attachments = [];
    let total = 0;
    let oversize = null;
    let tooMany = false;

    for (const rel of files) {
      if (rel === "SKILL.md") continue;
      const abs = join(picked.dir, ...rel.split("/"));
      const buf = readFileSync(abs);
      if (buf.length > SKILL_FILE_LIMITS.maxFileBytes) { oversize = rel; continue; }
      total += buf.length;
      if (attachments.length >= SKILL_FILE_LIMITS.maxFiles) { tooMany = true; break; }
      attachments.push({ path: rel, size: buf.length, sha256: sha256hex(buf) });
    }

    // 落 staging（保留目录结构，供人工核对与重跑）
    const dest = join(STAGING, name);
    mkdirSync(dest, { recursive: true });
    for (const rel of files) {
      const to = join(dest, ...rel.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(picked.dir, ...rel.split("/")), to);
    }

    const description = (meta.description ?? "").trim();
    skills.push({
      name,
      source: picked.from,
      // 标题/简介是**建议值**，过目时可直接改 manifest
      title: humanize(name).slice(0, MAX_TITLE_CHARS),
      description: description.slice(0, MAX_DESC_CHARS),
      descriptionFull: description.length,
      descriptionTruncated: description.length > MAX_DESC_CHARS,
      category: CATEGORY_SUGGESTION[name] ?? "other",
      tags: [],
      featured: FEATURED.has(name),
      autoInstall: AUTO_INSTALL.has(name),
      author: "内置",
      files: attachments,
      totalBytes: total,
      oversize: oversize,
      tooMany,
      review: REVIEW_FLAGS[name] ?? null,
    });
  }

  // 被合并吸收的源技能：列出来而不是静默吞掉（否则"少了一个技能"会被当成漏导）
  for (const [part, into] of MERGED_AWAY) {
    skipped.push({ name: part, why: `已合并进 \`${into}\`（合并稿在 packages/server/scripts/skills-overrides/）` });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    limits: { ...SKILL_FILE_LIMITS, maxDescChars: MAX_DESC_CHARS },
    count: skills.length,
    skills,
    skipped,
  };
  writeFileSync(join(STAGING, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(join(STAGING, "manifest.md"), renderManifestMd(manifest), "utf8");

  // 本地预检（服务端还会再校验一次，这里是为了"别导到一半才报"）
  const problems = [];
  for (const s of skills) {
    if (s.oversize) problems.push(`${s.name}: ${s.oversize} 超过单文件上限`);
    if (s.tooMany) problems.push(`${s.name}: 附件数超过 ${SKILL_FILE_LIMITS.maxFiles}`);
    if (s.totalBytes > SKILL_FILE_LIMITS.maxTotalBytes) problems.push(`${s.name}: 附件总量 ${(s.totalBytes / 1048576).toFixed(2)}MB 超限`);
  }

  console.log(`✅ 入选 ${skills.length} 个技能，跳过 ${skipped.length} 个`);
  console.log(`   附件总数 ${skills.reduce((n, s) => n + s.files.length, 0)}，合计 ${(skills.reduce((n, s) => n + s.totalBytes, 0) / 1048576).toFixed(2)}MB`);
  console.log(`   需人工复核 ${skills.filter((s) => s.review).length} 个 · 描述超 ${MAX_DESC_CHARS} 被截断 ${skills.filter((s) => s.descriptionTruncated).length} 个`);
  if (problems.length) {
    console.log("\n⚠ 上限预检未过（导入前必须处理）：");
    for (const p of problems) console.log(`   - ${p}`);
  }
  console.log(`\n清单：${join(STAGING, "manifest.md")}`);
  console.log(`      ${join(STAGING, "manifest.json")}`);
}

function renderManifestMd(m) {
  const L = [];
  L.push(`# 技能导入清单（${m.count} 个）`);
  L.push("");
  L.push(`> 生成于 ${m.generatedAt} · 源目录 \`${m.source}\``);
  L.push("> 本文件由 `skills-import.mjs stage` 生成；**过目后要改就改 manifest.json**（导入按 json 走）。");
  L.push("");
  L.push("## 入选");
  L.push("");
  L.push("| 技能 | 来源 | 分类 | 精选 | 默认装 | 附件 | 大小 | 复核 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const s of m.skills) {
    L.push(`| \`${s.name}\` | ${s.source === "top" ? "顶层" : "**\\_disabled**"} | ${s.category} | ${s.featured ? "✓" : ""} | ${s.autoInstall ? "✓" : ""} | ${s.files.length} | ${(s.totalBytes / 1024).toFixed(0)}KB | ${s.review ? "⚠" : ""} |`);
  }
  L.push("");
  const flagged = m.skills.filter((s) => s.review);
  if (flagged.length) {
    L.push("## 需人工复核（建议暂缓或先配好前置）");
    L.push("");
    for (const s of flagged) L.push(`- \`${s.name}\` — ${s.review}`);
    L.push("");
  }
  const trunc = m.skills.filter((s) => s.descriptionTruncated);
  if (trunc.length) {
    L.push(`## 描述超 ${m.limits.maxDescChars} 字符被截断`);
    L.push("");
    for (const s of trunc) L.push(`- \`${s.name}\`：原 ${s.descriptionFull} 字符 → 截断为 ${s.description.length}`);
    L.push("");
  }
  const fromDisabled = m.skills.filter((s) => s.source === "_disabled");
  if (fromDisabled.length) {
    L.push("## 来源为 `_disabled/` 的技能");
    L.push("");
    L.push("这些技能顶层没有内容，**只有 `_disabled/` 里有** —— 按「以顶层为准」的规则会被整个丢掉。");
    L.push("");
    for (const s of fromDisabled) L.push(`- \`${s.name}\``);
    L.push("");
  }
  L.push("## 已排除");
  L.push("");
  for (const s of m.skipped) L.push(`- \`${s.name}\` — ${s.why}`);
  L.push("");
  return L.join("\n");
}

// ────────────────────────────── import ──────────────────────────────

async function login() {
  const res = await fetch(`${IDENTITY}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PWD }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.accessToken) throw new Error(`登录失败（${res.status}）：${JSON.stringify(json)?.slice(0, 160)}`);
  return json.accessToken;
}

async function cmdImport(argv) {
  const apply = argv.includes("--apply");
  const update = argv.includes("--update");
  const onlyArg = argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean)) : null;

  const manifestPath = join(STAGING, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`找不到清单：${manifestPath}（先跑 stage）`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const skills = only ? manifest.skills.filter((s) => only.has(s.name)) : manifest.skills;

  console.log(`目标服务：${IDENTITY}`);
  console.log(`清单：${manifestPath}（共 ${manifest.skills.length} 个，本次处理 ${skills.length} 个）`);
  console.log(`模式：${apply ? (update ? "APPLY + 覆盖已有" : "APPLY") : "DRY-RUN（只报计划，不写库）"}\n`);

  const token = apply ? await login() : null;
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  const results = [];

  for (const s of skills) {
    const content = readFileSync(join(STAGING, s.name, "SKILL.md"), "utf8");
    const payload = {
      name: s.name,
      title: s.title,
      content,
      description: s.description,
      category: s.category,
      tags: s.tags,
      featured: s.featured,
      autoInstall: s.autoInstall,
      author: s.author,
      scope: { kind: "all" },
    };
    // 附件：文本走 content，二进制走 contentB64（与落盘字节同源的 sha 由服务端算）
    const files = s.files.map((f) => {
      const buf = readFileSync(join(STAGING, s.name, ...f.path.split("/")));
      return isBinary(buf) ? { path: f.path, contentB64: buf.toString("base64") } : { path: f.path, content: buf.toString("utf8") };
    });

    if (!apply) {
      console.log(`  · ${s.name}  [${s.category}]${s.featured ? " 精选" : ""}${s.autoInstall ? " 默认装" : ""}  附件 ${files.length} 个${s.review ? "  ⚠" + s.review : ""}`);
      results.push({ name: s.name, action: "dry-run" });
      continue;
    }

    const created = await fetch(`${IDENTITY}/admin/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify(payload),
    });
    let json = await created.json().catch(() => null);
    let id = json?.skill?.id ?? null;
    let action = "created";

    if (created.status === 409) {
      if (!update) {
        console.log(`  ✗ ${s.name} 已存在（用 --update 覆盖）`);
        results.push({ name: s.name, action: "conflict" });
        continue;
      }
      const found = await (await fetch(`${IDENTITY}/admin/skills`, { headers: auth })).json();
      const existing = (found?.skills ?? []).find((x) => x.name === s.name);
      if (!existing) { console.log(`  ✗ ${s.name} 报 409 却查不到，跳过`); results.push({ name: s.name, action: "conflict" }); continue; }
      id = existing.id;
      const patched = await fetch(`${IDENTITY}/admin/skills/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify(payload),
      });
      if (!patched.ok) { console.log(`  ✗ ${s.name} PATCH 失败 ${patched.status}`); results.push({ name: s.name, action: "patch-failed" }); continue; }
      action = "updated";
    } else if (!created.ok || !id) {
      console.log(`  ✗ ${s.name} 创建失败 ${created.status}：${JSON.stringify(json)?.slice(0, 140)}`);
      results.push({ name: s.name, action: "create-failed" });
      continue;
    }

    if (files.length > 0) {
      const put = await fetch(`${IDENTITY}/admin/skills/${id}/files`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ files }),
      });
      if (!put.ok) {
        const err = await put.json().catch(() => null);
        console.log(`  ⚠ ${s.name} 正文已入库，但附件失败 ${put.status}：${JSON.stringify(err)?.slice(0, 140)}`);
        results.push({ name: s.name, action, files: "failed" });
        continue;
      }
    }
    console.log(`  ✓ ${s.name} ${action}（附件 ${files.length}）`);
    results.push({ name: s.name, action, files: files.length });
  }

  const ok = results.filter((r) => r.action === "created" || r.action === "updated").length;
  const bad = results.filter((r) => String(r.action).includes("failed") || r.action === "conflict").length;
  console.log(`\n完成：成功 ${ok} · 失败/冲突 ${bad}${apply ? "" : "（dry-run）"}`);
  if (!apply) console.log("确认清单无误后加 --apply 落库；已有同名技能加 --update 覆盖。");
  if (bad > 0) process.exitCode = 1;
}

// ────────────────────────────── 入口 ──────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "stage") {
  cmdStage();
} else if (cmd === "import") {
  await cmdImport(rest);
} else {
  console.error("用法：skills-import.mjs stage | import [--dry-run|--apply] [--update] [--only=a,b]");
  process.exitCode = 2;
}
