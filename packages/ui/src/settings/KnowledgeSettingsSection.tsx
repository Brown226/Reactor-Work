/**
 * 知识库设置面板（设置 → 知识库）。
 *
 * ## 为什么把这些设置放进设置面板而不是知识库页面
 *
 * 知识库页面的库级开关（摘要、向量）作用在**单库**上，改完立刻影响该库；
 * 而这里的四项是**全局默认值**，只在「新建库」或「问答」时被读取：
 *
 * | 设置 | 何时生效 |
 * | --- | --- |
 * | 默认向量模型 | 新建库时预选 |
 * | 对话模型 | 问答 / 摘要 |
 * | 新建库默认开摘要 | 新建库时的初值 |
 * | 主库来源（自建 / 内置） | 检索时优先查哪个 |
 *
 * 把「全局默认」和「单库开关」放在同一个面板里会让人分不清作用范围，
 * 所以分开放 —— 这也是本仓「设置 = 应用级、页面内 = 对象级」的一贯划分
 * （对照：浏览器设置 vs 单个标签页、模型设置 vs 单次对话选模型）。
 *
 * ## 数据来源
 *
 * 走 HTTP 网关 `/api/knowledge/owned/settings`（GET 读、PUT 写），
 * 与知识库页面同一套契约。sidecar 侧的实现在
 * `owned/settings.py`（从 EvoFlow 移植）。
 */
import { useCallback, useEffect, useState } from "react";
import { Database, LoaderCircle } from "lucide-react";

import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** 网关 base：与 kb-api.ts 同一套解析规则（Web 相对路径 / 桌面端注入地址）。 */
function resolveGatewayBase(): string {
  const injected = (
    globalThis as { __ZCODE_KNOWLEDGE_GATEWAY_URL__?: string }
  ).__ZCODE_KNOWLEDGE_GATEWAY_URL__;
  const origin = typeof injected === "string" ? injected.trim().replace(/\/+$/, "") : "";
  return `${origin}/api/knowledge/owned`;
}

interface KnowledgeSettings {
  primary?: string;
  defaultEmbeddingModel?: string;
  effectiveEmbeddingModel?: string;
  chatModel?: string;
  effectiveChatModel?: string;
  summaryDefaultEnabled?: boolean;
}

interface KnowledgeSettingsSectionProps {
  isDesktop?: boolean;
}

/**
 * 设置请求超时。
 *
 * [踩过的坑] 早期没设超时，而 sidecar 启动时会先播种内置用户指南（75 篇文档，
 * 解析 + 分块要几十秒）。这段时间里网关请求会被排住，设置面板就永远停在
 * 「正在读取知识库设置…」—— 用户看到的是「打不开」，其实是请求没返回。
 *
 * 12s 足够覆盖正常的一次查询（实测 < 100ms），又能在引擎忙时及时
 * 退到「不可用」提示，而不是无限转圈。
 */
const SETTINGS_REQUEST_TIMEOUT_MS = 12_000;

async function fetchSettingsJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTINGS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function KnowledgeSettingsSection({ isDesktop = false }: KnowledgeSettingsSectionProps) {
  // 本仓的 useZCodeIntl() 返回 { intl }，不是 intl 本身。
  const { intl } = useZCodeIntl();
  const [settings, setSettings] = useState<KnowledgeSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchSettingsJson<KnowledgeSettings>(
        `${resolveGatewayBase()}/settings`,
      );
      setSettings(data);
      setUnavailable(false);
    } catch (error) {
      // 网关不可用（sidecar 没起来 / 未配置模型服务）时不能假装读到空配置，
      // 否则用户会以为「设置都是默认值」而不是「读不到」。
      logger.warn("[knowledge-settings] 读取失败", error);
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (next: Partial<KnowledgeSettings>) => {
      setSaving(true);
      try {
        const data = await fetchSettingsJson<KnowledgeSettings>(
          `${resolveGatewayBase()}/settings`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(next),
          },
        );
        setSettings(data);
        // toast 是函数（toast(message, options)），没有 .success/.error 方法。
        toast(intl.formatMessage({ id: "settings.knowledge.saved" }), { variant: "success" });
      } catch (error) {
        logger.error("[knowledge-settings] 保存失败", error);
        // ToastVariant 没有 error 档，保存失败按 warning 呈现（失败不需要打断操作）。
        toast(intl.formatMessage({ id: "settings.knowledge.saveFailed" }), { variant: "warning" });
      } finally {
        setSaving(false);
      }
    },
    [intl],
  );

  const label = (id: string) => intl.formatMessage({ id });

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-ui-sm text-foreground-subtle">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        {label("settings.knowledge.loading")}
      </div>
    );
  }

  if (unavailable || !settings) {
    return (
      <SettingsGroupCard>
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              <Database className="size-4 text-foreground-subtlest" aria-hidden />
              {label("settings.knowledge.unavailable")}
            </span>
          }
          description={label("settings.knowledge.unavailableDescription")}
          control={<span className="text-ui-sm text-foreground-subtlest">—</span>}
        />
      </SettingsGroupCard>
    );
  }

  const embeddingModel = settings.effectiveEmbeddingModel || settings.defaultEmbeddingModel || "";
  const chatModel = settings.effectiveChatModel || settings.chatModel || "";

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          searchId="settings.knowledge.embeddingModel"
          label={label("settings.knowledge.embeddingModel")}
          description={label("settings.knowledge.embeddingModelDescription")}
          detail={
            embeddingModel ? (
              <code className="rounded bg-surface px-1.5 py-0.5 text-ui-xs">{embeddingModel}</code>
            ) : (
              <span className="text-ui-xs text-foreground-subtlest">
                {label("settings.knowledge.notConfigured")}
              </span>
            )
          }
          control={<span className="text-ui-sm text-foreground-subtle">—</span>}
        />

        <SettingsRow
          searchId="settings.knowledge.chatModel"
          label={label("settings.knowledge.chatModel")}
          description={label("settings.knowledge.chatModelDescription")}
          detail={
            chatModel ? (
              <code className="rounded bg-surface px-1.5 py-0.5 text-ui-xs">{chatModel}</code>
            ) : (
              <span className="text-ui-xs text-foreground-subtlest">
                {label("settings.knowledge.notConfigured")}
              </span>
            )
          }
          control={<span className="text-ui-sm text-foreground-subtle">—</span>}
        />

        <SettingsRow
          searchId="settings.knowledge.summaryDefault"
          label={label("settings.knowledge.summaryDefault")}
          description={label("settings.knowledge.summaryDefaultDescription")}
          control={
            <Switch
              aria-label={label("settings.knowledge.summaryDefault")}
              checked={Boolean(settings.summaryDefaultEnabled)}
              disabled={saving}
              onCheckedChange={(checked) => {
                void patch({ summaryDefaultEnabled: checked });
              }}
            />
          }
        />
      </SettingsGroupCard>

      {/* 桌面端额外提示：知识库在本地跑，数据目录位置对排查很重要。 */}
      {isDesktop ? (
        <p className="px-1 text-ui-sm text-foreground-subtlest">
          {label("settings.knowledge.desktopDataHint")}
        </p>
      ) : null}
    </div>
  );
}
