import { TID_V4_DRAFT_INTERFACE_MODE_TOGGLE } from "@zcode/shared";

import { SegmentedTabs } from "@/components/ui/segmented-tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { modeOptionIcons } from "@/onboarding/occupationOptions.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/**
 * 草稿首页（主面板）的界面模式快捷切换：编程 / 办公 / 审查。
 *
 * 只是 `store.interfaceMode` 的又一个入口：不保留本地副本，也不新增持久化路径，
 * 与首次引导、快捷键改的是同一份状态（见 docs/interface-mode.md）。
 * 图标与 onboarding 的模式选择同源，避免同一模式出现两套标识。
 */
export function DraftInterfaceModeToggle() {
  const { intl } = useZCodeIntl();
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const CodingIcon = modeOptionIcons.coding;
  const OfficeIcon = modeOptionIcons.office;
  const ReviewIcon = modeOptionIcons.review;

  return (
    <div data-testid={TID_V4_DRAFT_INTERFACE_MODE_TOGGLE}>
      <SegmentedTabs
        value={interfaceMode}
        size="lg"
        ariaLabel={intl.formatMessage({ id: "settings.interfaceMode" })}
        items={[
          {
            value: "coding",
            label: intl.formatMessage({ id: "settings.interfaceMode.coding" }),
            icon: <CodingIcon aria-hidden="true" />,
          },
          {
            value: "office",
            label: intl.formatMessage({ id: "settings.interfaceMode.office" }),
            icon: <OfficeIcon aria-hidden="true" />,
          },
          {
            value: "review",
            label: intl.formatMessage({ id: "settings.interfaceMode.review" }),
            icon: <ReviewIcon aria-hidden="true" />,
          },
        ]}
        onValueChange={setInterfaceMode}
      />
    </div>
  );
}
