/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/console/ai/datasets/config/retrieval-config/types.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
export type RetrievalConfig = {
  retrievalMode: string;
  strategy?: "weighted_score" | "rerank";
  topK?: number;
  scoreThreshold?: number;
  scoreThresholdEnabled?: boolean;
  weightConfig?: { semanticWeight?: number; keywordWeight?: number };
  rerankConfig?: { enabled?: boolean; modelId?: string };
};

export function buildEmptyRetrievalConfig(mode: string): RetrievalConfig {
  return {
    retrievalMode: mode,
    strategy: "weighted_score",
    topK: 3,
    scoreThreshold: 0.5,
    scoreThresholdEnabled: false,
    weightConfig: { semanticWeight: 0.7, keywordWeight: 0.3 },
    rerankConfig: { enabled: false, modelId: "" },
  };
}
