/**
 * Markdown 导出 HTML 构建（domain 纯函数）。
 *
 * 不重新解析 markdown：直接快照预览区已渲染的 DOM 与运行时样式表，
 * 保证导出结果与预览像素级一致（KaTeX 公式、Mermaid SVG、shiki 高亮零二次实现）。
 * 图片保留 local-file:// 引用：导出窗口在主进程内注册了该协议，加载时自然渲染；
 * docx 路径由 markdownToDocx 单独按需取图片 buffer。
 */

export interface BuildExportHtmlOptions {
  /** 预览根元素（data-markdown-preview 容器或其内容父级） */
  root: HTMLElement;
  /** 文档标题，写入 <title> 与 PDF 元信息 */
  title?: string;
  /** 内容宽度（CSS px），默认 760 */
  width?: number;
}

export interface ExportHtml {
  /** 自包含 HTML 字符串 */
  html: string;
  /** 内容实际高度（CSS px），主进程据此配置全页捕获范围 */
  height: number;
  width: number;
}

/** 固定浅色白底（6.5 决策：三种导出不跟随应用主题）。 */
const EXPORT_BASE_STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body {
  font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
    "Noto Sans SC", "Segoe UI", sans-serif;
  color: #1f2328;
  font-size: 15px;
  line-height: 1.7;
}
img { max-width: 100%; height: auto; }
pre { overflow-x: auto; }
table { border-collapse: collapse; }
`;

/** 递归序列化样式表规则，@media 等分组规则需要下钻，否则快照会丢条件样式。 */
function collectCssRules(rules: CSSRuleList, sink: string[]): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSMediaRule) {
      sink.push(`@media ${rule.conditionText} {`);
      collectCssRules(rule.cssRules, sink);
      sink.push("}");
      continue;
    }
    if (rule instanceof CSSStyleRule) {
      sink.push(rule.cssText);
      continue;
    }
    // @keyframes、@font-face、@supports 等按原文保留
    sink.push(rule.cssText);
  }
}

/** 收集当前文档运行时样式（含运行时注入的 <style>），跨域样式表静默跳过。 */
function collectRuntimeStyles(): string {
  const sink: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collectCssRules(sheet.cssRules, sink);
    } catch {
      /* 跨域样式表读不到规则，跳过 */
    }
  }
  for (const style of Array.from(document.querySelectorAll("style"))) {
    sink.push(style.textContent ?? "");
  }
  return sink.join("\n");
}

export function buildExportHtml(options: BuildExportHtmlOptions): ExportHtml {
  const width = Math.max(320, options.width ?? 760);
  const root = options.root;

  // 用已挂载的根节点量真实高度：克隆节点脱离文档会丢失布局
  const measured =
    root.scrollHeight > 0 ? root.scrollHeight : root.getBoundingClientRect().height;
  const height = Math.max(200, Math.ceil(measured) + 48);

  const snapshot = root.innerHTML;
  const styles = collectRuntimeStyles();
  const title = options.title?.trim() || "export";

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtmlText(title)}</title>
<style>
${EXPORT_BASE_STYLES}
.markdown-export-root {
  width: ${width}px;
  margin: 0 auto;
  padding: 24px 16px 32px;
  background: #ffffff;
}
/* PDF：纸张宽度跟随内容宽度，高度 auto；printBackground 已在主进程开启 */
@page { size: ${width}px auto; margin: 0; }
</style>
<style>
${styles}
</style>
</head>
<body>
<div class="markdown-export-root" data-markdown-export="true">
${snapshot}
</div>
</body>
</html>`;

  return { html, width, height };
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
