// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/message/message-context.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../../ui/components/ui/dialog";
import { ScrollArea } from "../../../ui/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../ui/components/ui/tooltip";
import { ListChecks } from "lucide-react";
import { memo, useState } from "react";

export interface MessageContextProps {
  messages: Array<{ role: string; content: string }>;
}

const roleLabel: Record<string, string> = {
  system: "系统",
  user: "用户",
  assistant: "助手",
};

export const MessageContext = memo(function MessageContext({ messages }: MessageContextProps) {
  const [open, setOpen] = useState(false);

  if (!messages?.length) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring inline-flex size-8 items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            onClick={() => setOpen(true)}
          >
            <ListChecks className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>查看对话上下文</p>
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>对话上下文</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">
            发送给模型的完整上下文（含 system、截断历史与当前轮）
          </p>
          <ScrollArea className="h-[400px] rounded-md border p-2 text-sm">
            <div className="space-y-3 pr-2">
              {messages.map((msg, i) => (
                <div key={i} className="space-y-1">
                  <span className="text-muted-foreground font-medium">
                    {roleLabel[msg.role] ?? msg.role}
                  </span>
                  <pre className="bg-muted/50 rounded p-2 text-xs wrap-break-word whitespace-pre-wrap">
                    {msg.content || "(无文本)"}
                  </pre>
                </div>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
});
