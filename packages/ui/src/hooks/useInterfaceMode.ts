import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

/** 当前是否办公档。**仅**用于办公档独有行为，不要当作收敛判据。 */
export function useIsOfficeMode(): boolean {
  return useZCodeStoreWithDefault((state) => state.interfaceMode === "office", false);
}

/**
 * 收敛判据：办公档或审查档。
 *
 * 这两档都要求收纳编程向 UI（终端、git 面板、命令详情、代码 diff），
 * 因此「隐藏编程向入口」的分支一律用本 hook，不要继续用 useIsOfficeMode
 * （否则审查档会漏掉每一处隐藏逻辑，见 docs/interface-mode.md 第 5 节）。
 */
export function useIsFocusedMode(): boolean {
  return useZCodeStoreWithDefault(
    (state) => state.interfaceMode === "office" || state.interfaceMode === "review",
    false,
  );
}

/** 当前是否审查档（文件审查专项工作形态）。 */
export function useIsReviewMode(): boolean {
  return useZCodeStoreWithDefault((state) => state.interfaceMode === "review", false);
}
