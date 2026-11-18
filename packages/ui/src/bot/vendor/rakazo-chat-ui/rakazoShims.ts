import { parse } from "tldts";

/**
 * [本地定制] Rakazo chat-ui 的依赖垫片。
 *
 * 来源：[elie222/rakazo](https://github.com/elie222/rakazo) 的
 * `packages/chat-ui/src/`（Apache-2.0，见同目录 LICENSE-rakazo.txt）。
 *
 * 上游那几个文件引用了三个内部包：
 *   @rakazo/contracts  → droppedTableHtmlText（40 行纯函数）
 *   @rakazo/ui-tokens  → cssVariableName / pageIconBars（一个函数 + 一个数组）
 *   @rakazo/ui-web     → AlertDialog 一组 + useCopyText
 *
 * 这里用**最小可用实现**顶替，不搬整包：
 * - 前两个是纯逻辑，直接内联，行为与上游一致。
 * - ui-web 的部分在 `rakazoUiWeb.jsx` 里用 Reactor 已有组件重新实现。
 *
 * 这个文件的存在意味着：升级 Rakazo chat-ui 时只需重新拷 vendor/rakazo-chat-ui/，
 * 本文件保持不动即可（除非上游新增了依赖）。
 */

/* ------------------------------------------------------------------ *
 * @rakazo/contracts → packages/contracts/src/text/markdown-text.ts
 * ------------------------------------------------------------------ */

/**
 * 表格单元格里被渲染器丢弃的原始 HTML 仍然贡献文本：
 * web 渲染器把 `<br>` 变成空格、把 `<img alt>` 变成它的 alt 文本。
 * 引用校验需要在服务端重建同一份规范文本，所以这段还原语义两端共享。
 *
 * 与上游逐行一致（含属性解析与实体解码）。
 */
export function droppedTableHtmlText(html) {
  if (/^<br[\s/>]/i.test(html)) return " ";
  const image = html.match(/^<img(?=[\s/>])((?:[^"'<>]|"[^"]*"|'[^']*')*)>/i);
  if (!image) return null;
  // 完整消费属性，避免属性名或带引号的值冒充 alt。
  const attributes = image[1]?.matchAll(
    /\s([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  );
  for (const attribute of attributes ?? []) {
    if (attribute[1]?.toLowerCase() === "alt") {
      return decodeHtmlEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
  }
  return null;
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: "\u00a0",
    quot: '"',
  };
  return value.replace(
    /&(#(?:x[\da-f]+|\d+)|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, code) => {
      if (!code.startsWith("#")) return named[code.toLowerCase()] ?? entity;
      const point = Number.parseInt(
        code.slice(code[1]?.toLowerCase() === "x" ? 2 : 1),
        code[1]?.toLowerCase() === "x" ? 16 : 10,
      );
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
    },
  );
}


/* ------------------------------------------------------------------ *
 * @rakazo/core/egress → packages/core/src/primitives/egress.ts
 * ------------------------------------------------------------------ */

/**
 * 一个 http(s) URL 会被发往哪个「站点」（可注册域名，IP 字面量则用地址本身）。
 * 与上游同语义：所有子域属于同一站点，共享主机（github.io）的每个租户各算一站。
 * urlSite 只被 markdown 的链接展示用到，不需要 tldts 的私有后缀分支。
 */
export function urlSite(input) {
  const url = httpUrl(input);
  return url ? hostSite(url.hostname) : undefined;
}

function httpUrl(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
}

function hostSite(hostname) {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return undefined;
  // 复用 Reactor 已装的 tldts：取可注册域名；解析不出（IP、非法标签）就用主机名本身。
  const parsed = parse(host, { allowPrivateDomains: true, validateHostname: false });
  if (parsed.isIp || host.startsWith("[")) return host;
  return parsed.domain ?? host;
}


/**
 * 一组颜色 token（Mermaid 图表配色用）。
 *
 * 上游这里是 px 级的品牌调色板；Reactor 已经有一套语义色变量，所以直接映射到
 * CSS 变量字符串——Mermaid 接受 `var(--x)`，深浅主题会跟着 Reactor 自动切换，
 * 不需要在这里维护两套十六进制。
 */
export function webTokensForAppearance(_appearance) {
  return {
    accent: "var(--color-primary, #2563eb)",
    card: "var(--color-surface, #ffffff)",
    foreground: "var(--color-foreground, #111827)",
    muted: "var(--color-muted, #f3f4f6)",
    mutedForeground: "var(--color-foreground-subtle, #6b7280)",
    secondary: "var(--color-secondary, #e5e7eb)",
    destructiveFill: "var(--color-destructive, #dc2626)",
    destructiveForeground: "#ffffff",
  };
}

/* ------------------------------------------------------------------ *
 * @rakazo/ui-tokens → packages/ui-tokens/src/index.ts
 * ------------------------------------------------------------------ */

/** CamelCase token 名 → CSS 自定义属性名（c1 → --c1，inkMuted → --ink-muted）。 */
export function cssVariableName(token) {
  return `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** Bot 自建页面的柱状图标配色（与上游同值）。 */
export const pageIconBars = ["#489D61", "#E7712E", "#BC3B3D", "#3E82F3"];
