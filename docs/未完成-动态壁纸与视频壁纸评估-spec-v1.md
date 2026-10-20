# 未完成：动态壁纸（已做）与视频壁纸（待评估）（spec v1）

## 背景

UI 设计吸收文档里 j 项「视频/动态壁纸」列为 C 档，注明「需单独评估功耗」。
本轮拆成两半：**动态壁纸（CSS 动效）已实现**；**视频壁纸（视频解码）留待评估**。

## 已落地：动态壁纸（Ken Burns）

- `backgroundTheme.ts` 新增 `motion: boolean`（默认 false，主动选择）。
- 落到文档根属性 `data-app-background-motion`（背景未启用或 motion 关时为 false）。
- CSS：`[data-app-background][data-app-background-motion] ::before` 叠加 64s
  `ease-in-out infinite alternate` 的缓慢缩放（1.06 → 1.12，轻微位移）。
- **只用 transform**（合成层，不触发重排/重绘），待机功耗可忽略。
- 尊重 `prefers-reduced-motion: reduce`（命中时 `animation: none`）。
- 设置页「背景主题」区新增「动态壁纸」开关（`data-testid=background-motion-switch`）。

### 为什么不做视频壁纸
- 视频解码在「内网常驻」场景有持续功耗与解码器占用，收益（视觉）与成本不匹配 Reactor 定位。
- Reactor 现有背景哲学是「渐变合成、零位图素材」；动态壁纸的 CSS 动效延续这一哲学，
  视频壁纸会引入大体积素材与解码依赖，方向相悖。
- 若将来确要做，需单独评估：解码开销、暂停策略（失焦/无操作时停）、素材托管与体积。

## 验收

- `pnpm typecheck` 通过；`oxlint` 改动文件 0 error。
- 动效为纯 CSS，确定性高；视觉需运行时观察（含 reduce-motion 分支）。

## 边界与遗留

- **视频壁纸未做**：需先做功耗/解码评估与产品决策。
- 动态壁纸目前只有一档强度（常量写在 CSS），未做强度滑块；若需要再加参数。
