# 启动封面层 — spec v1

## 背景

来源：NewMax 1.1.20 的壁纸/主题机制中"冷启动把壁纸当封面，消除白窗"的设计。
Reactor 的 `packages/desktop/src/renderer/index.html` 启动壳存在一个白窗问题：

- `#root` 初始 `opacity: 0`，直到 React 就绪（`zcode-startup-ready`）才淡入；
- `#loading` 启动壳（logo）**没有设置任何底色**；
- 桌面主窗口是透明窗口（`backgroundColor: "#00000000"`，vibrancy/acrylic）。

因此从窗口创建到 React 首帧之间，暴露的是浏览器默认白底 —— 深色主题用户会看到
一次明显的白闪。

## 产品规则

1. 在 `<head>` 里加一段**极早**内联脚本，在 CSS 生效前解析主题偏好并把
   `dark` class + 封面底色写到 `<html>`/`<body>`，让启动壳从一开始就是主题色。
2. 主题解析与 `useTheme.ts` 保持同口径：
   - 读 `localStorage["zcode-theme"]`，取值 `light | dark | zai-light | zai-dark | system`；
   - `system` 或缺失 → 跟随 `prefers-color-scheme`；
   - `dark` / `zai-dark` → 深色。
3. 封面底色用与产品一致的近黑/近白中性格（不引第三方 token，内联脚本不能依赖打包后的 CSS 变量），
   深浅各一档，浅色 `#f6f6f7`、深色 `#1a1a1c`。
4. React 就绪后由既有 `zcode-startup-ready` 流程淡出启动壳，封面随 `#loading` 一起消失，
   **不新增常态 DOM**。
5. `prefers-color-scheme` 变化时不回溯（启动壳只在最初几百毫秒存在，无需响应运行期切换）。

## 状态所有者

- 唯一写入点：`index.html` `<head>` 内联脚本写 `<html data-startup-theme>` + `<body>` 的
  内联 `background-color`。
- React 侧不读该属性；它只服务于"首帧之前"这一段。React 首帧接管后，该属性无副作用。

## 验收场景

- [ ] 深色主题用户冷启动 → 无白闪，封面为近黑。
- [ ] 浅色主题用户冷启动 → 封面为近白。
- [ ] `system` 偏好 + 系统深色 → 封面近黑。
- [ ] 更新状态窗口（`windowKind=update-status`）→ 不显示启动壳（沿用既有逻辑）。
- [ ] React 就绪后封面淡出，不与应用界面重叠。

## 验证口径

样式/交互改动 → 全量 `pnpm typecheck` + `pnpm lint`；白闪消除属视觉行为，
以代码正确性 + 人工目视为准，如实注明。
