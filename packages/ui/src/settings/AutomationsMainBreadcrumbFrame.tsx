import { useState, type ReactNode } from "react";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";

/**
 * 工作区 Automations 不经过 SettingsPage，编辑页的面包屑上报需要 Provider 接收，
 * 所以桌面顶栏只剩空拖拽区；这里让工作区入口复用设置页的同一套面包屑合同。
 */
export function AutomationsMainBreadcrumbFrame({
  ariaLabel,
  children,
  isDesktop,
  sectionLabel,
  showTopStrip = true,
}: {
  ariaLabel: string;
  children: ReactNode;
  isDesktop: boolean;
  sectionLabel: string;
  /**
   * 是否保留顶部 h-12 空带。Web 收起侧栏时传 false：
   * 浮层只剩「展开」按钮，主视图工具栏要整体上移最大化利用空间，
   * 这里改为给内容加左侧让位（pl-12）避免与悬浮按钮重叠。
   */
  showTopStrip?: boolean;
}) {
  const [items, setItems] = useState<readonly SettingsBreadcrumbItem[]>([]);

  return (
    <SettingsBreadcrumbProvider onItemsChange={setItems} sectionLabel={sectionLabel}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 这条 h-12 空带在桌面端是拖拽区 + 面包屑；Web 端也要保留——
            侧栏收起后，顶部浮层（收起/后退/前进按钮）会悬浮在主视图左上角，
            没有这条带的话「我的空间」等主视图的工具栏会被浮层压住（2026-11-01 实测）。 */}
        {showTopStrip ? (
          <div
            className="h-12 shrink-0 [app-region:drag]"
            data-testid="automations-main-drag-region"
          >
            {isDesktop ? <SettingsHeaderBreadcrumb ariaLabel={ariaLabel} items={items} /> : null}
          </div>
        ) : null}
        {/* 收起侧栏且不显示顶带时，左上角仍悬浮着「展开侧栏」按钮，内容让出这一列 */}
        <div className={showTopStrip ? "contents" : "flex min-h-0 flex-1 flex-col pl-10"}>
          {children}
        </div>
      </div>
    </SettingsBreadcrumbProvider>
  );
}
