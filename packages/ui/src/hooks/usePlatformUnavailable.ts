/**
 * usePlatformUnavailable —— 查询某能力在当前平台不可用的原因。
 *
 * 背景：Web 端有一批浏览器沙箱做不到、桌面端才有的能力（打开外部编辑器、CUA、
 * 内嵌浏览器等）。这些入口过去要么被整体隐藏，要么点了才收到失败提示；
 * 推广到文档人员后要求改为「置灰 + 悬停说明」，让用户在点击前就知道原因。
 *
 * 原因文案的唯一来源是 IPlatformService.unavailableReason（Web 实现返回统一文案，
 * 桌面端不实现该方法 → 默认全部可用），UI 层不做任何平台嗅探。
 */
import { PLATFORM_UNAVAILABLE_REASON, type PlatformFeatureId } from "@zcode/shared";
import { usePlatform } from "./usePlatform.js";

/**
 * 返回不可用原因；null = 可用。宿主未实现 unavailableReason 时按可用处理，
 * 保证旧宿主（以及桌面端）的行为完全不变。
 */
export function usePlatformUnavailable(feature: PlatformFeatureId): string | null {
  const platform = usePlatform();
  return platform.unavailableReason?.(feature) ?? null;
}

/** 宿主没给文案时的兜底；正常情况下 Web 宿主会返回 shared 里的同一句话。 */
export function platformUnavailableFallbackText(): string {
  return PLATFORM_UNAVAILABLE_REASON;
}
