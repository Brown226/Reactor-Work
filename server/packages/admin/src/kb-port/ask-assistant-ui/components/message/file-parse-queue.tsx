// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/message/file-parse-queue.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
"use client";

import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "../../../ui/components/ai-elements/task";
import { cn } from "../../../ui/lib/utils";
import type { UIMessage } from "ai";
import { ChevronDownIcon, FileSearchIcon, FileTextIcon, LoaderIcon } from "lucide-react";

type FileParseProgress = {
  stage?: string;
  message?: string;
  progress?: number;
  current?: number;
  total?: number;
};

type FileParseMetadata = {
  filename?: string;
  filetype?: string;
  size?: number;
};

type FileParseProgressPart = {
  type: "data-file-parse-progress";
  data: FileParseProgress;
};

type FileParseMetadataPart = {
  type: "data-file-parse-metadata";
  data: FileParseMetadata;
};

type FileParseQueueProps = {
  messageId: string;
  parts?: UIMessage["parts"];
  isStreaming?: boolean;
};

const formatBytes = (value?: number) => {
  if (!value || Number.isNaN(value)) return undefined;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
};

type UIMessagePart = NonNullable<UIMessage["parts"]>[number];

const isFileParseProgressPart = (part: UIMessagePart): part is FileParseProgressPart => {
  return (
    typeof part === "object" &&
    part !== null &&
    "data" in part &&
    part.type === "data-file-parse-progress"
  );
};

const isFileParseMetadataPart = (part: UIMessagePart): part is FileParseMetadataPart => {
  return (
    typeof part === "object" &&
    part !== null &&
    "data" in part &&
    part.type === "data-file-parse-metadata"
  );
};

const toProgressParts = (parts?: UIMessage["parts"]): FileParseProgressPart[] =>
  (parts ?? []).filter(isFileParseProgressPart);

const toMetadataParts = (parts?: UIMessage["parts"]): FileParseMetadataPart[] =>
  (parts ?? []).filter(isFileParseMetadataPart);

export const FileParseQueue = ({ messageId, parts, isStreaming }: FileParseQueueProps) => {
  const progressParts = toProgressParts(parts);
  const metadataParts = toMetadataParts(parts);
  const latestMetadata = metadataParts.at(-1)?.data;
  const latestProgress = progressParts.at(-1)?.data;

  if (progressParts.length === 0 && metadataParts.length === 0) return null;

  const hasCompleted =
    latestProgress?.stage === "complete" ||
    latestProgress?.progress === 100 ||
    progressParts.length === 0;
  const defaultOpen = Boolean(isStreaming) || !hasCompleted;

  // Calculate progress percentage
  const getProgressPercentage = (progress?: FileParseProgress): number | undefined => {
    if (progress?.progress !== undefined) {
      return progress.progress;
    }
    if (progress?.current !== undefined && progress?.total !== undefined && progress.total > 0) {
      return Math.round((progress.current / progress.total) * 100);
    }
    return undefined;
  };

  const progressPercentage = getProgressPercentage(latestProgress);
  const title = progressPercentage !== undefined ? `文件解析完成` : "文件解析中";
  const Icon = hasCompleted ? FileSearchIcon : LoaderIcon;

  return (
    <Task className="mb-2" defaultOpen={defaultOpen}>
      <TaskTrigger title={title}>
        <div className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-2 text-sm transition-colors">
          <Icon className={cn("size-4", !hasCompleted && "animate-spin")} />
          <p className="text-sm">{title}</p>
          <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </div>
      </TaskTrigger>
      <TaskContent>
        {latestMetadata && (
          <div className="text-muted-foreground mb-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              {latestMetadata.filename && (
                <TaskItemFile>
                  <FileTextIcon className="size-4" />
                  <span>{latestMetadata.filename}</span>
                </TaskItemFile>
              )}
              {latestMetadata.filetype && (
                <span className="bg-muted rounded border px-2 py-1">
                  {latestMetadata.filetype.toUpperCase()}
                </span>
              )}
              {latestMetadata.size !== undefined && (
                <span className="bg-muted rounded border px-2 py-1">
                  {formatBytes(latestMetadata.size)}
                </span>
              )}
            </div>
          </div>
        )}

        {progressParts.length > 0 &&
          progressParts.map((part, index) => {
            const progress = part.data;
            const message = progress?.message?.trim() || progress?.stage || "处理中";
            const percentage = getProgressPercentage(progress);

            // Remove percentage from message if it's already in the format
            const cleanMessage = message.replace(/\s*\(\d+\s*\/\s*\d+\)\s*/, "").trim();
            return (
              <TaskItem key={`${messageId}-file-parse-${index}`}>
                {percentage !== undefined ? (
                  <span>
                    {cleanMessage} {percentage}%
                  </span>
                ) : (
                  <span>{cleanMessage}</span>
                )}
              </TaskItem>
            );
          })}
      </TaskContent>
    </Task>
  );
};
