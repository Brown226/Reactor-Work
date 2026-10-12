/**
 * Reactor 说明书站点构建：把 pages/*.md 渲染成可离线浏览的多文件 HTML。
 *
 * 仅做本地静态生成，无外部依赖：markdown 子集渲染器在本文件内实现，
 * 不引入 marked 等库（它们只是传递依赖，并非本仓声明依赖）。
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = import.meta.dirname;
const PAGES_DIR = path.join(ROOT, "pages");
const ASSETS_DIR = path.join(ROOT, "assets");

export const PRODUCT = "Reactor";
export const PRODUCT_FULL = "Reactor（数智堆脑）";

/** 侧栏导航：顺序即显示顺序，slug 对应 pages/<slug>.md；related 为页尾「相关页面」卡片。 */
export const NAV = [
  {
    group: "开始使用",
    items: [
      { slug: "index", title: "说明书首页", isIndex: true },
      { slug: "welcome", title: "概述与核心能力", related: ["install", "model-access", "about"] },
      { slug: "install", title: "安装与部署", related: ["model-access", "qa", "linux-wsl"] },
      { slug: "model-access", title: "接入模型", related: ["install", "server-usage-policy", "feedback"] },
      { slug: "feedback", title: "反馈与支持", related: ["qa", "about"] },
    ],
  },
  {
    group: "核心功能",
    items: [
      { slug: "agent", title: "Reactor Agent", related: ["task-management", "goal", "keyboard-shortcuts"] },
      { slug: "goal", title: "目标模式", related: ["agent", "automations"] },
      { slug: "memory", title: "项目记忆", related: ["agent", "data-contracts"] },
      { slug: "repo-wiki", title: "仓库百科", related: ["agent", "memory"] },
      { slug: "task-management", title: "任务与文件管理", related: ["agent", "edit-history", "review-panel"] },
      { slug: "edit-history", title: "编辑历史对话", related: ["task-management"] },
      { slug: "automations", title: "定时任务", related: ["idle-time-tasks", "goal"] },
      { slug: "idle-time-tasks", title: "闲时任务", related: ["automations"] },
      { slug: "remote-development", title: "远程开发", related: ["server-overview", "feedback"] },
      { slug: "subagents", title: "子智能体", related: ["agent", "skill"] },
      { slug: "browser-use", title: "浏览器自动化", related: ["agent", "review-panel"] },
    ],
  },
  {
    group: "扩展体系",
    items: [
      { slug: "plugin", title: "插件", related: ["skill", "mcp", "hooks"] },
      { slug: "skill", title: "技能", related: ["plugin", "command"] },
      { slug: "mcp", title: "MCP", related: ["plugin", "hooks"] },
      { slug: "command", title: "命令", related: ["skill", "keyboard-shortcuts"] },
      { slug: "hooks", title: "Hooks", related: ["plugin", "mcp"] },
    ],
  },
  {
    group: "本仓特有功能",
    items: [
      { slug: "interface-modes", title: "界面模式（编程 / 办公 / 审查）", related: ["review-panel", "office-suite"] },
      { slug: "review-panel", title: "文件审查板块", related: ["interface-modes", "agent"] },
      { slug: "office-suite", title: "内网办公四件套", related: ["interface-modes", "skill"] },
      { slug: "model-governance", title: "模型治理与开发者模式", related: ["server-overview", "data-contracts"] },
      { slug: "data-contracts", title: "数据目录与背景主题契约", related: ["model-governance"] },
    ],
  },
  {
    group: "内网服务端",
    items: [
      { slug: "server-overview", title: "服务端总览与接线", related: ["server-delivery", "server-usage-policy", "model-governance", "software-update"] },
      { slug: "software-update", title: "软件包分发与自动更新", related: ["install", "server-overview", "server-delivery"] },
      { slug: "server-delivery", title: "技能与 Agent 下发", related: ["server-overview"] },
      { slug: "server-usage-policy", title: "用量上报与策略下发", related: ["server-overview"] },
    ],
  },
  {
    group: "帮助",
    items: [
      { slug: "keyboard-shortcuts", title: "快捷键表", related: ["agent", "qa"] },
      { slug: "qa", title: "常见问题", related: ["feedback", "linux-wsl"] },
      { slug: "linux-wsl", title: "Linux / WSL 排查", related: ["qa", "install"] },
      { slug: "about", title: "关于本说明书", related: ["welcome", "feedback"] },
    ],
  },
];

/** @param {string} text */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 行内元素：先转义，再按固定顺序还原标记，避免嵌套被反复替换。 */
function renderInline(source) {
  const slots = [];
  const stash = (html) => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };

  let text = source;
  // 行内代码优先保护，内部不再解析其他标记。
  text = text.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));
  text = escapeHtml(text);
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const external = /^https?:/i.test(href);
    const attrs = external ? ' target="_blank" rel="noreferrer noopener"' : "";
    const safeHref = external ? href : href.replace(/\.md$/, ".html");
    return stash(`<a href="${safeHref}"${attrs}>${label}</a>`);
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => slots[Number(index)]);
}

function splitRow(line) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** markdown 子集渲染：标题、段落、列表、表格、围栏代码、引用、分隔线、截图。
 *  existingImages：构建前扫描出的实际存在的截图路径；缺失的引用渲染成占位框。 */
function renderMarkdown(markdown, existingImages = new Set()) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (/^\s*$/.test(line)) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const body = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      html.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugify(text);
      html.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      html.push("<hr />");
      index += 1;
      continue;
    }

    // 截图：独立成行的 ![说明](assets/img/<名字>.png)。文件存在渲染真图，缺失渲染占位框。
    const shot = line.match(/^!\[([^\]]*)\]\((assets\/img\/[^)\s]+)\)$/);
    if (shot) {
      const [, alt, src] = shot;
      if (existingImages.has(src)) {
        html.push(
          `<figure class="manual-shot"><img src="${src}" alt="${escapeHtml(alt)}" loading="lazy" /></figure>`,
        );
      } else {
        html.push(
          `<figure class="manual-shot shot-placeholder" role="img" aria-label="${escapeHtml(alt)}">` +
            `<span class="shot-title">${escapeHtml(alt)}</span>` +
            `<span class="shot-hint">截图占位 · 截图存为 <code>portal/manual/${src}</code> 后重新构建即自动显示</span>` +
            `</figure>`,
        );
      }
      index += 1;
      continue;
    }

    // 表格：表头 + 分隔行
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1] ?? "")) {
      const head = splitRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      const headHtml = head.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
      const rowsHtml = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
        .join("\n");
      html.push(
        `<div class="table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>\n${rowsHtml}\n</tbody></table></div>`,
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(body.join("\n"), existingImages)}</blockquote>`);
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (index < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[index])) {
        const item = lines[index].replace(/^\s*([-*+]|\d+\.)\s+/, "");
        index += 1;
        // 缩进续行并入当前列表项
        const extra = [];
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[index])) {
          extra.push(lines[index].trim());
          index += 1;
        }
        items.push(renderInline(extra.length > 0 ? `${item} ${extra.join(" ")}` : item));
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length &&
      !/^\s*$/.test(lines[index]) &&
      !/^(#{1,4})\s+/.test(lines[index]) &&
      !/^```/.test(lines[index]) &&
      !/^\s*\|/.test(lines[index]) &&
      !/^\s*>/.test(lines[index]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[index]) &&
      !/^\s*(---+|\*\*\*+)\s*$/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(" ").trim())}</p>`);
  }

  return html.join("\n");
}

/** 标题锚点：保留中日韩与字母数字，其余转连字符。 */
function slugify(text) {
  const plain = text
    .replace(/`/g, "")
    .replace(/[*_~]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase();
  const slug = plain.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug || "section";
}

function findNavItem(slug) {
  for (const group of NAV) {
    const item = group.items.find((candidate) => candidate.slug === slug);
    if (item) return item;
  }
  return null;
}

function findGroupOf(slug) {
  return NAV.find((group) => group.items.some((candidate) => candidate.slug === slug)) ?? null;
}

/** 左侧目录栏：分组标题 + 页面列表，当前页高亮。桌面常显，窄屏由 manual.js 变抽屉。
    id=manual-nav 供 assets/manual.js 读取，类名契约不可改。 */
function renderSidebar(currentSlug) {
  const sections = NAV.map((group) => {
    const links = group.items
      .map((item) => {
        // 标记当前页：抽屉定位与高亮都靠它，否则翻到长列表末尾时看不出自己停在哪。
        const current = item.slug === currentSlug ? ' class="is-current"' : "";
        return `<a href="${item.slug}.html"${current}>${escapeHtml(item.title)}</a>`;
      })
      .join("\n");
    return `<section class="side-group">
<h3>${escapeHtml(group.group)}</h3>
${links}
</section>`;
  }).join("\n");
  return `<aside class="docs-sidebar" id="manual-nav" aria-label="说明书目录">
<nav class="side-scroll">
${sections}
</nav>
</aside>`;
}

/** 从渲染后的正文提取 h2/h3，生成右侧「本页目录」。 */
function renderToc(bodyHtml) {
  const items = [];
  const heading = /<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g;
  let match;
  while ((match = heading.exec(bodyHtml))) {
    const text = match[3].replace(/<[^>]+>/g, "").trim();
    if (text) items.push({ level: Number(match[1]), id: match[2], text });
  }
  if (items.length < 2) return "";
  const rows = items
    .map((item) => {
      const sub = item.level === 3 ? " is-sub" : "";
      return `<a class="toc-l${sub}" href="#${item.id}">${escapeHtml(item.text)}</a>`;
    })
    .join("\n");
  return `<aside class="toc-rail" aria-label="本页目录">
<div class="toc-title">本页目录</div>
${rows}
</aside>`;
}

/** 上一页 / 下一页翻页器：按 NAV 声明顺序。 */
function renderPager(slug) {
  const order = [];
  for (const group of NAV) for (const item of group.items) order.push(item);
  const pos = order.findIndex((item) => item.slug === slug);
  if (pos === -1) return "";
  const cell = (item, label, cls) => {
    if (!item) return `<span class="pager-cell ${cls} is-none" aria-hidden="true"></span>`;
    return `<a class="pager-cell ${cls}" href="${item.slug}.html"><span>${label}</span><b>${escapeHtml(item.title)}</b></a>`;
  };
  return `<nav class="pager" aria-label="翻页">
${cell(order[pos - 1], "← 上一页", "is-prev")}
${cell(order[pos + 1], "下一页 →", "is-next")}
</nav>`;
}

/** 页尾「相关页面」卡片：来自 NAV 里配置的 related，最多展示 3 张。 */
function renderRelated(slug) {
  const related = (findNavItem(slug)?.related ?? []).filter((target) => target !== slug).slice(0, 3);
  if (related.length === 0) return "";
  const cards = related
    .map((target) => {
      const title = findNavItem(target)?.title ?? target;
      return `<a class="related-card" href="${target}.html"><span>${escapeHtml(title)}</span><span aria-hidden="true">→</span></a>`;
    })
    .join("\n");
  return `<section class="manual-related"><h2>相关页面</h2>\n<div class="related-grid">\n${cards}\n</div></section>`;
}

function renderPageShell({ slug, title, body, isIndex, lastVerified, toc, crumb }) {
  const pageTitle = isIndex ? `${PRODUCT} 说明书` : `${title} · ${PRODUCT} 说明书`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeHtml(PRODUCT_FULL)} 内网部署的产品说明书：按本仓库实际行为整理。" />
<link rel="stylesheet" href="assets/manual.css" />
</head>
<body>
<header class="docs-topbar">
  <div class="topbar-inner">
    <a class="brand" href="index.html">${escapeHtml(PRODUCT)}<span class="brand-sub">数智堆脑</span></a>
    <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="manual-nav">目录</button>
    <a class="top-home" href="../index.html">官网 ↗</a>
  </div>
</header>
<div class="docs-layout">
  ${renderSidebar(slug)}
  <main class="docs-main">
    ${crumb ? `<div class="doc-crumb">${escapeHtml(crumb)}</div>` : ""}
    <article class="docs-article">
${body}
${renderRelated(slug)}
${renderPager(slug)}
    </article>
    <footer class="docs-footer">
      <p>本说明书依据当前检出的源码整理；行为与说明书不一致时，以源码与 <code>docs/</code> 下的契约为准。</p>
      ${lastVerified ? `<p class="footer-verified">本页内容核对于 ${escapeHtml(lastVerified)}。</p>` : ""}
    </footer>
  </main>
${toc}
</div>
<button type="button" class="to-top" aria-label="回到顶部">↑</button>
<script src="assets/manual.js"></script>
</body>
</html>
`;
}

async function main() {
  await mkdir(ASSETS_DIR, { recursive: true });
  const files = (await readdir(PAGES_DIR)).filter((f) => f.endsWith(".md"));
  const titles = new Map();
  for (const group of NAV) for (const item of group.items) titles.set(item.slug, item.title);

  // 预读全部 md：解析 frontmatter（目前只有 last-verified），收集引用到的截图并标记实际存在的文件。
  const sources = new Map();
  const referencedImages = new Set();
  for (const file of files) {
    const raw = await readFile(path.join(PAGES_DIR, file), "utf8");
    const slug = file.replace(/\.md$/, "");
    let markdown = raw;
    let lastVerified = null;
    const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (frontmatter) {
      const verified = frontmatter[1].match(/^last-verified:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
      if (verified) lastVerified = verified[1];
      markdown = markdown.slice(frontmatter[0].length);
    }
    sources.set(slug, { markdown, lastVerified });
    for (const match of markdown.matchAll(/!\[[^\]]*\]\((assets\/img\/[^)\s]+)\)/g)) {
      referencedImages.add(match[1]);
    }
  }

  const existingImages = new Set();
  for (const src of referencedImages) {
    try {
      await stat(path.join(ROOT, src));
      existingImages.add(src);
    } catch {
      // 文件缺失：渲染为占位框，等截图补齐后重新构建。
    }
  }

  const written = [];
  let refCount = 0;
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const { markdown, lastVerified } = sources.get(slug);
    const body = renderMarkdown(markdown, existingImages);
    const title = titles.get(slug) ?? slug;
    const group = findGroupOf(slug);
    const crumb = group && slug !== "index" ? `${group.group} · ${title}` : "";
    const toc = renderToc(body);
    const html = renderPageShell({ slug, title, body, isIndex: slug === "index", lastVerified, toc, crumb });
    await writeFile(path.join(ROOT, `${slug}.html`), html, "utf8");
    written.push(`${slug}.html`);
    refCount += (markdown.match(/!\[[^\]]*\]\(assets\/img\/[^)\s]+\)/g) ?? []).length;
  }
  const placeholderCount = [...referencedImages].filter((src) => !existingImages.has(src)).length;

  const missing = [...titles.keys()].filter((slug) => !files.includes(`${slug}.md`));
  console.log(`已生成 ${written.length} 个页面：${written.join(", ")}`);
  console.log(
    `截图引用 ${refCount} 处（${referencedImages.size} 个文件），已就位 ${existingImages.size} 个文件，占位待补 ${placeholderCount} 个文件`,
  );
  if (missing.length > 0) console.log(`缺少内容文件：${missing.join(", ")}`);
}

await main();
