import type { IPlatformService } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { FeedbackSubmitDraft } from "@/feedback/feedbackStore.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { resolveProductDocsUrl } from "@/lib/productDocs.js";
import { toast } from "@/components/ui/toast.js";

interface HelpMenuActionHandlers {
  openIssueReport: () => Promise<void>;
  openProductDocs: () => void;
  exportLogs: () => void;
}

export function createHelpMenuActionHandlers({
  platform,
  intl,
  openSubmit,
  productDocsUrl,
}: {
  platform: Pick<IPlatformService, "captureWindowScreenshot" | "exportLogs" | "openExternal">;
  intl: IntlInstance;
  openSubmit: (draft?: FeedbackSubmitDraft) => void;
  /** 服务端下发的产品文档地址；null = 未配置（提示而不跳转）。 */
  productDocsUrl: string | null;
}): HelpMenuActionHandlers {
  return {
    openIssueReport: async () => {
      openSubmit({
        type: "bug",
        module: "其它",
        severity: "P2-中",
        includeLogs: false,
        screenshots: [],
      });
    },
    openProductDocs: () => {
      // 地址唯一来源是服务端策略；没有配置就明说，不再兜底跳官方站。
      const url = resolveProductDocsUrl(productDocsUrl);
      if (!url) {
        toast(intl.formatMessage({ id: "help.productDocs.notConfigured" }));
        return;
      }
      platform.openExternal(url);
    },
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}
