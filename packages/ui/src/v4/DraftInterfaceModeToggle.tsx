import { TID_V4_DRAFT_INTERFACE_MODE_TOGGLE } from "@zcode/shared";

import { SegmentedTabs } from "@/components/ui/segmented-tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  DEFAULT_AVAILABLE_INTERFACE_MODES,
  resolveAvailableInterfaceMode,
} from "@/lib/interfaceMode.js";
import { modeOptionIcons } from "@/onboarding/occupationOptions.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/**
 * 草稿首页（主面板）的界面模式快捷切换：编程 / 办公 / 审查。
 *
 * 只是 `store.interfaceMode` 的又一个入口：不保留本地副本，也不新增持久化路径，
 * 与首次引导、快捷键改的是同一份状态（见 docs/已完成/已完成-interface-mode.md）。
 * 图标与 onboarding 的模式选择同源，避免同一模式出现两套标识。
 *
 * 编程档受服务端受众控制（见 docs/未完成-编程模式权限-方案-v1.md）：只渲染
 * `availableInterfaceModes` 内的档位。策略未就绪（弹窗期间）时按白名单关闭默认过滤，
 * 与 store 的兜底口径一致。
 */
export function DraftInterfaceModeToggle() {
  const { intl } = useZCodeIntl();
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const availableInterfaceModes = useZCodeStore((state) => state.availableInterfaceModes);
  const CodingIcon = modeOptionIcons.coding;
  const OfficeIcon = modeOptionIcons.office;
  const ReviewIcon = modeOptionIcons.review;

  const allowed = availableInterfaceModes ?? [...DEFAULT_AVAILABLE_INTERFACE_MODES];
  const items = [
    {
      value: "coding" as const,
      label: intl.formatMessage({ id: "settings.interfaceMode.coding" }),
      icon: <CodingIcon aria-hidden="true" />,
    },
    {
      value: "office" as const,
      label: intl.formatMessage({ id: "settings.interfaceMode.office" }),
      icon: <OfficeIcon aria-hidden="true" />,
    },
    {
      value: "review" as const,
      label: intl.formatMessage({ id: "settings.interfaceMode.review" }),
      icon: <ReviewIcon aria-hidden="true" />,
    },
  ].filter((item) => allowed.includes(item.value));

  return (
    <div data-testid={TID_V4_DRAFT_INTERFACE_MODE_TOGGLE}>
      <SegmentedTabs
        // value 必须落在 items 内：策略刚到达、兜底尚未反映到当前档的极短窗口内也不越界。
        value={resolveAvailableInterfaceMode(interfaceMode, allowed)}
        size="lg"
        ariaLabel={intl.formatMessage({ id: "settings.interfaceMode" })}
        items={items}
        onValueChange={setInterfaceMode}
      />
    </div>
  );
}
