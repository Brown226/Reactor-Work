/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/hooks/use-alert-dialog.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
"use client";

import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";

type AlertDialogOptions = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  media?: React.ReactNode;
  cancelText?: React.ReactNode;
  confirmText?: React.ReactNode;
  cancelVariant?: React.ComponentProps<typeof Button>["variant"];
  confirmVariant?: React.ComponentProps<typeof Button>["variant"];
  size?: "default" | "sm";
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
};

type AlertDialogState = AlertDialogOptions & {
  open: boolean;
  resolve?: (value: boolean) => void;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
};

type AlertDialogContextValue = {
  confirm: (options?: AlertDialogOptions) => Promise<boolean>;
};

const AlertDialogContext = React.createContext<AlertDialogContextValue | null>(null);

/**
 * Provider component that enables imperative AlertDialog usage.
 * Must be placed at the root of your application.
 */
function AlertDialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AlertDialogState>({ open: false });
  const resolvedRef = React.useRef(false);
  const callbacksRef = React.useRef<{
    resolve?: (value: boolean) => void;
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void | Promise<void>;
  }>({});

  const confirm = React.useCallback((options: AlertDialogOptions = {}) => {
    resolvedRef.current = false;
    return new Promise<boolean>((resolve) => {
      callbacksRef.current = {
        resolve,
        onConfirm: options.onConfirm,
        onCancel: options.onCancel,
      };
      setState({
        ...options,
        open: true,
        resolve,
      });
    });
  }, []);

  const handleOpenChange = React.useCallback((open: boolean) => {
    if (!open && !resolvedRef.current) {
      resolvedRef.current = true;
      callbacksRef.current.onCancel?.();
      callbacksRef.current.resolve?.(false);
      setState((prev) => ({ ...prev, open: false }));
    }
  }, []);

  const handleConfirm = React.useCallback(async () => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    await callbacksRef.current.onConfirm?.();
    callbacksRef.current.resolve?.(true);
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  const handleCancel = React.useCallback(async () => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    await callbacksRef.current.onCancel?.();
    callbacksRef.current.resolve?.(false);
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  const contextValue = React.useMemo(() => ({ confirm }), [confirm]);

  return (
    <AlertDialogContext.Provider value={contextValue}>
      {children}
      <AlertDialog open={state.open} onOpenChange={handleOpenChange}>
        <AlertDialogContent
          size={state.size}
          className="max-w-sm data-[size=default]:max-w-sm data-[size=default]:sm:max-w-sm"
        >
          <AlertDialogHeader>
            {state.media && <AlertDialogMedia>{state.media}</AlertDialogMedia>}
            {state.title && <AlertDialogTitle>{state.title}</AlertDialogTitle>}
            {state.description && (
              <AlertDialogDescription>{state.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant={state.cancelVariant} onClick={handleCancel}>
              {state.cancelText ?? "取消"}
            </AlertDialogCancel>
            <AlertDialogAction variant={state.confirmVariant} onClick={handleConfirm}>
              {state.confirmText ?? "确定"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AlertDialogContext.Provider>
  );
}

/**
 * Hook for imperative AlertDialog usage.
 * Returns a confirm function that shows the dialog and returns a Promise.
 * Resolves to true on confirm, rejects on cancel/close.
 *
 * @example
 * ```tsx
 * const { confirm } = useAlertDialog();
 *
 * const handleDelete = async () => {
 *   try {
 *     await confirm({
 *       title: "确认删除？",
 *       description: "此操作不可撤销",
 *       confirmVariant: "destructive",
 *     });
 *     // User confirmed, proceed with deletion
 *   } catch {
 *     // User cancelled
 *   }
 * };
 * ```
 */
function useAlertDialog() {
  const context = React.useContext(AlertDialogContext);

  if (!context) {
    throw new Error("useAlertDialog must be used within an AlertDialogProvider");
  }

  const confirm = React.useCallback(
    async (options?: AlertDialogOptions): Promise<void> => {
      const result = await context.confirm(options);
      if (!result) {
        throw new Error("AlertDialog cancelled");
      }
    },
    [context],
  );

  return { confirm };
}

export { AlertDialogProvider, useAlertDialog };
export type { AlertDialogOptions };
