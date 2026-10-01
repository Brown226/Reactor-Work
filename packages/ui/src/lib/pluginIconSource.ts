import browserUseIconUrl from "@/assets/plugin-icons/browser-use.png";
import documentsIconUrl from "@/assets/plugin-icons/documents.png";
import imageSearchIconUrl from "@/assets/plugin-icons/image-search.png";
import obsidianIconUrl from "@/assets/plugin-icons/obsidian.png";
import pdfIconUrl from "@/assets/plugin-icons/pdf.png";
import pluginCreatorIconUrl from "@/assets/plugin-icons/plugin-creator.png";
import presentationsIconUrl from "@/assets/plugin-icons/presentations.png";
import skillCreatorIconUrl from "@/assets/plugin-icons/skill-creator.png";
import spreadsheetsIconUrl from "@/assets/plugin-icons/spreadsheets.png";
import superpowersIconUrl from "@/assets/plugin-icons/superpowers.png";
import zcodeGuideIconUrl from "@/assets/plugin-icons/zcode-guide.png";
import { isTrustedImageUrl } from "@/lib/trustedImageUrl.js";

const OFFICIAL_PLUGIN_ICON_BY_ID: Readonly<Record<string, string>> = {
  "browser-use@zcode-plugins-official": browserUseIconUrl,
  "documents@zcode-plugins-official": documentsIconUrl,
  "image-search@zcode-plugins-official": imageSearchIconUrl,
  "obsidian@zcode-plugins-official": obsidianIconUrl,
  "pdf@zcode-plugins-official": pdfIconUrl,
  "plugin-creator@zcode-plugins-official": pluginCreatorIconUrl,
  "presentations@zcode-plugins-official": presentationsIconUrl,
  "skill-creator@zcode-plugins-official": skillCreatorIconUrl,
  "spreadsheets@zcode-plugins-official": spreadsheetsIconUrl,
  "superpowers@zcode-plugins-official": superpowersIconUrl,
  "zcode-guide@zcode-plugins-official": zcodeGuideIconUrl,
  // file-tools / ocr-tools / dwg-tools 无自有图标：与 definitions 的 listing 一致复用 documents 图标
  // （三者的 listing.icon 都指向 documents/icon.png；内网 CDN 不可达时这里兜底）。
  "file-tools@zcode-plugins-official": documentsIconUrl,
  "ocr-tools@zcode-plugins-official": documentsIconUrl,
  "dwg-tools@zcode-plugins-official": documentsIconUrl,
};

const TRUSTED_BUNDLED_PLUGIN_ICONS = new Set(Object.values(OFFICIAL_PLUGIN_ICON_BY_ID));

/** 按完整身份解析客户端自有图标，避免商店、候选和消息各自维护不同例外。 */
export function resolvePluginIconSource(
  pluginId: string | undefined,
  icon?: string,
): string | undefined {
  if (pluginId) {
    const bundledIcon = OFFICIAL_PLUGIN_ICON_BY_ID[pluginId];
    if (bundledIcon) return bundledIcon;
  }
  return isTrustedImageUrl(icon) ? icon : undefined;
}

/** Session 投影已完成身份匹配；仅放行固定打包资源，不放宽任意本地 URL。 */
export function isTrustedPluginIconSource(icon: string | undefined): icon is string {
  return Boolean(icon && TRUSTED_BUNDLED_PLUGIN_ICONS.has(icon)) || isTrustedImageUrl(icon);
}
