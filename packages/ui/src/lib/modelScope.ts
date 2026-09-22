/**
 * 模型可见性收敛：企业会话激活时，聊天里可选的模型 = 服务端下发的目录。
 *
 * 这是**唯一的过滤点**：输入只有"目录"与"是否解锁开发者模式"，不读其它状态，
 * 避免出现第二套"当前是否企业模式"的判断。语义与验收场景见
 * `docs/model-governance-and-dev-mode.md`。
 *
 * 边界：
 * - `enterpriseModels` 为 `null` 或空 = 不限制（未登录企业服务端 / 目录同步中 / 已解锁开发者模式）；
 * - 过滤按**模型 id**匹配，provider 里没有命中目录的模型时该 provider 直接不参与展示；
 * - 若过滤后一个模型都不剩（目录与服务端配置短暂不一致），回退为不过滤——不把选择器清空，
 *   否则用户会看到一个空菜单却不知道发生了什么。
 */
import type { ModelSelectionView } from "@zcode/provider";

export function resolveEnterpriseModelScope(options: {
  /** 服务端下发的可用模型 id；`null`/空数组表示不限制。 */
  enterpriseModels: readonly string[] | null;
  devModeUnlocked: boolean;
}): ReadonlySet<string> | null {
  if (options.devModeUnlocked) return null;
  if (!options.enterpriseModels || options.enterpriseModels.length === 0) return null;
  return new Set(options.enterpriseModels);
}

export function scopeModelSelectionView(
  view: ModelSelectionView | null,
  allowedModels: ReadonlySet<string> | null,
): ModelSelectionView | null {
  if (!view || !allowedModels) return view;

  const providers = view.providers
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => allowedModels.has(model.modelId)),
    }))
    .filter((provider) => provider.models.length > 0);

  return providers.length === 0 ? view : { ...view, providers };
}
