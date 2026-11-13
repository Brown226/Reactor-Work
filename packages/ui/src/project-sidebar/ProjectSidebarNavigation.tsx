import { Blocks, Bot, BotMessageSquare, CalendarClock, FolderOpen } from "lucide-react";
import { memo } from "react";
import { TID_AUTOMATIONS_OPEN } from "@zcode/shared/test-ids";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { Button } from "@/components/ui/button.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WebRemoteControlDeviceHeader } from "@/web-remote-control/WebRemoteControlDeviceHeader.js";
import { NavPrimarySlot } from "@/extension-slots/index.js";

/** 顶部导航只展示 Shell 的选中状态，路由仍由 Shell 唯一持有。 */
// 展开偏好会更新侧栏父组件；导航按原 props 和稳定命令隔离，避免无关菜单跟随渲染。
export const ProjectSidebarNavigation = memo(function ProjectSidebarNavigation({
  props,
  onCreate,
}: {
  props: Pick<
    ProjectSidebarProps,
    | "isWebRemoteControl"
    | "onOpenAutomations"
    | "automationsActive"
    | "onOpenPluginStore"
    | "pluginStoreActive"
    | "onOpenMarket"
    | "marketActive"
    | "onOpenBot"
    | "botActive"
    | "onOpenMySpace"
    | "mySpaceActive"
    | "webRemoteControlWorkspaceSwitcher"
    | "navPrimarySlot"
    | "workspacePath"
    | "workspaceIdentity"
    | "workspaceRemoteSessionId"
  >;
  onCreate(): void;
}) {
  const { intl } = useZCodeIntl();
  const deviceNavigation = props.webRemoteControlWorkspaceSwitcher?.deviceNavigation;
  return (
    <div
      data-testid="sidebar-primary-navigation"
      className={`flex flex-col gap-1 px-2 py-3 ${props.isWebRemoteControl && !deviceNavigation ? "max-md:pt-11" : ""}`}
    >
      {/* Relay V2 远控：当前电脑是项目与任务的上一级，放在导航首行；手机端占用原顶部留白。 */}
      {deviceNavigation ? <WebRemoteControlDeviceHeader navigation={deviceNavigation} /> : null}
      <NewTaskButtonGroup onCreateTask={onCreate} />
      {/* 远控主视图会把自动化和插件市场重置为聊天；入口必须一同隐藏，避免点击无效。 */}
      {!props.isWebRemoteControl && props.onOpenAutomations ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.automationsActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.automationsActive ?? false}
          data-testid={TID_AUTOMATIONS_OPEN}
          // 点击事件不能进入业务导航的可选 automationId 参数。
          onClick={() => props.onOpenAutomations?.()}
        >
          <CalendarClock className="size-4" />
          {intl.formatMessage({ id: "workspace.openScheduledSettings" })}
        </Button>
      ) : null}
      {!props.isWebRemoteControl ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.pluginStoreActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.pluginStoreActive ?? false}
          data-testid="plugin-store-sidebar-open"
          onClick={() => props.onOpenPluginStore?.()}
        >
          <Blocks className="size-4" />
          {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
        </Button>
      ) : null}
      {/* [本地定制] Agents 集群：Bot 形态主视图入口。放在导航最前，与样图的
          「Agents 花名册是产品主轴」一致；上游没有这一项，onOpenBot 缺省即不渲染。 */}
      {!props.isWebRemoteControl && props.onOpenBot ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.botActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.botActive ?? false}
          onClick={() => props.onOpenBot?.()}
          data-icon="inline-start"
          data-testid="agents-cluster-open"
        >
          <BotMessageSquare className="size-4" />
          {intl.formatMessage({ id: "bot.nav.title" })}
        </Button>
      ) : null}
      {/* Reactor 定制入口：插件市场 / 我的空间。上游侧栏没有这两项。
          「工作区文件」入口按用户要求下线（文件树仍可从侧边面板打开），见 2026-11-13 反馈。 */}
      {props.onOpenMarket ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.marketActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.marketActive ?? false}
          onClick={() => props.onOpenMarket?.()}
          data-icon="inline-start"
          data-testid="marketplace-open"
        >
          <Bot className="size-4" />
          {intl.formatMessage({ id: "marketplace.title" })}
        </Button>
      ) : null}
      {/* 我的空间只有 Web 宿主会传 onOpenMySpace（桌面端的「我的空间」就是本机文件管理器）。 */}
      {props.onOpenMySpace ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.mySpaceActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.mySpaceActive ?? false}
          onClick={() => props.onOpenMySpace?.()}
          data-icon="inline-start"
          data-testid="my-space-trigger"
        >
          <FolderOpen className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.mySpace" })}
        </Button>
      ) : null}
      {/* 扩展导航条目（nav.primary）：手机远控与「插件市场」一同隐藏；逻辑都在 extension-slots。 */}
      {!props.isWebRemoteControl && props.navPrimarySlot ? (
        <NavPrimarySlot
          workspacePath={props.workspacePath}
          {...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {})}
          {...(props.workspaceRemoteSessionId
            ? { workspaceRemoteSessionId: props.workspaceRemoteSessionId }
            : {})}
          {...props.navPrimarySlot}
        />
      ) : null}
    </div>
  );
});
