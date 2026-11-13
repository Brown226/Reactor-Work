/**
 * 知识库主视图入口。
 *
 * ## 为什么是薄壳
 *
 * EvoFlow 的 `knowledge-owned.jsx`（4245 行）是**页面级组件**：自带 hash 路由解析
 * （`parseOwnedRoute` 读 `window.location.hash`）、列表/详情两种形态、以及全部
 * 模态框。它不接收 props、不依赖外部 router，所以在我们的 `WorkspaceShellLayout`
 * 里只要挂上即可。
 *
 * 本文件只做两件事：
 * 1. 把 EvoFlow 的页面组件包成我们的主视图形态（`WorkspaceMainView` 的 "knowledge"）；
 * 2. 确保进入视图时 hash 落在知识库域内（否则 parseOwnedRoute 渲染空态）。
 *
 * 适配细节（EvoFlow → Reactor）见 `kb-api.ts` 头部说明。
 */
import { useEffect } from "react";

import KnowledgeOwnedPage from "./knowledge-owned.jsx";

export function KnowledgePage(): React.JSX.Element {
  // EvoFlow 页面用 hash 路由；进入主视图时确保 hash 落在知识库域内，
  // 否则 parseOwnedRoute 会当成「不在知识库」而渲染空态。
  useEffect(() => {
    const hash = String(window.location.hash || "");
    if (!hash.startsWith("#/knowledge")) {
      window.location.hash = "/knowledge/owned";
    }
  }, []);

  return <KnowledgeOwnedPage />;
}

export default KnowledgePage;
