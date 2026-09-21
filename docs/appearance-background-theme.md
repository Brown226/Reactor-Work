# 背景主题（外观页）

## 1. 产品规则

「背景主题」给**整个工作区窗口**铺一层背景（左侧栏与主区域共享同一层垫底），并可调两个参数：

| 参数 | 取值 | 默认 | 语义 |
| --- | --- | --- | --- |
| 预置 | `none` / `mist` / `sky` / `dusk` / `dune` / `basalt` | `none` | `none` 即关闭本特性 |
| 自定义图片 | 桌面端自选一张图片（`imagePath`） | 无 | 非空时优先于预置；与预置互斥 |
| 模糊 | 0–32px | 10px | 背景层的高斯模糊半径 |
| 覆盖色 | 40–100% | 60% | 用当前主题底色压在图上的比例；越高文字越清晰、背景越淡 |

边界（有意为之）：

- **侧栏与主区域都在背景之上**：两者各自用同一档半透明底板（`--app-background-scrim`）
  把背景透出来，因此侧栏不是一块纯色面板，而是"泡"在背景里的半透明面。
- **卡片与输入框保持不透明**（`bg-card`），正文对比度由它们兜底；设置页与弹窗本身不在
  半透明作用域内，它们未绘底色的区域会露出背景（与参考实现一致）。
- **覆盖色下限 40%**：背景是图片/渐变，无法逐像素校验正文对比度，用下限兜底；
  上限 100% 等价于"看不见背景"。
- **空状态水印在背景开启时隐藏**：`[data-v4-draft-logo]` 两套标记都不显示。
- **预置是"图"不是"淡色底"**：色彩饱和度按"图"的标准给足；底色占比一高就会被覆盖色冲成灰白。
- **不做自动配色**：本特性只改背景，不派生品牌色/主题色（颜色主题是独立议题）。

## 1.1 自定义图片（仅桌面端）

- **入口**：外观页背景卡片网格里的「上传图片」/「更换图片」卡片，卡片右上角 × 移除。
  仅当 `platform.canSelectFilePath === true` 时渲染（Web/mobile 不出现该入口）。
- **选文件**：`platform.selectFiles()`（Electron 原生对话框）→ 客户端按扩展名校验
  （PNG/JPG/JPEG/WebP/GIF/BMP/AVIF），不支持的格式就地提示，不写入状态。
- **读取**：`fileService.readMediaPreview({ path, maxBytes: 8 MB })` → `data:<mime>;base64,…`
  → 写进 `--app-background-image`。
  不走 `zcode-media://` 预览链路的原因：共享的媒体预览注册表只认音频/视频，把图片扩进去
  会同时改变 `codeViewer.inferMediaPreview` 的判定、影响文件预览分支；而 `readMediaPreview`
  本来就能按路径读任意文件，正好匹配"用户自选一张图"的体量。
- **持久化的是路径**，不是图片数据：`imagePath` 落 `localStorage`，每次启动由
  `useBackgroundImageSource`（挂在 `Root` 根节点）重新读一次，并回填到
  `backgroundImage.{status,url,error}` 这份**内存运行态**。
- **失败语义**：文件被移动/删除、超过 8 MB、格式不支持时，`backgroundImage.status = "error"`，
  背景回落为预置，外观页显示一行本地化提示；日志留有原因。不弹窗、不阻塞。
- **互斥规则**：点任一预置卡片 = 放弃自定义图片（`imagePath` 置空）；点「不使用背景」同理。

## 2. 单一事实源与状态所有者

| 关注点 | 位置 |
| --- | --- |
| 取值定义、预置渐变、归一化、CSS 变量 | `packages/ui/src/lib/backgroundTheme.ts` |
| store 切片（载入/落盘/应用/广播还原） | `packages/ui/src/store/backgroundThemeState.ts` |
| 渲染层 | `packages/ui/src/styles.css` 的「背景主题」段 + `WorkspaceShellLayout.tsx` 的 `data-app-background-layer` |
| 设置界面 | `packages/ui/src/settings/BackgroundThemeSection.tsx`（由 `settingsCodePreview.tsx` 的外观页引用） |

**唯一所有者**是 `backgroundTheme` 这一份 store 状态。持久化只有一条路径（切片内的
`resolveBackgroundThemeUpdate`：合并 → 归一化 → localStorage → 应用到文档根），
设置页与跨窗口广播都走它，不存在第二条写入通道。

主题/界面字号同族的约定保持一致：状态存 `localStorage`（键 `zcode-background-theme`），
并加入 store 的 `BROADCAST_FIELDS`，多窗口通过广播同步；收到广播时用
`normalizeBackgroundThemeBroadcast` 还原（缺字段保留当前值），落盘仍由 setter 统一完成。

## 3. 渲染契约

```
文档根 html
  ├─ data-app-background            ← 开关（applyBackgroundTheme 用 toggleAttribute 写）
  ├─ --app-background-image         ← 预置的 background-image 取值，关闭时为 none
  ├─ --app-background-blur / -scrim ← 两个参数
  └─ --app-background-base          ← 主题底色字面值（:root / .dark / .theme-zai-*，各一份）
```

- 背景画在**窗口根容器**（`DesktopWindowFrame` 的 `[data-desktop-window-frame]`）的 `::before` 上：
  整窗铺底，侧栏与主区域都在它上面。该容器自带不透明底色，所以背景开启时同时给它
  `position: relative; isolation: isolate`——否则 `::before` 的负 z-index 会落到那份底色
  之后，被整窗盖住（这个坑实测踩过）。
- 工作区外壳（`[data-workspace-shell]`）带 `data-app-background-surface`，把
  `--color-background` 覆盖成 `color-mix(--app-background-base <scrim>%, transparent)`；
  外壳内的 header、各 pane、侧栏底板继续用 `bg-background`/同一档 mix 画自己，因此
  **自动**获得同一层半透明，不需要逐组件改样式。侧栏原本不画底色，由
  `[data-workspace-sidebar-panel]` 规则补一层同档底板。
- 模糊只作用在 `::before` 上（`filter: blur()` + `transform: scale(1.06)` 盖住模糊边缘），
  不影响任何界面内容。
- `--app-background-base` 必须是字面值而非 `var(--color-background)`：后者在被覆盖的子树里
  会形成自引用。

## 4. 验收场景

1. 外观页出现「背景主题」区：`不使用背景` + 5 个预置卡片 + 模糊/覆盖色两个滑块。
2. 选任一预置：整个工作区（含左侧栏）透出背景，设置页/弹窗/卡片底色不变，正文可读。
3. 拖动模糊滑块：背景实时变柔和（`--app-background-blur` 跟随）；拖动覆盖色：背景实时变淡/变浓。
4. 选「不使用背景」：背景层消失，主区域回到纯色，界面无其它差异。
5. 重启应用：选择被记住（`zcode-background-theme`），背景按上次的预置与参数恢复。
6. 开两个窗口：在一个窗口切换背景，另一个窗口同步跟随。
7. 背景开启时，空状态水印（浅色内联 SVG 与深色 `Z.svg`）都不显示。
8. 桌面端点「上传图片」→ 选一张 PNG/JPG：整窗换成该图；重启后仍然生效（路径持久化 + 重新读盘）。
9. 把已选图片改名/删除后重启：背景回落为预置，外观页显示「图片读取失败…」提示；
   卡片仍显示「更换图片」，可重新选图；× 可清除自定义图片。
10. 选一张非图片（如 .txt）或超过 8 MB 的图片：分别提示格式不支持 / 读取失败，状态不被写入。
11. Web 端不出现「上传图片」卡片（`canSelectFilePath === false`）。

## 5. 未做（后续）

- **视频背景**：性能、动效规范（`DESIGN.md` 要求克制）与移动端都另有成本。
- **从背景图派生配色**：属「颜色主题」议题，本次明确不做。
- **预置换成真实照片**：需要可商用授权的图片素材；当前预置是跟随主题的渐变合成。