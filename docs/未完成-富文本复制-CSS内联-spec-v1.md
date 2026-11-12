# 复制富文本（CSS 内联）— spec v1

## 背景与现状核验（重要）

来源：NewMax `WechatPreview` 的在线模板渲染管线（unified/remark + **CSS 内联** +
导出）。**核验后必须区分**：

- **导出文件（PNG / PDF / DOCX）+ 样式化 HTML：Reactor 已实现。**
  `packages/ui/src/lib/markdownExportHtml.ts`（DOM 快照 + 运行时样式表快照，生成自包含
  HTML）+ `hooks/useMarkdownExport.ts` + 主进程离屏渲染/printToPDF/saveFile。
  方案见 `docs/已完成/已完成-Markdown导出-方案-v2.md`（2026-09-28 归档）。**不重复造。**
- **复制富文本到剪贴板：Reactor 缺口。** 现有导出的 HTML 用 `<style>` 标签承载样式；
  而粘贴到 Word / 邮件 / 微信公众号编辑器时，目标编辑器只认**内联 `style` 属性**，
  不认 `<style>` 标签与 class 选择器（会丢样式）。全仓无 CSS 内联 / `ClipboardItem`
  富文本写入。

本项只补"复制富文本"。

## 产品规则

1. 提供"复制为富文本"：把预览区已渲染 DOM 快照 + 运行时样式**内联成 `style` 属性**，
   写入剪贴板 `text/html`，并同时写 `text/plain` 纯文本回退。
2. **样式匹配基于原始 DOM**：选择器（如 `.prose h1`、`#root .x`）依赖祖先链，
   克隆树脱离了原文档会匹配失败。因此遍历"原始元素"做 `matches`，
   把结果写到"克隆元素"的 `style` 上，克隆树只承载输出。
3. **跳过无法内联的选择器**：含 `:`（伪类/伪元素 `:hover`/`::before`）、
   以及 `@media`/`@keyframes`/`@font-face` 等分组规则的内部样式。
4. 内联后保留元素原有 `style`，新声明追加其后（原有优先级更高，符合"用户手动样式优先")。
5. 纯前端、同步、纯函数（`document` 可注入），不依赖主进程、不新增 IPC。

## 状态所有者

- 无状态：`buildRichClipboardHtml(root, doc)` 是纯函数，输入 DOM 输出字符串。
- 剪贴板写入在 hook 内一次性完成，失败只 toast，不改其它状态。

## 验收场景

- [ ] 预览 Markdown（含标题/列表/表格/代码块）→ 复制富文本 → 粘贴到 Word 保留层级与等宽代码。
- [ ] 粘贴到纯文本编辑器得到可读纯文本（`text/plain` 回退）。
- [ ] 剪贴板 HTML 中关键元素带 `style="..."`，不含 `<style>` 标签。
- [ ] 预览 DOM 未被内联过程污染（只在克隆上改属性）。

## 遗留（如实记录）

- 本地图片（`local-file://`）在粘贴到外部编辑器时不可用（外部编辑器读不到该协议），
  需 dataURL 转换才彻底；本期未做，列为遗留。

## 验证口径

UI 逻辑改动 → 全量 `pnpm typecheck` + `pnpm lint`。剪贴板行为需真实运行验证，
本项以编译 + lint 通过为准，如实注明。
