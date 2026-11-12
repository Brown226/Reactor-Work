# Web 客户端 Chrome 109 兼容基线

## 背景

公司内仍有大量 Win7 电脑，后续推广需要 Web 入口可用。Win7 可用的最高浏览器内核是 Chromium 109
（Chrome/Edge 109 是最后支持 Win7 的版本）。实测当前 Web 产物在 Chromium 109.0.5414.46 下有两类失败：

1. **JS 运行期崩溃**：`Array.prototype.toSorted`（Chrome 110+）在渲染主界面时抛 `TypeError`，
   错误边界接管整个工作区，界面显示「这块界面出了点问题」。
2. **样式掉色**：`oklch()` / `color-mix()`（Chrome 111+）不被解析，登录页标题与字段标签几乎不可见。

排查结论：产物里超出 Chrome 109 的 JS API 只有 `toSorted`（12 处调用）；其余 `findLast`(97)、
`structuredClone`(98)、`replaceAll`(85)、`randomUUID`(92) 均在支持范围内。

## 目标与不变量

- 目标：`packages/web` 生产产物在 Chromium 109 上功能可用，视觉与桌面端一致。
- **不变量 1**：桌面端产物不受任何影响。Electron 41 = Chromium 142，原生支持上述特性，不回退。
- **不变量 2**：共享层 `packages/ui`、`packages/shared` 不出现兼容性改写。兼容只允许出现在
  web 构建配置与 web 入口；不得把组件里的 `toSorted` 改写为 `[...].sort()`，不得改共享样式里的
  `color-mix` 原始声明。
- **不变量 3**：现代浏览器访问 Web 端仍获得增强色域，不因兼容 Win7 而降级。
  lightningcss 的输出是「静态回退 + `@supports` 增强」双档，不是替换。

## 方案（三处改动，全部位于 packages/web）

| # | 文件 | 作用 |
| --- | --- | --- |
| 1 | `packages/web/vite.config.ts` | 以 `chrome109` 为目标处理最终 CSS，产出回退 + 增强双档 |
| 2 | `packages/web/src/polyfills.ts`（新增） | 特性检测补 `Array.prototype.toSorted`，由入口首个 import 引入 |
| 3 | `packages/web/src/legacyChrome109.css`（新增） | `--color-usage-heatmap-0..4` 的 sRGB 静态回退，限定在 `@supports not (color: color-mix(...))` |

热力图变量是唯一 lightningcss 无法静态化的 `color-mix`：操作数含 `var()` 且值随四个主题作用域变化，
必须在浏览器侧按作用域取值。静态值由现代 Chromium 实测 `getComputedStyle` 得到，逐档等价。

## 所有者与边界

- CSS 构建目标的唯一所有者：`packages/web/vite.config.ts`。
- `toSorted` 垫片的唯一所有者：`packages/web/src/polyfills.ts`；只在 Web 入口引入，
  桌面端 renderer 入口不引用，产物不含该代码。
- 共享样式 `packages/ui/src/styles.css` 保持零改动。

## 失败语义

- 低于 Chromium 109 的浏览器不在承诺范围。
- 垫片存在时，支持原生实现的浏览器直接跳过，不改变原生语义与性能。
- 热力图回退仅在浏览器不支持 `color-mix()` 时生效；支持时完全走共享样式。
- 若未来共享层引入新的 Chrome 110+ API，Web 端会再次失效——由构建后产物扫描门禁拦截（待补）。

## 验收场景

1. Chromium 109.0.5414.46 打开 Web 产物：无 `pageerror`、无错误边界，登录页与主界面正常渲染。
2. 同一产物在现代 Chromium（142）打开：与改动前视觉一致。
3. 桌面端构建产物：CSS 仍保留 `oklch`/`color-mix`，产物中不含垫片代码。
4. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。

## 回退

移除上述三处改动即可恢复原产物；不影响桌面端与存量 web 发布。
