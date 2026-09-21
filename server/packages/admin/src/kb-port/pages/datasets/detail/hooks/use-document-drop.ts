/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/hooks/use-document-drop.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

type DropPhase = "idle" | "over" | "left";

const isFilesTransfer = (dt: DataTransfer) => dt.types.includes("Files");

interface UseDocumentDropOptions {
  enabled?: boolean;
  onDrop?: (files: File[]) => void;
}

interface UseDocumentDropReturn {
  dropPhase: DropPhase;
  zoneRef: React.RefObject<HTMLDivElement | null>;
  isOver: boolean;
  showDropZone: boolean;
  handlers: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

export function useDocumentDrop({
  enabled = true,
  onDrop,
}: UseDocumentDropOptions = {}): UseDocumentDropReturn {
  const [dropPhase, setDropPhase] = useState<DropPhase>("idle");
  const zoneRef = useRef<HTMLDivElement>(null);

  // 全局拖拽事件监听
  useEffect(() => {
    const hide = () => setDropPhase("idle");

    const onDragLeaveDoc = (e: DragEvent) => {
      if (e.relatedTarget === null) hide();
    };

    const onDragoverDoc = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const cap = true;
    window.addEventListener("dragend", hide, cap);
    document.addEventListener("dragend", hide, cap);
    document.addEventListener("drop", hide, cap);
    document.addEventListener("dragleave", onDragLeaveDoc, cap);

    if (dropPhase === "left") {
      document.addEventListener("dragover", onDragoverDoc, cap);
    }

    return () => {
      window.removeEventListener("dragend", hide, cap);
      document.removeEventListener("dragend", hide, cap);
      document.removeEventListener("drop", hide, cap);
      document.removeEventListener("dragleave", onDragLeaveDoc, cap);
      document.removeEventListener("dragover", onDragoverDoc, cap);
    };
  }, [dropPhase]);

  const onZoneDrag = useCallback((e: React.DragEvent) => {
    if (!isFilesTransfer(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropPhase("over");
  }, []);

  const onZoneLeave = useCallback((e: React.DragEvent) => {
    if (!isFilesTransfer(e.dataTransfer)) return;
    const { current: root } = zoneRef;
    const related = e.relatedTarget as Node | null;
    if (!root || !related || !root.contains(related)) {
      setDropPhase("left");
    }
  }, []);

  const onZoneDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isFilesTransfer(e.dataTransfer)) return;
      e.preventDefault();
      setDropPhase("idle");
      if (e.dataTransfer.files.length > 0) {
        onDrop?.(Array.from(e.dataTransfer.files));
      }
    },
    [onDrop],
  );

  const isOver = dropPhase === "over";
  const showDropZone = enabled && dropPhase === "over";

  return {
    dropPhase,
    zoneRef,
    isOver,
    showDropZone,
    handlers: {
      onDragEnter: onZoneDrag,
      onDragOver: onZoneDrag,
      onDragLeave: onZoneLeave,
      onDrop: onZoneDrop,
    },
  };
}
