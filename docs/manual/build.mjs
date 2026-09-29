/**
 * Reactor 说明书站点构建：把 pages/*.md 渲染成可离线浏览的多文件 HTML。
 *
 * 仅做本地静态生成，无外部依赖：markdown 子集渲染器在本文件内实现，
 * 不引入 marked 等库（它们只是传递依赖，并非本仓声明依赖）。
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = import.meta.dirname;
const PAGES_DIR = path.join(ROOT, "pages");
const ASSETS_DIR = path.join(ROOT, "assets");

export const PRODUCT = "Reactor";
export const PRODUCT_FULL = "Reactor（数智堆脑）";

/** 侧栏导航：顺序即显示顺序，slug 对应 pages/<slug>.md。 */
export const NAV = [
  {
    group: "开始使用",
    items: [
      { slug: "index", title: "说明书首页", isIndex: true },
      { slug: "welcome", title: "概述与核心能力" },
      { slug: "install", title: "安装与部署" },
      { slug: "model-access", title: "接入模型" },
      { slug: "feedback", title: "反馈与支持" },
    ],
  },
  {
    group: "核心功能",
    items: [
      { slug: "agent", title: "Reactor Agent" },
      { slug: "goal", title: "目标模式" },
      { slug: "memory", title: "项目记忆" },
      { slug: "repo-wiki", title: "仓库百科" },
      { slug: "task-management", title: "任务与文件管理" },
      { slug: "edit-history", title: "编辑历史对话" },
      { slug: "automations", title: "定时任务" },
      { slug: "idle-time-tasks", title: "闲时任务" },
      { slug: "remote-development", title: "远程开发" },
      { slug: "remote-control", title: "手机远控" },
      { slug: "subagents", title: "子智能体" },
      { slug: "browser-use", title: "浏览器自动化" },
    ],
  },
  {
    group: "扩展体系",
    items: [
      { slug: "plugin", title: "插件" },
      { slug: "skill", title: "技能" },
      { slug: "mcp", title: "MCP" },
      { slug: "command", title: "命令" },
      { slug: "hooks", title: "Hooks" },
    ],
  },
  {
    group: "本仓特有功能",
    items: [
      { slug: "interface-modes", title: "界面模式（编程 / 办公 / 审查）" },
      { slug: "review-panel", title: "文件审查板块" },
      { slug: "office-suite", title: "内网办公四件套" },
      { slug: "model-governance", title: "模型治理与开发者模式" },
      { slug: "data-contracts", title: "数据目录与背景主题契约" },
    ],
  },
  {
    group: "内网服务端",
    items: [
      { slug: "server-overview", title: "服务端总览与接线" },
      { slug: "server-delivery", title: "技能与 Agent 下发" },
      { slug: "server-usage-policy", title: "用量上报与策略下发" },
    ],
  },
  {
    group: "帮助",
    items: [
      { slug: "keyboard-shortcuts", title: "快捷键表" },
      { slug: "qa", title: "常见问题" },
      { slug: "linux-wsl", title: "Linux / WSL 排查" },
      { slug: "upstream-diff", title: "与上游 ZCode 的差异" },
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

/** markdown 子集渲染：标题、段落、列表、表格、围栏代码、引用、分隔线。 */
function renderMarkdown(markdown) {
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
      html.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
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

function renderNav(currentSlug) {
  const groups = NAV.map((group) => {
    const items = group.items
      .filter((item) => !item.isIndex)
      .map((item) => {
        const active = item.slug === currentSlug ? ' class="is-active"' : "";
        const label = `<a href="${item.slug}.html"${active}>${escapeHtml(item.title)}</a>`;
        return `<li>${label}</li>`;
      })
      .join("\n");
    return `<section class="nav-group"><h2>${escapeHtml(group.group)}</h2>\n<ul>\n${items}\n</ul></section>`;
  }).join("\n");

  return `<nav class="manual-nav" aria-label="说明书目录">
<a class="nav-home" href="index.html">${escapeHtml(PRODUCT)} 说明书</a>
${groups}
</nav>`;
}

function renderPageShell({ slug, title, body, isIndex }) {
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
<header class="manual-topbar">
  <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="manual-nav">目录</button>
  <span class="brand">${escapeHtml(PRODUCT)}<span class="brand-sub">数智堆脑</span></span>
  <span class="topbar-note">离线说明书 · 依据本仓源码</span>
</header>
<div class="manual-layout">
  <aside class="manual-aside" id="manual-nav">
${renderNav(slug)}
  </aside>
  <main class="manual-main">
<article class="manual-article">
${body}
</article>
<footer class="manual-footer">
  <p>本说明书依据当前检出的源码整理，与上游 ZCode 官方文档可能存在差异，差异见
  <a href="upstream-diff.html">与上游 ZCode 的差异</a>。</p>
</footer>
  </main>
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

  const written = [];
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const markdown = await readFile(path.join(PAGES_DIR, file), "utf8");
    const body = renderMarkdown(markdown);
    const title = titles.get(slug) ?? slug;
    const html = renderPageShell({ slug, title, body, isIndex: slug === "index" });
    await writeFile(path.join(ROOT, `${slug}.html`), html, "utf8");
    written.push(`${slug}.html`);
  }

  const missing = [...titles.keys()].filter((slug) => !files.includes(`${slug}.md`));
  console.log(`已生成 ${written.length} 个页面：${written.join(", ")}`);
  if (missing.length > 0) console.log(`缺少内容文件：${missing.join(", ")}`);
}

await main();
