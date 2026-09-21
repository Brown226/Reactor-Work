// @ts-nocheck —— 上游原样移植（宽松类型，与 piweb 同一取舍）；改动逐处见移植清单。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/components/ai-elements/attachments.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
"use client";

import { FileFormatIcon } from "../file-format-icon";
import { Button } from "../ui/button";
import { DropdownMenuItem } from "../ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../ui/hover-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { getFileFormatKey } from "../../lib/file-format";
import { cn } from "../../lib/utils";
import type { FileUIPart } from "ai";
import { FileText, ImageIcon, XIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode, RefObject } from "react";
import { createContext, Fragment, useContext } from "react";

export type AttachmentsContext = {
  files: (FileUIPart & { id: string })[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
};

const ProviderAttachmentsContext = createContext<AttachmentsContext | null>(null);
const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

export const useProviderAttachments = () => {
  const ctx = useContext(ProviderAttachmentsContext);
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use useProviderAttachments().",
    );
  }
  return ctx;
};

export const useOptionalProviderAttachments = () => useContext(ProviderAttachmentsContext);

export const usePromptInputAttachments = () => {
  const provider = useOptionalProviderAttachments();
  const local = useContext(LocalAttachmentsContext);
  const context = local ?? provider;
  if (!context) {
    throw new Error(
      "usePromptInputAttachments must be used within a PromptInput or PromptInputProvider",
    );
  }
  return context;
};

export { LocalAttachmentsContext, ProviderAttachmentsContext };

export type PromptInputAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart & { id: string };
  className?: string;
};

/**
 * Render a compact icon for non-image attachments.
 *
 * - Prefer a format icon derived from `data.mediaType`
 * - Fallback to a generic text icon when unknown
 */
function AttachmentFileIcon({ mediaType, className }: { mediaType?: string; className?: string }) {
  const formatKey = getFileFormatKey(mediaType);
  if (formatKey) {
    return <FileFormatIcon format={formatKey} className={className} />;
  }
  return <FileText className={cn("text-muted-foreground", className)} />;
}

export function PromptInputAttachment({ data, className, ...props }: PromptInputAttachmentProps) {
  const attachments = usePromptInputAttachments();
  const filename = data.filename || "";
  const mediaType = data.mediaType?.startsWith("image/") && data.url ? "image" : "file";
  const isImage = mediaType === "image";
  const attachmentLabel = filename || (isImage ? "Image" : "Attachment");

  return (
    <HoverCard openDelay={0} closeDelay={0}>
      <HoverCardTrigger asChild>
        <div
          className={cn(
            "group border-border hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 relative flex h-14 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md border text-sm font-medium transition-all select-none",
            className,
          )}
          key={data.id}
          {...props}
        >
          <div className="relative size-14 shrink-0">
            <div className="bg-background absolute inset-0 flex size-14 items-center justify-center overflow-hidden rounded transition-opacity group-hover:opacity-0">
              {isImage ? (
                <img
                  alt={filename || "attachment"}
                  className="size-14 object-contain"
                  height={56}
                  src={data.url}
                  width={56}
                />
              ) : (
                <div className="text-muted-foreground flex size-14 items-center justify-center">
                  <AttachmentFileIcon mediaType={data.mediaType} className="size-8" />
                </div>
              )}
            </div>
          </div>
          {!isImage ? (
            <div className="flex flex-1 flex-col pr-2">
              <span className="flex-1 truncate">{attachmentLabel}</span>
              <span className="text-muted-foreground">文件</span>
            </div>
          ) : (
            ""
          )}
          <Button
            aria-label="Remove attachment"
            className="bg-background/90 absolute top-1 right-1 size-5 cursor-pointer rounded p-0 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 [&>svg]:size-2.5"
            onClick={(e) => {
              e.stopPropagation();
              attachments.remove(data.id);
            }}
            type="button"
            variant="ghost"
          >
            <XIcon />
            <span className="sr-only">Remove</span>
          </Button>
        </div>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-auto p-2">
        <div className="w-auto space-y-3">
          {isImage && (
            <div className="flex max-h-96 w-96 items-center justify-center overflow-hidden rounded-md border">
              <img
                alt={filename || "attachment preview"}
                className="max-h-full max-w-full object-contain"
                height={384}
                src={data.url}
                width={448}
              />
            </div>
          )}
          <div className="flex items-center gap-2.5">
            <div className="min-w-0 flex-1 space-y-1 px-0.5">
              <h4 className="truncate text-sm leading-none font-semibold">
                {filename || (isImage ? "Image" : "Attachment")}
              </h4>
              {data.mediaType && (
                <p className="text-muted-foreground truncate font-mono text-xs">{data.mediaType}</p>
              )}
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export type PromptInputAttachmentsProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children: (attachment: FileUIPart & { id: string }) => ReactNode;
};

export function PromptInputAttachments({
  children,
  className,
  ...props
}: PromptInputAttachmentsProps) {
  const attachments = usePromptInputAttachments();

  if (!attachments.files.length) {
    return null;
  }

  return (
    <div className={cn("flex w-full flex-wrap items-center gap-2 p-3", className)} {...props}>
      {attachments.files.map((file) => (
        <Fragment key={file.id}>{children(file)}</Fragment>
      ))}
    </div>
  );
}

export type PromptInputActionAddAttachmentsProps = ComponentProps<typeof DropdownMenuItem> & {
  label?: string;
};

export const PromptInputActionAddAttachments = ({
  label = "Add photos or files",
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const attachments = usePromptInputAttachments();

  return (
    <DropdownMenuItem
      {...props}
      onSelect={(e) => {
        e.preventDefault();
        attachments.openFileDialog();
      }}
    >
      <ImageIcon className="mr-2 size-4" /> {label}
    </DropdownMenuItem>
  );
};

export type MessageAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart;
  className?: string;
  onRemove?: () => void;
};

export function MessageAttachment({ data, className, onRemove, ...props }: MessageAttachmentProps) {
  const filename = data.filename || "";
  const mediaType = data.mediaType?.startsWith("image/") && data.url ? "image" : "file";
  const isImage = mediaType === "image";
  const attachmentLabel = filename || (isImage ? "Image" : "Attachment");

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg",
        isImage
          ? "size-24"
          : "border-border hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 flex h-14 w-full max-w-72 items-center gap-1.5 border text-sm font-medium transition-all select-none",
        className,
      )}
      {...props}
    >
      {isImage ? (
        <>
          <img
            alt={filename || "attachment"}
            className="size-full object-cover"
            height={100}
            src={data.url}
            width={100}
          />
          {onRemove && (
            <Button
              aria-label="Remove attachment"
              className="bg-background/80 hover:bg-background absolute top-2 right-2 size-6 rounded-full p-0 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </Button>
          )}
        </>
      ) : (
        <>
          <div className="relative size-14 shrink-0">
            <div className="bg-background absolute inset-0 flex size-14 items-center justify-center overflow-hidden rounded transition-opacity group-hover:opacity-0">
              <div className="text-muted-foreground flex size-14 items-center justify-center">
                <AttachmentFileIcon mediaType={data.mediaType} className="size-8" />
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col pr-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex-1 truncate">{attachmentLabel}</span>
              </TooltipTrigger>
              <TooltipContent>
                <p>{attachmentLabel}</p>
              </TooltipContent>
            </Tooltip>
            <span className="text-muted-foreground">文件</span>
          </div>
          {onRemove && (
            <Button
              aria-label="Remove attachment"
              className={cn(
                "bg-background/90 absolute top-1 right-1 size-5 cursor-pointer rounded p-0 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 [&>svg]:size-2.5",
                "hover:bg-accent",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export type MessageAttachmentsProps = ComponentProps<"div">;

export function MessageAttachments({ children, className, ...props }: MessageAttachmentsProps) {
  if (!children) {
    return null;
  }

  return (
    <div className={cn("ml-auto flex w-fit flex-wrap items-start gap-2", className)} {...props}>
      {children}
    </div>
  );
}
