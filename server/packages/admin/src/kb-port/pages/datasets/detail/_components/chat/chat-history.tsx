// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/web）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/_components/chat/chat-history.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { useDatasetsConversationsQuery } from "../../../../../../kb-shims/console-services";
import { Button } from "../../../../../ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../../../../ui/components/ui/popover";
import { ScrollArea } from "../../../../../ui/components/ui/scroll-area";
import { cn } from "../../../../../ui/lib/utils";
import { History } from "lucide-react";
import { useCallback, useState } from "react";

interface ChatHistoryProps {
  datasetId: string;
  currentConversationId?: string;
  onSelectConversation: (id: string | undefined) => void;
}

export function ChatHistory({
  datasetId,
  currentConversationId,
  onSelectConversation,
}: ChatHistoryProps) {
  const [open, setOpen] = useState(false);

  const { data: conversationsData } = useDatasetsConversationsQuery(
    datasetId,
    { page: 1, pageSize: 30 },
    { enabled: !!datasetId },
  );
  const conversations = conversationsData?.items ?? [];

  const handleSelect = useCallback(
    (id: string) => {
      onSelectConversation(id);
      setOpen(false);
    },
    [onSelectConversation],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon" title="历史记录">
          <History className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start" side="top" sideOffset={4}>
        <ScrollArea className="h-[min(20rem,60vh)]">
          <ul className="p-1 pb-2">
            {conversations.length === 0 ? (
              <li className="text-muted-foreground px-2 py-4 text-center text-sm">暂无对话</li>
            ) : (
              conversations.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(c.id)}
                    className={cn(
                      "hover:bg-muted w-full truncate rounded-md px-2 py-2 text-left text-sm transition-colors",
                      currentConversationId === c.id && "bg-muted",
                    )}
                    title={c.title ?? "无标题"}
                  >
                    {c.title?.trim() || "无标题"}
                  </button>
                </li>
              ))
            )}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
