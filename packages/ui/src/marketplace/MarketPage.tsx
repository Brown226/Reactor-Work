/* eslint-disable max-lines -- 专家·技能市场页集中维护双视图/双目录/筛选状态/动作回调与弹层接线，拆散会把同一状态的所有权散落多文件（同 SubagentsSection 先例）。 */
/**
 * 专家·技能市场页（M1，方案见 docs/专家技能市场-方案-v1.md）。
 *
 * 一个界面切换「专家 / 技能」两个视图：市场浏览（分类 chips + 搜索 + 排序 + 卡片网格
 * + 精选条）与「我的」管理（已安装清单 + 启用开关 + 卸载）。安装关系真相在服务端，
 * 动作经 P3 `IServerAgentSyncService` 与 P2 `IServerSkillSyncService`（写后 re-GET），
 * 本页不新建 store、不碰文件；未登录企业服务端时渲染登录引导而不是空列表。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ServerAgentDefinition, ServerSkillCatalogItem } from "@zcode/shared";
import type { CreateTaskRequest, MarketIntent } from "@/app-shell/types.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { buildSubagentMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import { useReactorServer } from "@/hooks/useReactorServer.js";
import { useServerAgentSync } from "@/hooks/useServerAgentSync.js";
import { useServerSkillMarket } from "@/hooks/useServerSkillMarket.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ExpertDetailDialog } from "@/marketplace/ExpertDetailDialog.js";
import { SkillDetailDialog } from "@/marketplace/SkillDetailDialog.js";
import { PluginsSection } from "@/settings/PluginsSection.js";
import { SubagentsSection } from "@/settings/SubagentsSection.js";
import { Bot, Sparkles } from "lucide-react";

export interface MarketPageProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** starters 预填新建会话（不自动发送）；宿主缺省时相关入口隐藏。 */
  onCreateTask?: (request?: CreateTaskRequest) => void;
  /** 打开插件市场主视图（技能面板内跳转用；由 Shell 提供）。 */
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  /** 命令面板等外部入口的视图意图；到达即切换到指定 tab/模式。 */
  marketIntent?: MarketIntent | null;
  /** 子智能体表单「管理模型」跳设置·模型分区（由 Shell 提供）。 */
  onOpenModelProviderSettings?: () => void;
}

type MarketView = "expert" | "skill";
type MarketMode = "market" | "mine";
type ExpertSort = "default" | "hot" | "new";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ExpertCard({
  agent,
  onOpen,
}: {
  agent: ServerAgentDefinition;
  onOpen: (name: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <button
      type="button"
      data-testid={`expert-card-${agent.name}`}
      onClick={() => onOpen(agent.name)}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-card-border bg-card p-4 text-left transition-colors hover:bg-card-selected"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-ui-base text-foreground-subtle ring-1 ring-border"
        >
          {agent.emoji || agent.title.slice(0, 1)}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-ui-base font-medium text-foreground">
            {agent.title}
          </span>
          {agent.author ? (
            <span className="block truncate text-ui-sm text-foreground-subtlest">
              {agent.author}
            </span>
          ) : null}
        </span>
        {agent.installed ? (
          <span className="ml-auto inline-flex min-w-0 shrink-0 items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
            {intl.formatMessage({ id: "marketplace.card.installed" })}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-2 text-ui-sm text-foreground-subtle">
        {agent.description || agent.persona?.slice(0, 120) || ""}
      </p>
      {agent.tags.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1">
          {agent.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="inline-flex min-h-5 items-center rounded-md bg-surface px-1.5 text-ui-xs text-foreground-subtle ring-1 ring-border"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
}

function SkillCard({
  item,
  onOpen,
}: {
  item: ServerSkillCatalogItem;
  onOpen: (name: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <button
      type="button"
      data-testid={`skill-card-${item.name}`}
      onClick={() => onOpen(item.name)}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-card-border bg-card p-4 text-left transition-colors hover:bg-card-selected"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-ui-base text-foreground-subtle ring-1 ring-border"
        >
          {item.icon || item.title.slice(0, 1)}
        </span>
        <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
          {item.title}
        </span>
        {item.installed ? (
          <span className="ml-auto inline-flex min-h-5 shrink-0 items-center rounded-md bg-surface px-1.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
            {intl.formatMessage({ id: "marketplace.card.installed" })}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-2 text-ui-sm text-foreground-subtle">{item.description || ""}</p>
    </button>
  );
}

function LoginGate({ titleId, bodyId }: { titleId: string; bodyId: string }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-2 rounded-xl border border-card-border bg-card p-8 text-center">
      <h3 className="text-ui-lg font-semibold text-foreground">
        {intl.formatMessage({ id: titleId })}
      </h3>
      <p className="max-w-md text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: bodyId })}
      </p>
    </div>
  );
}

export function MarketPage({
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  onOpenPluginStore,
  marketIntent,
  onOpenModelProviderSettings,
}: MarketPageProps) {
  const { intl } = useZCodeIntl();
  const reactor = useReactorServer();
  const experts = useServerAgentSync();
  const skillsMarket = useServerSkillMarket();

  const [view, setView] = useState<MarketView>("expert");
  const [mode, setMode] = useState<MarketMode>("market");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<ExpertSort>("default");
  const [expertCatalog, setExpertCatalog] = useState<readonly ServerAgentDefinition[]>([]);
  const [expertOpenName, setExpertOpenName] = useState<string | null>(null);
  const [skillOpenName, setSkillOpenName] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const statusLoaded = reactor.status !== null;
  const loggedIn = reactor.status?.loggedIn ?? false;

  // 外部入口（命令面板「技能管理」）带入的视图意图：到达即切换到指定 tab/模式。
  useEffect(() => {
    if (!marketIntent) return;
    setView(marketIntent.view);
    setMode(marketIntent.mode);
  }, [marketIntent]);

  // 专家目录：首帧读 host 内存投影（P3 getCatalog），result 到达后跟随最新。
  useEffect(() => {
    if (!experts.available) return;
    let active = true;
    void experts
      .getCatalog()
      .then((items) => {
        if (active) setExpertCatalog(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [experts]);

  useEffect(() => {
    if (experts.result) setExpertCatalog(experts.result.catalog);
  }, [experts.result]);

  // 登录态就绪后各拉一次目录（幂等；与设置页/启动钩子互补）。
  const expertSync = experts.sync;
  const skillLoad = skillsMarket.load;
  useEffect(() => {
    if (!statusLoaded || !loggedIn) return;
    let active = true;
    void (async () => {
      try {
        const next = await expertSync();
        if (active) setExpertCatalog(next.catalog);
      } catch {
        // 失败经 experts.error 横幅展示，不打断技能侧加载。
      }
      try {
        await skillLoad();
      } finally {
        if (active) setLoadedOnce(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [expertSync, loggedIn, skillLoad, statusLoaded]);

  // 「我的·技能」改为嵌入自设置页迁入的 PluginsSection（见下方 mine 分支），本地不再自持技能开关态。

  const runExpertAction = useCallback(
    async (operation: () => Promise<{ catalog: readonly ServerAgentDefinition[] }>) => {
      setActionError(null);
      try {
        const next = await operation();
        setExpertCatalog(next.catalog);
      } catch (cause) {
        setActionError(toMessage(cause));
      }
    },
    [],
  );

  const expertSelected =
    (expertOpenName ? expertCatalog.find((agent) => agent.name === expertOpenName) : null) ?? null;
  const skillSelected =
    (skillOpenName ? skillsMarket.catalog.find((item) => item.name === skillOpenName) : null) ??
    null;

  const handleExpertStarter = useCallback(
    (agent: ServerAgentDefinition, prompt: string) => {
      if (!onCreateTask) return;
      const mention: ComposerMentionPrefill = {
        id: `subagent:${agent.name}`,
        category: "subagents",
        label: agent.name,
        value: agent.name,
        markdown: buildSubagentMentionMarkdown(agent.name),
        ...(agent.title ? { description: agent.title } : {}),
      };
      onCreateTask({
        initialPrompt: `${mention.markdown} ${prompt.trim()}`.trim(),
        initialPromptMention: mention,
      });
    },
    [onCreateTask],
  );

  const expertCategories = useMemo(() => {
    const categories = [
      ...new Set(
        expertCatalog
          .map((agent) => agent.category)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    if (categories.length > 0) return ["all", ...categories];
    return ["all", ...new Set(expertCatalog.flatMap((agent) => agent.tags))];
  }, [expertCatalog]);

  const skillCategories = useMemo(
    () => [
      "all",
      ...new Set(
        skillsMarket.catalog
          .map((item) => item.category)
          .filter((value): value is string => Boolean(value)),
      ),
    ],
    [skillsMarket.catalog],
  );

  const categoryLabel = useCallback(
    (code: string): string => {
      switch (code) {
        case "all":
          return intl.formatMessage({ id: "marketplace.category.all" });
        case "office":
          return intl.formatMessage({ id: "marketplace.category.office" });
        case "dev":
          return intl.formatMessage({ id: "marketplace.category.dev" });
        case "data":
          return intl.formatMessage({ id: "marketplace.category.data" });
        case "content":
          return intl.formatMessage({ id: "marketplace.category.content" });
        case "other":
          return intl.formatMessage({ id: "marketplace.category.other" });
        default:
          return code;
      }
    },
    [intl],
  );

  const expertItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = expertCatalog.filter((agent) => {
      if (category !== "all" && agent.category !== category && !agent.tags.includes(category)) {
        return false;
      }
      if (!normalizedQuery) return true;
      return [
        agent.name,
        agent.title,
        agent.description ?? "",
        agent.tags.join(" "),
        agent.author ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
    if (sort === "hot") return [...filtered].sort((left, right) => right.hot - left.hot);
    if (sort === "new")
      return [...filtered].sort((left, right) =>
        (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""),
      );
    return filtered;
  }, [category, expertCatalog, query, sort]);

  const skillItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return skillsMarket.catalog.filter((item) => {
      if (category !== "all" && item.category !== category && !item.tags.includes(category)) {
        return false;
      }
      if (!normalizedQuery) return true;
      return [item.name, item.title, item.description ?? "", item.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [category, query, skillsMarket.catalog]);

  const expertInstalledCount = expertCatalog.filter((agent) => agent.installed).length;
  const skillInstalledCount = skillsMarket.catalog.filter((item) => item.installed).length;
  const categories = view === "expert" ? expertCategories : skillCategories;

  const noticeId = (() => {
    const expertResult = experts.result;
    const flag =
      skillsMarket.notice ??
      (expertResult
        ? expertResult.skippedNotLoggedIn
          ? "notLoggedIn"
          : expertResult.authExpired
            ? "authExpired"
            : expertResult.offline
              ? "offline"
              : null
        : null);
    if (flag === "offline") return "settings.subagents.serverSync.offline";
    if (flag === "authExpired") return "settings.subagents.serverSync.authExpired";
    if (flag === "notLoggedIn") return "settings.subagents.serverSync.notLoggedIn";
    return null;
  })();
  const bannerError = actionError ?? experts.error ?? skillsMarket.error;

  if (statusLoaded && !loggedIn) {
    return (
      <div data-testid="marketplace-root">
        <LoginGate titleId="marketplace.login.title" bodyId="marketplace.login.body" />
      </div>
    );
  }
  if (!experts.available && !skillsMarket.available) {
    return (
      <div data-testid="marketplace-root">
        <LoginGate titleId="marketplace.login.title" bodyId="marketplace.unavailable" />
      </div>
    );
  }

  const sortItems: Array<{ key: ExpertSort; label: string }> = [
    { key: "default", label: intl.formatMessage({ id: "marketplace.sort.default" }) },
    { key: "hot", label: intl.formatMessage({ id: "marketplace.sort.hot" }) },
    { key: "new", label: intl.formatMessage({ id: "marketplace.sort.new" }) },
  ];
  const mineLabel =
    mode === "mine"
      ? intl.formatMessage({ id: "marketplace.mine.back" })
      : view === "expert"
        ? `${intl.formatMessage({ id: "marketplace.mine.experts" })} ${expertInstalledCount}`
        : `${intl.formatMessage({ id: "marketplace.mine.skills" })} ${skillInstalledCount}`;

  return (
    <div data-testid="marketplace-root" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-8 items-center gap-1 rounded-lg bg-surface p-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "expert"}
            data-testid="marketplace-tab-expert"
            onClick={() => {
              setView("expert");
              setCategory("all");
            }}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-3 text-ui-base font-medium transition-colors",
              view === "expert"
                ? "bg-card text-foreground ring-1 ring-border"
                : "text-foreground-subtle hover:text-foreground",
            )}
          >
            <Bot className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "marketplace.tab.expert" })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "skill"}
            data-testid="marketplace-tab-skill"
            onClick={() => {
              setView("skill");
              setCategory("all");
            }}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-3 text-ui-base font-medium transition-colors",
              view === "skill"
                ? "bg-card text-foreground ring-1 ring-border"
                : "text-foreground-subtle hover:text-foreground",
            )}
          >
            <Sparkles className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "marketplace.tab.skill" })}
          </button>
        </div>

        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          {view === "expert" && mode === "market" ? (
            <div className="hidden items-center gap-1 sm:flex" role="group">
              {sortItems.map((item) => (
                <Button
                  key={item.key}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={sort === item.key}
                  className={cn("h-7 px-2", sort === item.key && "bg-selected")}
                  onClick={() => setSort(item.key)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="marketplace-mine-toggle"
            onClick={() => setMode((current) => (current === "market" ? "mine" : "market"))}
          >
            {mineLabel}
          </Button>
          {/* 迁入的技能/子智能体面板各自带搜索框；「我的」下隐藏市场搜索，避免双输入框。 */}
          {mode === "mine" ? null : (
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={intl.formatMessage({ id: "marketplace.search.placeholder" })}
              aria-label={intl.formatMessage({ id: "marketplace.search.placeholder" })}
              className="h-8 w-full sm:w-56"
            />
          )}
        </div>
      </div>

      {noticeId ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: noticeId })}
        </div>
      ) : null}
      {bannerError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {bannerError}
        </div>
      ) : null}

      {mode === "market" ? (
        <>
          <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-1 [scrollbar-gutter:stable]">
            {categories.map((code) => (
              <button
                key={code}
                type="button"
                aria-pressed={category === code}
                onClick={() => setCategory(code)}
                className={cn(
                  "h-7 shrink-0 rounded-lg px-3 text-ui-sm transition-colors",
                  category === code
                    ? "bg-selected font-medium text-foreground"
                    : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                )}
              >
                {categoryLabel(code)}
              </button>
            ))}
          </div>

          {view === "skill" &&
          skillsMarket.featured.length > 0 &&
          !query.trim() &&
          category === "all" ? (
            <section className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-ui-base font-medium text-foreground">
                <Sparkles className="size-4 text-foreground-subtle" aria-hidden="true" />
                {intl.formatMessage({ id: "marketplace.featured" })}
              </h4>
              <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">
                {skillsMarket.featured.map((item) => (
                  <button
                    key={`featured-${item.id}`}
                    type="button"
                    onClick={() => setSkillOpenName(item.name)}
                    className="flex w-40 shrink-0 flex-col gap-1 rounded-xl border border-card-border bg-card p-3 text-left transition-colors hover:bg-card-selected"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden="true" className="shrink-0">
                        {item.icon || item.title.slice(0, 1)}
                      </span>
                      <span className="truncate text-ui-sm font-medium text-foreground">
                        {item.title}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-ui-xs text-foreground-subtle">
                      {item.description || ""}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {statusLoaded && loggedIn && !loadedOnce ? (
            <p className="py-8 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "common.loading" })}
            </p>
          ) : (view === "expert" ? expertItems : skillItems).length === 0 ? (
            <p className="py-8 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "marketplace.empty" })}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {view === "expert"
                ? expertItems.map((agent) => (
                    <ExpertCard
                      key={agent.id}
                      agent={agent}
                      onOpen={(name) => setExpertOpenName(name)}
                    />
                  ))
                : skillItems.map((item) => (
                    <SkillCard
                      key={item.id}
                      item={item}
                      onOpen={(name) => setSkillOpenName(name)}
                    />
                  ))}
            </div>
          )}
        </>
      ) : view === "skill" ? (
        <div data-testid="marketplace-manage-skills" className="min-w-0">
          {/* 技能管理面板整体自设置页迁入（方案 §5.1 追加决策）：自带范围切换、搜索与详情弹窗。 */}
          <PluginsSection
            mode="skill"
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            onCreateTask={onCreateTask}
            onOpenPluginStore={onOpenPluginStore}
          />
        </div>
      ) : (
        <div data-testid="marketplace-manage-subagents" className="min-w-0">
          {/* 子智能体管理面板整体自设置页迁入（方案 §5.1 追加决策）：自带范围切换、搜索、新建与企业专家目录。 */}
          <SubagentsSection onManageModels={onOpenModelProviderSettings} />
        </div>
      )}

      <ExpertDetailDialog
        agent={expertSelected}
        busy={experts.busy}
        onClose={() => setExpertOpenName(null)}
        onInstall={(name) => void runExpertAction(() => experts.install(name))}
        onUninstall={(name) => void runExpertAction(() => experts.uninstall(name))}
        onToggleEnabled={(name, enabled) =>
          void runExpertAction(() => experts.setInstallEnabled(name, enabled))
        }
        onStarter={
          expertSelected?.installed && onCreateTask
            ? (prompt) => handleExpertStarter(expertSelected, prompt)
            : undefined
        }
      />
      <SkillDetailDialog
        item={skillSelected}
        busy={skillsMarket.busy}
        onClose={() => setSkillOpenName(null)}
        onInstall={(name) => void skillsMarket.install(name)}
        onUninstall={(name) => void skillsMarket.uninstall(name)}
        onFavorite={(name, favorited) => void skillsMarket.setFavorite(name, favorited)}
      />
    </div>
  );
}
