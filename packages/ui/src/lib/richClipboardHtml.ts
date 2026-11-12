/**
 * 富文本复制：把预览区已渲染 DOM 快照成"内联样式"的 HTML，供粘贴到 Word / 邮件 /
 * 微信公众号编辑器等**只认内联 `style` 属性**的目标。
 *
 * 与 `markdownExportHtml.ts` 的区别：导出用 `<style>` 标签承载样式（自包含 HTML 文件），
 * 而复制到剪贴板时目标编辑器会丢弃 `<style>` 与 class 选择器，必须把样式内联到元素上。
 * 参考 NewMax `WechatPreview` 的 CSS 内联做法。
 *
 * 关键实现点：CSS 选择器（如 `.prose h1`）依赖祖先链，克隆树脱离了原文档会匹配失败；
 * 因此**在原始元素上做 `matches` 判断，把命中声明写到克隆树的对应元素上**，
 * 克隆树只承载输出，原始 DOM 不被污染。
 */

export interface RichClipboardContent {
  /** 内联样式后的 HTML 片段（不含外层容器） */
  html: string;
  /** 纯文本回退，给不支持 text/html 的目标 */
  text: string;
}

/** 顶层样式规则；不深入 @media / @keyframes / @font-face——内联场景没有视口与动画语义。 */
function collectInlineableRules(): CSSStyleRule[] {
  const out: CSSStyleRule[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // 跨域样式表读不到规则，跳过。
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        out.push(rule);
      }
    }
  }
  return out;
}

/** 伪类/伪元素（`:hover`、`::before`）无法内联为目标编辑器可用的静态样式，跳过。 */
function isInlineableSelector(selector: string): boolean {
  return selector.length > 0 && !selector.includes(":");
}

function extractPlainText(root: HTMLElement): string {
  const inner = root.innerText;
  return typeof inner === "string" && inner.length > 0 ? inner : (root.textContent ?? "");
}

/**
 * 构建可写入剪贴板的富文本内容。
 *
 * 纯函数：只读原始 DOM，不改动它；返回的 HTML 可直接作为 `text/html` 剪贴板负载。
 */
export function buildRichClipboardContent(root: HTMLElement): RichClipboardContent {
  const clone = root.cloneNode(true) as HTMLElement;

  // 结构同构：原始树与克隆树按文档顺序一一对应，用 Map 建立"原始 → 克隆"映射。
  const originals: Element[] = [root, ...Array.from(root.querySelectorAll("*"))];
  const clones: Element[] = [clone, ...Array.from(clone.querySelectorAll("*"))];
  const cloneByOriginal = new Map<Element, Element>();
  for (let i = 0; i < originals.length && i < clones.length; i += 1) {
    const original = originals[i];
    const counterpart = clones[i];
    if (original && counterpart) {
      cloneByOriginal.set(original, counterpart);
    }
  }

  const declarationsByClone = new Map<Element, string[]>();
  const pushDeclaration = (target: Element | undefined, cssText: string) => {
    if (!target || !cssText) {
      return;
    }
    const list = declarationsByClone.get(target);
    if (list) {
      list.push(cssText);
    } else {
      declarationsByClone.set(target, [cssText]);
    }
  };

  for (const rule of collectInlineableRules()) {
    const selector = rule.selectorText;
    if (!isInlineableSelector(selector)) {
      continue;
    }

    let matched: Element[];
    try {
      matched = Array.from(root.querySelectorAll(selector));
      // querySelectorAll 只查子树，补上 root 自身。
      if (root.matches(selector)) {
        matched.push(root);
      }
    } catch {
      // 非法或浏览器不支持的选择器，跳过。
      continue;
    }

    for (const element of matched) {
      pushDeclaration(cloneByOriginal.get(element), rule.style.cssText);
    }
  }

  for (const [target, declarations] of declarationsByClone) {
    // 原始内联样式放最前作为基线，规则按文档顺序在后；与 CSS 层叠方向一致。
    const existing = target.getAttribute("style") ?? "";
    const merged = [existing, ...declarations].filter(Boolean).join("; ");
    target.setAttribute("style", merged);
  }

  return { html: clone.innerHTML, text: extractPlainText(root) };
}

/**
 * 把富文本写入系统剪贴板：`text/html` 为主，`text/plain` 作回退。
 * 返回是否写入成功；目标不支持富文本剪贴板 API 时返回 false（调用方可退回纯文本复制）。
 */
export async function writeRichClipboard(content: RichClipboardContent): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    return false;
  }
  try {
    const item = new ClipboardItem({
      "text/html": new Blob([content.html], { type: "text/html" }),
      "text/plain": new Blob([content.text], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch {
    return false;
  }
}
