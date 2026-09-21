// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/web）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/hooks/use-dialog-manager.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type { DatasetsDocument } from "../../../../../kb-shims/console-services";
import { useCallback, useMemo, useState } from "react";

export type DialogState =
  | { type: "upload" }
  | { type: "member" }
  | { type: "publish" }
  | { type: "editDataset" }
  | {
      type: "editTags";
      mode: "single" | "batch";
      document?: DatasetsDocument;
      documentIds: string[];
    }
  | { type: "transfer"; mode: "move" | "copy"; documentIds: string[] }
  | null;

export interface DialogManager {
  current: DialogState;
  open: (state: NonNullable<DialogState>) => void;
  close: () => void;
}

export function useDialogManager(): DialogManager {
  const [current, setCurrent] = useState<DialogState>(null);

  const open = useCallback((state: NonNullable<DialogState>) => {
    setCurrent(state);
  }, []);

  const close = useCallback(() => {
    setCurrent(null);
  }, []);

  return useMemo(() => ({ current, open, close }), [current, open, close]);
}
