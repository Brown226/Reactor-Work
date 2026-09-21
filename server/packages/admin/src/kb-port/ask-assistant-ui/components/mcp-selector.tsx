// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/hooks, @buildingai/services/web）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/mcp-selector.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { useSettingsDialog } from "../../../kb-shims/ui";
import type { McpServer, McpServerType } from "../../../kb-shims/console-services";
import { PromptInputButton as AIPromptInputButton } from "../../ui/components/ai-elements/prompt-input";
import SvgIcons from "../../ui/components/svg-icons";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "../../ui/components/ui/avatar";
import { Badge } from "../../ui/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../../ui/components/ui/command";
import { InputGroupButton } from "../../ui/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "../../ui/components/ui/tabs";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

export interface McpSelectorProps {
  mcpServers: McpServer[];
  selectedMcpServerIds: string[];
  onSelectionChange: (ids: string[]) => void;
}

export const McpSelector = memo(
  ({ mcpServers, selectedMcpServerIds, onSelectionChange }: McpSelectorProps) => {
    const [open, setOpen] = useState(false);
    const [filterType, setFilterType] = useState<McpServerType | "all">("all");

    const selectedServers = useMemo(
      () => mcpServers.filter((server) => selectedMcpServerIds.includes(server.id)),
      [mcpServers, selectedMcpServerIds],
    );

    const systemServers = useMemo(
      () => mcpServers.filter((server) => server.type === "system"),
      [mcpServers],
    );

    const userServers = useMemo(
      () => mcpServers.filter((server) => server.type === "user"),
      [mcpServers],
    );

    const handleToggle = (serverId: string) => {
      const isSelected = selectedMcpServerIds.includes(serverId);
      if (isSelected) {
        onSelectionChange(selectedMcpServerIds.filter((id) => id !== serverId));
      } else {
        onSelectionChange([...selectedMcpServerIds, serverId]);
      }
    };

    const { open: openSettingsDialog } = useSettingsDialog();

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <AIPromptInputButton
            className={selectedServers.length > 0 ? "bg-accent text-accent-foreground" : undefined}
          >
            <SvgIcons.mcp className="size-4" />
            {selectedServers.length > 0 ? (
              <AvatarGroup className="ml-1">
                {selectedServers.slice(0, 3).map((server) => (
                  <Avatar key={server.id} className="size-5 rounded-sm after:rounded-sm">
                    {server.icon ? (
                      <AvatarImage className="rounded-sm" src={server.icon} alt={server.name} />
                    ) : null}
                    <AvatarFallback className="rounded-sm text-xs">
                      {server.name?.slice(0, 1).toUpperCase() || "M"}
                    </AvatarFallback>
                  </Avatar>
                ))}
                {selectedServers.length > 3 && (
                  <AvatarGroupCount className="rounded-sm text-xs">
                    +{selectedServers.length - 3}
                  </AvatarGroupCount>
                )}
              </AvatarGroup>
            ) : (
              <span>工具</span>
            )}
            <ChevronDownIcon className="text-muted-foreground size-4" />
          </AIPromptInputButton>
        </PopoverTrigger>
        <PopoverContent className="w-70 p-0" align="center">
          <Command>
            <div className="flex items-center gap-1 p-1 pb-0">
              <div className="flex-1">
                <CommandInput placeholder="搜索 MCP 服务器..." className="h-7" />
              </div>
              <InputGroupButton
                size="icon-sm"
                variant="outline"
                className="mt-1 size-8 shrink-0 rounded-lg border-dashed p-0"
                onClick={() => {
                  openSettingsDialog("tools");
                }}
              >
                <PlusIcon className="size-4" />
              </InputGroupButton>
            </div>
            <div className="px-2 py-1.5">
              <Tabs
                value={filterType}
                onValueChange={(value) => setFilterType(value as McpServerType | "all")}
              >
                <TabsList variant="line" className="w-full border-b">
                  <TabsTrigger value="all" className="flex-1">
                    全部({mcpServers.length})
                  </TabsTrigger>
                  <TabsTrigger value="system" className="flex-1">
                    系统({systemServers.length})
                  </TabsTrigger>
                  <TabsTrigger value="user" className="flex-1">
                    我的({userServers.length})
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <CommandList>
              <CommandEmpty className="text-muted-foreground text-xs">未找到 MCP 服务</CommandEmpty>
              {(filterType === "all" || filterType === "system") && systemServers.length > 0 && (
                <>
                  <CommandGroup
                    heading={filterType === "all" ? `系统服务(${systemServers.length})` : undefined}
                  >
                    {systemServers.map((server) => {
                      const isSelected = selectedMcpServerIds.includes(server.id);
                      return (
                        <CommandItem
                          key={server.id}
                          onSelect={() => handleToggle(server.id)}
                          className="data-checked:bg-muted! data-checked:text-foreground! data-checked:**:[svg]:text-foreground! flex cursor-pointer items-center gap-2 data-selected:bg-transparent data-selected:text-inherit data-selected:**:[svg]:text-inherit"
                          data-checked={isSelected}
                        >
                          <Avatar className="size-7 rounded-sm after:rounded-sm">
                            {server.icon ? (
                              <AvatarImage
                                className="rounded-sm"
                                src={server.icon}
                                alt={server.name}
                              />
                            ) : null}
                            <AvatarFallback className="rounded-sm text-xs">
                              {server.name?.slice(0, 1).toUpperCase() || "M"}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex flex-1 flex-col gap-0.5">
                            <span className="text-sm font-medium">{server.name}</span>
                            {server.description && (
                              <span className="text-muted-foreground line-clamp-1 text-xs">
                                {server.description}
                              </span>
                            )}
                          </div>
                          {server.tools && server.tools.length > 0 && (
                            <CommandShortcut>
                              <Badge variant="outline" className="text-xs">
                                {server.tools.length} 工具
                              </Badge>
                            </CommandShortcut>
                          )}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </>
              )}
              {(filterType === "all" || filterType === "user") && userServers.length > 0 && (
                <CommandGroup
                  heading={filterType === "all" ? `我的服务(${userServers.length})` : undefined}
                >
                  {userServers.map((server) => {
                    const isSelected = selectedMcpServerIds.includes(server.id);
                    return (
                      <CommandItem
                        key={server.id}
                        onSelect={() => handleToggle(server.id)}
                        className="data-checked:bg-muted! data-checked:text-foreground! data-checked:**:[svg]:text-foreground! flex cursor-pointer items-center gap-2 data-selected:bg-transparent data-selected:text-inherit data-selected:**:[svg]:text-inherit"
                        data-checked={isSelected}
                      >
                        <Avatar className="size-7 rounded-sm after:rounded-sm">
                          {server.icon ? (
                            <AvatarImage
                              className="rounded-sm"
                              src={server.icon}
                              alt={server.name}
                            />
                          ) : null}
                          <AvatarFallback className="rounded-sm text-xs">
                            {server.name?.slice(0, 1).toUpperCase() || "M"}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex flex-1 flex-col gap-0.5">
                          <span className="text-sm font-medium">{server.name}</span>
                          {server.description && (
                            <span className="text-muted-foreground line-clamp-1 text-xs">
                              {server.description}
                            </span>
                          )}
                        </div>
                        {server.tools && server.tools.length > 0 && (
                          <CommandShortcut>
                            <Badge variant="outline" className="text-xs">
                              {server.tools.length} 工具
                            </Badge>
                          </CommandShortcut>
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  },
);

McpSelector.displayName = "McpSelector";
