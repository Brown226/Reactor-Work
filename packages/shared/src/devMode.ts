/**
 * 开发者模式的手势契约：版本号连点。
 *
 * 参与者有三个，必须共用同一组常量，否则「7 下 / 1.5s / 提示时长」会在各自代码里各写一份：
 *   - renderer 的设置页版本号入口（`packages/ui/src/lib/devMode.ts` 的 `useDevTap`）；
 *   - desktop main 的 About 窗口计数（`packages/desktop/src/main/aboutDevModeTap.ts`）；
 *   - About 窗口的结果提示隐藏时长（HTML 由 main 生成，常量随页面注入）。
 *
 * 语义与验收场景见 `docs/model-governance-and-dev-mode.md`。
 */

/** 解锁/反锁所需的连点次数（对齐安卓开发者选项）。 */
export const DEV_TAP_TARGET = 7;

/** 相邻两次点击的最大间隔；超过即重新计数——不设窗口的话，隔半天点一下也会累加。 */
export const DEV_TAP_WINDOW_MS = 1500;

/** 解锁/反锁的结果提示停留时长。 */
export const DEV_TAP_HINT_MS = 2600;
