/**
 * [本地定制] Agents 集群主视图 —— DS-Bot 完整前端的 Reactor 挂载点。
 *
 * 上游 `app/ui/src/main.js` 做四件事；这里在 React 里等价重做：
 * 1. 装载 DS-Bot 自己的 12 份样式表（`installStyles`）
 * 2. 装语言包（`installLocale`）
 * 3. 应用团队的配色与主题（`themeCss` + `body[data-ds-dark-theme]`）
 * 4. 渲染它的 `<App/>`（内含侧栏、聊天、覆盖层）
 *
 * 与上游唯一的差别：它挂到 `#root` 上接管整个窗口，这里挂在 Reactor 主区里，
 * 所以不接管 body 背景、不接管 `#root` 尺寸（那些由 Reactor 的壳决定）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { generateTraceId } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { App as DsBotApp } from "@/bot/shell/app.js";
import { createLocale } from "@/bot/shell/locale.js";
import { createBotStore, botStore } from "@/bot/adapters/botStore.js";
import { installLocale } from "@/bot/vendor/ds-bot-client/i18n.js";
import { installStyles } from "@/bot/vendor/ds-bot-client/styles.js";
import { ABOUT_CSS } from "@/bot/vendor/ds-bot-client/about.js";
import { BOT_SETTINGS_CSS } from "@/bot/vendor/ds-bot-client/bot-settings.js";
import { FEEDBACK_CSS } from "@/bot/vendor/ds-bot-client/feedback.js";
import { FOLDER_CSS } from "@/bot/vendor/ds-bot-client/folder-menu.js";
import { GROUP_SETTINGS_CSS } from "@/bot/vendor/ds-bot-client/group-settings.js";
import { MEMBER_CSS } from "@/bot/vendor/ds-bot-client/member-status.js";
import { MODEL_CSS } from "@/bot/vendor/ds-bot-client/model-menu.js";
import { PROVIDERS_CSS } from "@/bot/vendor/ds-bot-client/providers-page.js";
import { SCHEDULE_CSS } from "@/bot/vendor/ds-bot-client/schedules.js";
import { SECRET_CSS } from "@/bot/vendor/ds-bot-client/secret-card.js";
import { SIDEBAR_CSS } from "@/bot/vendor/ds-bot-client/sidebar.js";
import { CONVERSATION_CSS, SHELL_CSS } from "@/bot/vendor/ds-bot-client/styles.js";
import { USAGE_CSS } from "@/bot/vendor/ds-bot-client/usage-page.js";
import "@/bot/vendor/ds-bot-app.css";

/** 上游 main.js 的样式清单，顺序保持一致（后装的覆盖先装的）。 */
const SHEETS = [
  ["shell", SHELL_CSS],
  ["sidebar", SIDEBAR_CSS],
  ["conversation", CONVERSATION_CSS],
  ["secrets", SECRET_CSS],
  ["providers", PROVIDERS_CSS],
  ["models", MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + GROUP_SETTINGS_CSS],
  ["usage", USAGE_CSS],
  ["schedules", SCHEDULE_CSS],
  ["feedback", FEEDBACK_CSS],
  ["about", ABOUT_CSS],
  ["members", MEMBER_CSS],
];

export function BotClusterView({
  workspacePath,
  workspaceIdentity,
  onExit,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 返回 Reactor 对话主视图。外层侧栏在本视图下是收起的，必须留这条路径。 */
  onExit?: () => void;
}) {
  const services = useServices();
  const { locale } = useZCodeIntl();
  const installed = useRef(false);
  const [isDark, setIsDark] = useState(false);

  // 1) 样式 + 语言：全局只装一次，重复安装会堆叠 <style>。
  useEffect(() => {
    if (installed.current) return;
    installed.current = true;
    installLocale(createLocale(locale));
    document.documentElement.lang = locale;
    for (const [tag, text] of SHEETS) installStyles(text, tag);
  }, [locale]);

  // 2) store：Agent = VirtualProject，话题 = 该项目下的 task（见 adapters/botStore.ts）。
  const store = useMemo(() => {
    const projectService = services.projectService;
    if (!projectService) {
      // 手机远控 / 旧 Host 可能不装配 projectService；Agents 集群完全建立在它上面，
      // 缺省时不给半成品状态，直接抛错交给上层错误边界显示。
      throw new Error("Agents 集群需要 projectService，当前宿主未装配");
    }
    const taskGroupService = services.taskGroupService;
    if (!taskGroupService) {
      // 群聊建立在 Reactor 的 TaskGroupService 上；缺它时群聊不可用，直接说清楚。
      throw new Error("Agents 集群的群聊需要 taskGroupService，当前宿主未装配");
    }
    const instance = createBotStore({
      projectService,
      taskGroupService,
      workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        // 会话列表直接复用项目树的组织字段，不另开查询。
        listTasks: async () => {
          const tree = await projectService.readTree();
          return tree.tasks.map((task) => ({
            taskId: task.taskId,
            projectId: task.projectId,
            updatedAt: task.updatedAt,
            pinned: task.pinned,
            archived: task.archived,
          }));
        },
        createTask: async ({ projectId }) => {
          // 建空会话：沿用 Reactor 的建任务入口，标题留空由首条消息决定。
          const created = await services.zcodeTaskService.createTask({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            projectId,
          });
          return created.taskId;
        },
        sendMessage: async ({ taskId, text }) => {
          await services.zcodeTaskService.sendPrompt({
            taskId,
            content: text,
            traceId: generateTraceId(taskId),
          });
        },
        readChat: async ({ taskId, cursor }) => {
          // 上游 chat 端点按 cursor 向前翻页；Reactor 用 afterMessageId 表达同一件事。
          // cursor 为空 = 首页（最新一段），视图不会因为拿不到旧页而异常。
          const messages = await services.zcodeSessionService.readSessionMessages({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            sessionId: taskId,
            ...(cursor ? { afterMessageId: cursor } : {}),
          });
          return {
            sessionId: taskId,
            items: toDsBotChatItems(messages),
            // Reactor 侧返回全部历史，没有更早一页；null 表示到底。
            cursor: null,
          };
        },
        listProviders: async () => {
          const view = await services.modelSelectionService.getView();
          return (view?.providers ?? []).map((provider) => ({
            providerId: provider.providerId,
            providerName: provider.providerName,
            // needsKey：Reactor 用 config 判断是否缺密钥；这里只取「模板要求」这一项，
            // 避免把账号态（登录后才知）泄漏给 Bot 视图。
            needsKey: Boolean((provider.config as { needsKey?: boolean } | undefined)?.needsKey),
            models: (provider.models ?? []).map((model) => ({
              modelId: model.modelId,
              // DS-Bot 的 label 是展示名；Reactor 的展示名在 model.config 里。
              label:
                (model.config as { label?: string; displayName?: string } | undefined)?.label ??
                (model.config as { label?: string; displayName?: string } | undefined)
                  ?.displayName ??
                model.modelId,
            })),
          }));
        },
        listModels: async () => {
          // 兼容旧端口：Bot 侧栏的模型徽标仍读这个。取第一个可用 provider 的模型表。
          const view = await services.modelSelectionService.getView();
          const first = view?.providers?.[0];
          return (first?.models ?? []).map((model) => ({
            ref: `${first?.providerId}/${model.modelId}`,
            label:
              (model.config as { label?: string; displayName?: string } | undefined)?.label ??
              model.modelId,
          }));
        },
        defaultModel: () => null,
      });
    // 注册必须发生在渲染期（见下方 effect 的注释）：早于子组件 effect 里的 team.start()。
    botStore.register(instance);
    return instance;
  }, [services, workspacePath, workspaceIdentity]);

  // 注册必须发生在渲染期，不能用 useEffect。
  // 为什么：React 的 effect 是**子先父后**，而 DS-Bot 的 <App> 在它自己的 useEffect
  // 里立刻 `team.start()` → 首个 `call('state')`。若在这里用 useEffect 注册，父层
  // effect 会排在子层之后，首个读取必然撞上「Agents 集群尚未就绪」。
  // useMemo 只在依赖变化时重跑，重复注册是幂等的，因此放在这里安全。
  useEffect(() => () => botStore.register(null), [store]);

  // 3) 深色主题：DS-Bot 的样式按 body[data-ds-dark-theme] 切换，
  //    Reactor 的深浅由 <html class="dark"> 表达，这里把两者对齐。
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => root.classList.contains("dark");
    const apply = () => {
      // DS-Bot 的样式按 body[data-ds-dark-theme] 切换；同时用 state 让容器拿到
      // color-scheme（滚动条、原生控件的深浅），两者必须同步。
      const dark = sync();
      document.body.toggleAttribute("data-ds-dark-theme", dark);
      setIsDark(dark);
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      document.body.removeAttribute("data-ds-dark-theme");
    };
  }, []);

  // 4) 渲染 DS-Bot 自己的整个界面（侧栏 + 聊天 + 覆盖层）。
  //    它的 App 组件内部自己管自己的尺寸，这里只给一个撑满的容器。
  return (
    <div className="bot-cluster" data-testid="agents-cluster" data-dark={isDark ? "" : undefined}>
      {/* 返回按钮：本视图下 Reactor 外层侧栏是收起的，用户需要一个不依赖侧栏的出口。
          放在左上角并让出 DS-Bot 自己的顶部按钮位，用 fixed 定位保证始终可点。 */}
      {onExit ? (
        <button
          type="button"
          onClick={onExit}
          title="返回对话"
          aria-label="返回对话"
          data-testid="agents-cluster-exit"
          className="absolute left-2 top-2 z-50 flex size-8 items-center justify-center rounded-full bg-black/25 text-white backdrop-blur-sm transition hover:bg-black/40"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M15 18l-6-6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
      <DsBotApp />
    </div>
  );
}

/** 供错误边界使用：把渲染崩溃记到 Reactor 日志里，而不是只进控制台。 */
export function reportBotClusterError(error: unknown): void {
  logger.error("[AgentsCluster] 渲染失败", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

/**
 * Reactor 的会话消息 → DS-Bot 的 chat item 形状。
 *
 * 上游的 item 是 `{ kind: 'user' | 'bot' | 'tool', text, time, ... }`（见
 * vendor/ds-bot-client/cells.js 的 Bubbles）。这里只映射两种主角色：
 * user / assistant；工具调用、推理等上游用别的 kind，Reactor 的消息里它们也是
 * 独立 part，首版先按文本投影，避免视图拿到不认识的 kind 白屏。
 */
function toDsBotChatItems(messages: unknown[]) {
  const items = [];
  for (const message of messages ?? []) {
    const role = (message as any)?.role ?? (message as any)?.info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(message as any);
    if (!text) continue;
    items.push({
      kind: role === "user" ? "user" : "bot",
      text,
      time: Number((message as any)?.createdAt ?? (message as any)?.info?.time?.created ?? Date.now()),
      ...((message as any)?.id ? { id: String((message as any).id) } : {}),
    });
  }
  return items;
}

/** 从消息里取纯文本：兼容 {text} / {content: [{type:'text',text}]} 两种常见形状。 */
function extractText(message: any) {
  const parts = (message as any)?.parts ?? (message as any)?.content;
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  const texts = [];
  for (const part of parts) {
    if (typeof part === "string") texts.push(part);
    else if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
    else if (typeof part?.text === "string") texts.push(part.text);
  }
  return texts.join("\n");
}
