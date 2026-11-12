# 未完成：IPC 特权通道来源校验（spec v1）

## 背景

逆向 Namiwork 时发现其壳层对 IPC 做了「白名单双重校验 + preload fail-closed + 路径不跨界」。
对照 Reactor 现状：部分特权通道只做参数校验，未校验**事件来源**。

## 威胁模型

内嵌浏览器（`<webview>` guest、coding-plan 官网页）会加载远程 http/https 页面，
其中部分带 preload，可触达 `ipcRenderer` 暴露的平台通道。若通道直接接收 renderer
传入的任意本地路径并调用 `shell.openPath`，则**恶意或失陷的远程页面可诱导应用
打开任意本地文件 / 在文件管理器中定位任意路径**，构成越权面。

两个已确认的高危通道：

| 通道 | 位置 | 现状 |
| --- | --- | --- |
| `PlatformChannels.OpenExternalFile` | `desktopMainIpcRemote.ts` | 参数无校验，来源无校验 |
| `PlatformChannels.OpenInFileManager` | `desktopMainIpcPlatform.ts` | 路径规范化，来源无校验 |

## 产品规则

- 特权通道（打开本地文件 / 定位本地路径）**只接受来自应用自身渲染层的调用**。
- 应用渲染层 = 生产包的 `file://` 页面，或开发态 `ELECTRON_RENDERER_URL` 指向的 dev server origin。
- 其余来源（任意 http/https、其它 file:// 页面）一律拒绝，返回失败并记 warn 日志。

## 状态所有者

- 判定逻辑：`packages/desktop/src/main/desktopMainIpcHelpers.ts` 的纯函数
  `isTrustedAppRendererUrl(frameUrl)`——单一事实源，两个通道共用。
- 调用点各自持有自己的拒绝分支与日志。

## 接口

```ts
export function isTrustedAppRendererUrl(frameUrl: string | null | undefined): boolean;
```

- 入参：`event.senderFrame?.url`（可能为 undefined / null）。
- 返回：可信 = true。

## 验收场景

1. 生产包主 renderer（`file://.../renderer/index.html`）调用 → 放行。
2. 开发态 dev server 页面（`http://localhost:<port>/...`）调用 → 放行。
3. 远程 http/https 页面调用 → 拒绝，`{ success: false, error: "untrusted sender" }`，记 warn。
4. `senderFrame` 为空 / URL 不可解析 → 拒绝。

## 验证

- 受影响包链增量 `tsc -b` + 改动文件 `oxlint`。
- 主进程 `tsc -b packages/desktop/tsconfig.main.json` 确认新代码零错误。

## 边界与遗留

- 本次**只加固已确认的两个高危通道**，不迁移全仓 98 处 IPC（风险过高，需逐通道评估调用方）。
- 其余通道的来源校验列为后续审计项（见「后续任务清单-审计」）。
