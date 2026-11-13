/**
 * 表格渲染变体 context。
 *
 * 来源：EvoFlow `zcode-ui/components/ai-elements/markdownTableVariant.tsx`
 * （20 行，Apache-2.0 vendored，随知识库前端一并搬入）。
 *
 * "zcode"（默认）→ ZCode 的表格壳（工具条 + 横向虚拟滚动）；
 * "evoflow"      → EvoFlow 旧表格壳（MD/CSV 复制 + 放大对话框）。
 *
 * 我们只用到默认值 "zcode"；保留该 context 是为了不改知识库页面的
 * `<MarkdownTableVariantProvider>` 调用点。
 */
import { createContext, type ReactNode } from "react";

export const MarkdownTableVariantContext = createContext<"zcode" | "evoflow">("zcode");

export function MarkdownTableVariantProvider({
  value,
  children,
}: {
  value: "zcode" | "evoflow";
  children: ReactNode;
}) {
  return (
    <MarkdownTableVariantContext.Provider value={value}>
      {children}
    </MarkdownTableVariantContext.Provider>
  );
}
