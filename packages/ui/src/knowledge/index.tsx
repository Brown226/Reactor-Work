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
 * 本文件做三件事：
 * 1. 把 EvoFlow 的页面组件包成主视图形态（`WorkspaceMainView` 的 "knowledge"）；
 * 2. 确保进入视图时 hash 落在知识库域内（否则 parseOwnedRoute 渲染空态）；
 * 3. **把本仓的模型目录注入给知识库**（见下）。
 *
 * ## 为什么在这里注入模型列表
 *
 * 知识库建库时要选「向量模型」，这个下拉的选项来自 `kb-api.listModels()`。
 * 但知识库 UI 是整包搬来的，拿不到本仓的服务体系（`useServices()` 只能在
 * React 组件里用），所以 `kb-api.ts` 留了一个注入点
 * `setKnowledgeModelProvider()`。
 *
 * **这个注入点之前一直没人调用** —— 后果是 `listModels()` 恒返回空数组，
 * 建库弹窗里「向量模型」下拉是空的，用户只能建纯关键词库。
 *
 * 现在由本组件挂载时注入：从 `providerSettingsService.getView()` 取全量模型，
 * 展平成知识库消费的形状。模型目录的唯一 owner 仍是 provider 体系，
 * 这里不缓存、不另建一份状态 —— 每次调用都现取，provider 改了立刻生效。
 *
 * 适配细节（EvoFlow → Reactor）见 `kb-api.ts` 头部说明。
 */
import { useEffect } from "react";

import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

import KnowledgeOwnedPage from "./knowledge-owned.jsx";
import { setKnowledgeModelProvider, type KnowledgeModelOption } from "./kb-api.js";

/**
 * 判断一个模型是否可用于「向量嵌入」。
 *
 * 本仓的 provider 视图里没有 `capability` 字段，只能按名字猜。规则与
 * EvoFlow `model-classification.js` 的 `collectEmbeddingModelOptions` 一致：
 * 名字里带 embedding / embed / bge / m3 / text-embedding 的都算。
 *
 * 猜错不会致命：knowledge-owned.jsx 还会在自己那侧再过滤一次；
 * 这里放宽一点（宁可多列几个）比漏关键模型好。
 */
function looksLikeEmbeddingModel(name: string, modelId: string): boolean {
  const haystack = `${name} ${modelId}`.toLowerCase();
  return (
    haystack.includes("embedding") ||
    haystack.includes("embed") ||
    haystack.includes("bge") ||
    haystack.includes("m3") ||
    haystack.includes("nomic") ||
    haystack.includes("gte-")
  );
}

export function KnowledgePage(): React.JSX.Element {
  const { providerSettingsService } = useServices();

  // EvoFlow 页面用 hash 路由；进入主视图时确保 hash 落在知识库域内，
  // 否则 parseOwnedRoute 会当成「不在知识库」而渲染空态。
  useEffect(() => {
    const hash = String(window.location.hash || "");
    if (!hash.startsWith("#/knowledge")) {
      window.location.hash = "/knowledge/owned";
    }
  }, []);

  // 注入模型目录。provider 视图是异步的，所以注入的是一个「取数函数」而不是
  // 一份快照 —— 知识库侧每次打开下拉时现调，永远拿到最新配置。
  useEffect(() => {
    setKnowledgeModelProvider(async (): Promise<KnowledgeModelOption[]> => {
      const view = await providerSettingsService.getView();
      const options: KnowledgeModelOption[] = [];
      const seen = new Set<string>();
      for (const provider of view.providers) {
        // only enabled/executable providers offer models that actually work
        if (!provider.enabled || !provider.executable) continue;
        for (const model of provider.models) {
          if (!model.selectable) continue;
          const modelId = String(model.modelId ?? "").trim();
          if (!modelId || seen.has(modelId)) continue;
          // 本仓的模型配置只有 modelId（`properties` 里没有展示名字段），
          // 所以展示名直接用 modelId —— 它本身就是用户配的模型名（如 BAAI/bge-m3）。
          // 只列看起来能算向量嵌入的：知识库的「向量模型」下拉不该出现纯对话模型，
          // 否则用户选了也跑不通。
          if (!looksLikeEmbeddingModel(modelId, modelId)) continue;
          seen.add(modelId);
          options.push({
            name: modelId,
            display_name: modelId,
            model: modelId,
            supportsChat: false,
          });
        }
      }
      return options;
    });

    return () => {
      // 离开知识库视图时撤掉注入，避免别的视图误用。
      setKnowledgeModelProvider(null);
    };
  }, [providerSettingsService]);

  return <KnowledgeOwnedPage />;
}

export default KnowledgePage;
