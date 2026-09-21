// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/web）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/libs/provider-converter.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type { AiProvider } from "../../../kb-shims/console-services";

import type { Model } from "../types";

export function convertProvidersToModels(providers: AiProvider[]): Model[] {
  const models: Model[] = [];
  const modelMap = new Map<string, Model>();

  providers.forEach((provider) => {
    if (!provider.models || provider.models.length === 0) {
      return;
    }

    provider.models.forEach((model) => {
      if (!model.isActive) {
        return;
      }

      const modelKey = model.model || model.id;

      if (modelMap.has(modelKey)) {
        const existingModel = modelMap.get(modelKey)!;
        if (!existingModel.providers.includes(provider.provider)) {
          existingModel.providers.push(provider.provider);
        }
      } else {
        const newModel: Model = {
          id: model.id,
          name: model.name,
          chef: provider.name,
          chefSlug: provider.provider,
          providers: [provider.provider],
          providerSortOrder: provider.sortOrder,
          providerCreatedAt: provider.createdAt,
          features: model.features,
          thinking: model.thinking,
          enableThinkingParam: model.enableThinkingParam,
          billingRule: model.billingRule,
          iconUrl: provider.iconUrl,
          membershipLevel: model.membershipLevel,
        };
        modelMap.set(modelKey, newModel);
        models.push(newModel);
      }
    });
  });

  return models;
}
